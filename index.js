const MODULE_NAME = 'le_eternalism';

const defaultSettings = {
    enabled: false,
    suppressDefaultReply: true,
    debugMode: false,
    analysisPrompt1: [
        'You are an excellent analyst of roleplay scenes. Your task is to think things through and respond only with commands that match the tone and spirit of the scene. In your answer you write only commands and nothing else.',
        '',
        'Commands:',
        'If the scene is a battle scene, in your response, write in your answer: [include: Combat Rules]',
        'If the scene is a sexual scene, in your response, write in your answer: [include: Sexual Rules]',
    ].join('\n'),
    analysisPrompt2: [
        '<think>',
        '{1} Is it a combat scene?',
        '{2} Is it a sexual scene?',
        '{3} Verify what commands you should send.',
        '</think>',
    ].join('\n'),
    mainPrompt: [
        'You are the RPG engine writing the next reply of this roleplay.',
        'Continue the scene naturally from the last message, following the active prompt modules below.',
        'Stay in character, keep the story coherent, and move the scene forward.',
    ].join('\n'),
    postProcessPrompt: [
        'You are the formatting editor of the RPG engine.',
        'Rewrite the draft reply according to these rules: proper markdown, paragraph breaks, no code blocks, no meta commentary, no stage labels.',
        'Output ONLY the final formatted reply text.',
    ].join('\n'),
    stage1ContextTokens: 6000,
    library: [],
};

let isPipelineRunning = false;

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultSettings));
    }
    const settings = context.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = JSON.parse(JSON.stringify(defaultSettings[key]));
        }
    }
    if (!Array.isArray(settings.library)) {
        settings.library = [];
    }
    return settings;
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

function clean(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n');
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function log(message) {
    console.log(`[LE Eternalism] ${message}`);
    const logEl = document.getElementById('le_eternalism_log');
    if (logEl) {
        const line = `[${new Date().toLocaleTimeString()}] ${message}`;
        logEl.textContent = `${logEl.textContent}\n${line}`.trim();
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function parseAnalysisResult(text) {
    const includes = new Set();
    const excludes = new Set();
    const regex = /\[(include|exclude):\s*([^\]]+)\]/gi;
    let match;
    while ((match = regex.exec(text))) {
        const target = match[1].toLowerCase() === 'include' ? includes : excludes;
        for (const name of match[2].split(',')) {
            const cleaned = name.trim().toLowerCase();
            if (cleaned) {
                target.add(cleaned);
            }
        }
    }
    return { includes, excludes };
}

function selectIncludedPrompts(includes, excludes) {
    const settings = getSettings();
    const library = settings.library.filter(p => p.enabled && p.name && p.name.trim());
    if (includes.size === 0 && excludes.size === 0) {
        return library;
    }
    let selected = library;
    if (includes.size > 0 && !includes.has('all')) {
        selected = library.filter(p => includes.has(p.name.trim().toLowerCase()));
    }
    return selected.filter(p => !excludes.has(p.name.trim().toLowerCase()));
}

function buildStage2Prompt(settings, selected) {
    const parts = [clean(settings.mainPrompt)];
    if (selected.length > 0) {
        parts.push('[ACTIVE PROMPT MODULES]');
        for (const prompt of selected) {
            parts.push(`### ${clean(prompt.name)} ###\n${clean(prompt.prompt)}`);
        }
    }
    return parts.join('\n\n');
}

async function buildStage1History() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const budget = Number(settings.stage1ContextTokens) || 0;
    const messages = context.chat.filter(m => typeof m.mes === 'string' && m.mes.trim().length > 0);
    const toMessage = m => ({
        role: m.is_user ? 'user' : 'assistant',
        content: clean(`${m.name || (m.is_user ? context.name1 : context.name2)}: ${m.mes}`),
    });
    if (budget <= 0) {
        return messages.map(toMessage);
    }
    const chunks = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = toMessage(messages[i]);
        const tokens = await context.getTokenCountAsync(msg.content);
        if (chunks.length > 0 && used + tokens > budget) {
            break;
        }
        chunks.unshift(msg);
        used += tokens;
    }
    return chunks;
}

async function postAsCharacter(text) {
    const context = SillyTavern.getContext();
    const name = context.characters[context.characterId]?.name
        ?? [...context.chat].reverse().find(m => !m.is_user && m.name)?.name
        ?? 'Assistant';
    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: text,
        swipes: [text],
        swipe_info: {},
    };
    context.chat.push(message);
    context.addOneMessage(message);
    await context.saveChat();
    await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, context.chat.length - 1, 'rpg');
    await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, context.chat.length - 1, 'rpg');
}

async function runPipeline(reason) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (isPipelineRunning) {
        log('Pipeline already running, skipping.');
        return;
    }

    const s = settings;
    const stage1SystemPrompts = [];
    if (clean(s.analysisPrompt1).trim() || clean(s.analysisPrompt2).trim()) {
        if (clean(s.analysisPrompt1).trim()) {
            stage1SystemPrompts.push(clean(s.analysisPrompt1).trim());
        }
        if (clean(s.analysisPrompt2).trim()) {
            stage1SystemPrompts.push(clean(s.analysisPrompt2).trim());
        }
    } else if (clean(s.analysisPrompt).trim()) {
        stage1SystemPrompts.push(clean(s.analysisPrompt).trim());
    }

    if (stage1SystemPrompts.length === 0 || !s.mainPrompt.trim()) {
        toastr.warning('LE Eternalism: Stage 1 and Stage 2 prompts must not be empty.');
        log('Aborted: analysis or main prompt is empty.');
        return;
    }

    isPipelineRunning = true;
    let handle = context.loader.show({ message: 'Running RPG pipeline...' });
    log(`Pipeline started (${reason}).`);
    try {
        const historyMessages = await buildStage1History();
        const stage1Messages = stage1SystemPrompts.map(p => ({ role: 'system', content: p }));
        stage1Messages.push(...historyMessages);
        const analysis = await context.generateRaw({
            prompt: stage1Messages,
        });
        const { includes, excludes } = parseAnalysisResult(analysis);
        const selected = selectIncludedPrompts(includes, excludes);
        log(`Stage 1 done. Included modules: ${selected.length > 0 ? selected.map(p => p.name).join(', ') : '(none)'}`);

        if (settings.debugMode) {
            await handle.hide();
            const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
            const popup = new Popup(
                `<h3>Stage 1 — Analysis output</h3>`
                + `<pre class="le_eternalism_debug">${escapeHtml(analysis)}</pre>`
                + `<div class="le_eternalism_debug_summary">`
                + `Parsed directives — include: ${[...includes].join(', ') || '(none)'}; `
                + `exclude: ${[...excludes].join(', ') || '(none)'}. `
                + `Active modules for Stage 2: ${selected.length > 0 ? selected.map(p => p.name).join(', ') : '(none)'}`
                + `</div>`,
                POPUP_TYPE.TEXT,
                '',
                {
                    wide: true,
                    allowVerticalScrolling: true,
                    okButton: 'Continue to Stage 2',
                    cancelButton: 'Abort pipeline',
                },
            );
            const result = await popup.show();
            if (result !== POPUP_RESULT.AFFIRMATIVE) {
                log('Pipeline aborted by user at Stage 1 debug checkpoint.');
                return;
            }
            handle = context.loader.show({ message: 'Running RPG pipeline...' });
        }

        const stage2Prompt = buildStage2Prompt(settings, selected);
        const draft = await context.generateQuietPrompt({
            quietPrompt: stage2Prompt,
        });
        log('Stage 2 done. Draft generated.');

        let final = draft;
        if (clean(settings.postProcessPrompt).trim()) {
            final = await context.generateRaw({
                systemPrompt: clean(settings.postProcessPrompt),
                prompt: clean(draft),
            });
            log('Stage 3 done. Message formatted.');
        } else {
            log('Stage 3 skipped (post-process prompt is empty).');
        }

        await postAsCharacter(final);
        log('Reply posted to chat.');
    } finally {
        isPipelineRunning = false;
        await handle.hide();
    }
}

globalThis.leEternalismInterceptor = async function (chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled || !settings.suppressDefaultReply) {
        return;
    }
    if (type === 'quiet') {
        return;
    }
    if (type === 'impersonate') {
        return;
    }
    if (type !== 'normal' && type !== 'continue') {
        toastr.warning('LE Eternalism: swipe/regenerate are disabled while auto-run is on.');
        abort(true);
        return;
    }
    abort(true);
    if (isPipelineRunning) {
        log('Pipeline already running for the previous message.');
        return;
    }
    try {
        await runPipeline('auto');
    } catch (error) {
        toastr.error(`LE Eternalism pipeline failed: ${error.message}`);
        log(`Pipeline failed: ${error}`);
    }
};

function renderLibraryList() {
    const settings = getSettings();
    const container = document.getElementById('le_eternalism_library_list');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    settings.library.forEach((prompt, index) => {
        const item = document.createElement('div');
        item.classList.add('le_eternalism_lib_item');

        const header = document.createElement('div');
        header.classList.add('flex-container', 'alignItemsCenter', 'flexGap5');

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.classList.add('text_pole', 'flex1');
        nameInput.placeholder = 'Prompt name (used in [include: ...] / [exclude: ...])';
        nameInput.value = prompt.name;

        const enabledLabel = document.createElement('label');
        enabledLabel.classList.add('checkbox_label');
        const enabledInput = document.createElement('input');
        enabledInput.type = 'checkbox';
        enabledInput.checked = !!prompt.enabled;
        enabledLabel.append(enabledInput, document.createTextNode('On'));

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.classList.add('menu_button');
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', () => {
            settings.library.splice(index, 1);
            renderLibraryList();
            saveSettings();
        });

        const promptArea = document.createElement('textarea');
        promptArea.classList.add('text_pole');
        promptArea.rows = 3;
        promptArea.value = prompt.prompt;
        promptArea.placeholder = 'Prompt module text...';

        nameInput.addEventListener('input', () => {
            prompt.name = clean(nameInput.value);
            saveSettings();
        });
        enabledInput.addEventListener('change', () => {
            prompt.enabled = enabledInput.checked;
            saveSettings();
        });
        promptArea.addEventListener('input', () => {
            prompt.prompt = clean(promptArea.value);
            saveSettings();
        });

        header.append(nameInput, enabledLabel, removeButton);
        item.append(header, promptArea);
        container.appendChild(item);
    });
}

function updateStage1Preview() {
    const previewEl = document.getElementById('le_eternalism_stage1_preview');
    if (!previewEl) {
        return;
    }
    const p1 = document.getElementById('le_eternalism_analysis1').value.trim();
    const p2 = document.getElementById('le_eternalism_analysis2').value.trim();
    const parts = [];
    if (p1) {
        parts.push(`[System prompt 1]\n${p1}`);
    }
    if (p2) {
        parts.push(`[System prompt 2]\n${p2}`);
    }
    parts.push('[Chat history]\n...alternating messages: player = user role, AI = assistant role...');
    previewEl.textContent = parts.join('\n\n');
}

function loadSettingsIntoUi() {
    const settings = getSettings();
    document.getElementById('le_eternalism_enabled').checked = !!settings.enabled;
    document.getElementById('le_eternalism_suppress').checked = !!settings.suppressDefaultReply;
    document.getElementById('le_eternalism_debug').checked = !!settings.debugMode;
    document.getElementById('le_eternalism_analysis1').value = settings.analysisPrompt1 ?? '';
    document.getElementById('le_eternalism_analysis2').value = settings.analysisPrompt2 ?? '';
    document.getElementById('le_eternalism_main').value = settings.mainPrompt;
    document.getElementById('le_eternalism_post').value = settings.postProcessPrompt;
    document.getElementById('le_eternalism_stage1_tokens').value = settings.stage1ContextTokens;
    renderLibraryList();
    updateStage1Preview();
}

function collectSettingsFromUi() {
    const settings = getSettings();
    settings.enabled = document.getElementById('le_eternalism_enabled').checked;
    settings.suppressDefaultReply = document.getElementById('le_eternalism_suppress').checked;
    settings.debugMode = document.getElementById('le_eternalism_debug').checked;
    settings.analysisPrompt1 = clean(document.getElementById('le_eternalism_analysis1').value);
    settings.analysisPrompt2 = clean(document.getElementById('le_eternalism_analysis2').value);
    settings.mainPrompt = clean(document.getElementById('le_eternalism_main').value);
    settings.postProcessPrompt = clean(document.getElementById('le_eternalism_post').value);
    settings.stage1ContextTokens = Number(document.getElementById('le_eternalism_stage1_tokens').value) || 0;
    saveSettings();
}

async function initExtension() {
    const context = SillyTavern.getContext();
    try {
        const settingsHtml = await context.renderExtensionTemplateAsync('third-party/LE_ETERNALISM', 'settings');
        $('#extensions_settings2').append(settingsHtml);

        document.getElementById('le_eternalism_enabled').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_suppress').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_debug').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_analysis1').addEventListener('input', () => {
            collectSettingsFromUi();
            updateStage1Preview();
        });
        document.getElementById('le_eternalism_analysis2').addEventListener('input', () => {
            collectSettingsFromUi();
            updateStage1Preview();
        });
        document.getElementById('le_eternalism_main').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_post').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_stage1_tokens').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_add_prompt').addEventListener('click', () => {
            getSettings().library.push({ name: '', prompt: '', enabled: true });
            renderLibraryList();
            saveSettings();
        });
        document.getElementById('le_eternalism_run').addEventListener('click', () => {
            runPipeline('manual').catch(error => {
                toastr.error(`LE Eternalism pipeline failed: ${error.message}`);
                log(`Pipeline failed: ${error}`);
            });
        });

        loadSettingsIntoUi();
        log('Extension ready.');
    } catch (error) {
        console.error('[LE Eternalism] Failed to initialize UI:', error);
    }
}

if (SillyTavern.getContext().eventTypes) {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.APP_READY, initExtension);
}
