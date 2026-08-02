const MODULE_NAME = 'le_eternalism';

const defaultSettings = {
    enabled: false,
    debugMode: false,
    postProcessEnabled: false,
    showStage2Prompt: false,
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
    postProcessPrompt: [
        'You are the formatting editor of the RPG engine.',
        'Rewrite the draft reply according to these rules: proper markdown, paragraph breaks, no code blocks, no meta commentary, no stage labels.',
        'Output ONLY the final formatted reply text.',
    ].join('\n'),
    stage1ContextTokens: 6000,
    library: [],
};

let isPipelineRunning = false;
const activeModuleVariables = new Map();
const registeredMacros = new Set();
let lastStage2Prompt = '';

function ensureMacroRegistered(variable) {
    const macroName = `le_${variable}`;
    if (registeredMacros.has(macroName)) {
        return;
    }
    const handler = () => activeModuleVariables.get(variable) ?? '';
    const context = SillyTavern.getContext();
    try {
        context.macros.register(macroName, {
            description: `LE Eternalism: returns the "${variable}" prompt module content when that module is active, otherwise empty.`,
            handler,
        });
    } catch (error) {
        console.warn(`[LE Eternalism] Could not register macro ${macroName} (new engine):`, error);
    }
    try {
        context.registerMacro(macroName, handler);
    } catch (error) {
        console.warn(`[LE Eternalism] Could not register macro ${macroName} (legacy engine):`, error);
    }
    registeredMacros.add(macroName);
    const verified = !!context.macros?.registry?.hasMacro(macroName);
    log(`Registered macro {{${macroName}}} (registry verified: ${verified}).`);
}

function ensureAllMacrosRegistered() {
    for (const module of getSettings().library) {
        const variable = (module.variable ?? '').trim();
        if (variable) {
            ensureMacroRegistered(variable);
        }
    }
}

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
    const cleaned = String(text)
        .replace(/```[a-zA-Z]*\n?/gi, '')
        .replace(/```/g, '')
        .replace(/`/g, '');
    const regex = /\[(include|exclude):\s*([^\]]+)\]/gi;
    let match;
    while ((match = regex.exec(cleaned))) {
        const target = match[1].toLowerCase() === 'include' ? includes : excludes;
        for (const name of match[2].split(',')) {
            const cleanedName = name.trim().toLowerCase();
            if (cleanedName) {
                target.add(cleanedName);
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

function applyVariables(selected) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const selectedNames = new Set(selected.map(p => p.name.trim().toLowerCase()));
    for (const module of settings.library) {
        const variable = (module.variable ?? '').trim();
        if (!variable) {
            continue;
        }
        const isSelected = module.enabled && module.name && selectedNames.has(module.name.trim().toLowerCase());
        const value = isSelected ? module.prompt : '';
        activeModuleVariables.set(variable, value);
        ensureMacroRegistered(variable);
        try {
            context.variables.local.set(variable, value);
        } catch (error) {
            console.warn(`[LE Eternalism] Could not set variable ${variable}:`, error);
        }
        log(`Variable "${variable}" ${isSelected ? 'set to module content' : "cleared ('')."}`);
    }
}

async function runAnalysisAndApply(reason) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (isPipelineRunning) {
        log('Analysis already running, skipping.');
        return false;
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

    if (stage1SystemPrompts.length === 0) {
        toastr.warning('LE Eternalism: Stage 1 prompts must not be empty.');
        log('Aborted: analysis prompts are empty.');
        return false;
    }

    isPipelineRunning = true;
    let handle = context.loader.show({ message: 'Stage 1: analyzing scene...' });
    log(`Analysis started (${reason}).`);
    try {
        const historyMessages = await buildStage1History();
        const stage1Messages = stage1SystemPrompts.map(p => ({ role: 'system', content: p }));
        stage1Messages.push(...historyMessages);
        const analysis = await context.generateRaw({
            prompt: stage1Messages,
        });

        const { includes, excludes } = parseAnalysisResult(analysis);
        const selected = selectIncludedPrompts(includes, excludes);
        log(`Stage 1 output:\n${analysis}`);
        log(`Stage 1 parsed. Included modules: ${selected.length > 0 ? selected.map(p => p.name).join(', ') : '(none)'}`);

        if (settings.debugMode) {
            await handle.hide();
            const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
            const popup = new Popup(
                `<h3>Stage 1 — Analysis output</h3>`
                + `<pre class="le_eternalism_debug">${escapeHtml(analysis)}</pre>`
                + `<div class="le_eternalism_debug_summary">`
                + `Parsed directives — include: ${[...includes].join(', ') || '(none)'}; `
                + `exclude: ${[...excludes].join(', ') || '(none)'}. `
                + `Modules to activate: ${selected.length > 0 ? selected.map(p => p.name).join(', ') : '(none)'}`
                + `</div>`,
                POPUP_TYPE.TEXT,
                '',
                {
                    wide: true,
                    allowVerticalScrolling: true,
                    okButton: 'Apply variables and continue',
                    cancelButton: 'Abort',
                },
            );
            const result = await popup.show();
            if (result !== POPUP_RESULT.AFFIRMATIVE) {
                log('Aborted by user at Stage 1 debug checkpoint.');
                return false;
            }
            handle = context.loader.show({ message: 'Stage 1: analyzing scene...' });
        }

        applyVariables(selected);
        log('Variables applied. Generation continues.');
        return true;
    } finally {
        isPipelineRunning = false;
        await handle.hide();
    }
}

async function postProcessMessage(messageId, type) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (!settings.postProcessEnabled) {
        return;
    }
    if (type !== 'normal') {
        return;
    }
    if (!clean(settings.postProcessPrompt).trim()) {
        return;
    }

    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }
    if (typeof message.mes !== 'string' || !message.mes.trim()) {
        return;
    }

    try {
        log(`Post-processing message ${messageId}...`);
        const formatted = await context.generateRaw({
            systemPrompt: clean(settings.postProcessPrompt),
            prompt: clean(message.mes),
        });
        message.mes = formatted;
        const swipeId = message.swipe_id ?? 0;
        if (Array.isArray(message.swipes) && message.swipes[swipeId] !== undefined) {
            message.swipes[swipeId] = formatted;
        }
        await context.updateMessageBlock(messageId, message);
        await context.saveChat();
        log('Message formatted.');
    } catch (error) {
        toastr.error(`LE Eternalism post-process failed: ${error.message}`);
        log(`Post-process failed: ${error}`);
    }
}

function handleGenerationStart(type, options, dryRun) {
    if (dryRun || type !== 'normal') {
        return Promise.resolve();
    }
    if (!getSettings().enabled) {
        return Promise.resolve();
    }
    return runAnalysisAndApply('auto').catch(error => {
        toastr.error(`LE Eternalism analysis failed: ${error.message}`);
        log(`Analysis failed: ${error}`);
        return false;
    });
}

function applyPromptReplacements(content) {
    let result = content;
    for (const module of getSettings().library) {
        const variable = (module.variable ?? '').trim();
        if (!variable) {
            continue;
        }
        const macroName = `{{le_${variable}}}`;
        if (!result.includes(macroName)) {
            continue;
        }
        const escaped = macroName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
        const count = (result.match(regex) || []).length;
        result = result.replace(regex, activeModuleVariables.get(variable) ?? '');
        log(`Replaced ${macroName} in Stage 2 prompt (${count} occurrence(s)).`);
    }
    return result;
}

function handleCombinePrompts(eventData) {
    if (eventData?.dryRun) {
        return;
    }
    const prompt = eventData?.prompt;
    if (typeof prompt === 'string') {
        const replaced = applyPromptReplacements(prompt);
        eventData.prompt = replaced;
        lastStage2Prompt = replaced;
    } else if (Array.isArray(prompt)) {
        for (const m of prompt) {
            if (m && typeof m.content === 'string') {
                m.content = applyPromptReplacements(m.content);
            }
        }
        lastStage2Prompt = prompt.map(m => {
            const role = m?.role ?? 'message';
            const name = m?.name ? ` (${m.name})` : '';
            const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
            return `[${role}${name}]\n${content}`;
        }).join('\n\n');
    } else {
        lastStage2Prompt = String(prompt ?? '');
    }
    log(`Stage 2 prompt captured (${lastStage2Prompt.length} chars).`);
    if (getSettings().showStage2Prompt) {
        showStage2Prompt();
    }
}

async function showStage2Prompt() {
    const context = SillyTavern.getContext();
    if (!lastStage2Prompt) {
        toastr.info('LE Eternalism: no Stage 2 prompt captured yet.');
        return;
    }
    const { Popup, POPUP_TYPE } = context;
    const popup = new Popup(
        `<h3>Stage 2 prompt (combined, macros resolved)</h3>`
        + `<pre class="le_eternalism_debug le_eternalism_prompt">${escapeHtml(lastStage2Prompt)}</pre>`,
        POPUP_TYPE.TEXT,
        '',
        {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: 'Close',
        },
    );
    await popup.show();
}

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

        const variableInput = document.createElement('input');
        variableInput.type = 'text';
        variableInput.classList.add('text_pole');
        variableInput.placeholder = 'preset variable (e.g. violence)';
        variableInput.value = prompt.variable ?? '';
        variableInput.title = 'When this module is included, its text is written to this chat variable, so {{getvar::name}} in the preset resolves to it. Cleared when not included.';

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
        variableInput.addEventListener('input', () => {
            prompt.variable = clean(variableInput.value);
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

        header.append(nameInput, variableInput, enabledLabel, removeButton);
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
    document.getElementById('le_eternalism_debug').checked = !!settings.debugMode;
    document.getElementById('le_eternalism_post_enabled').checked = !!settings.postProcessEnabled;
    document.getElementById('le_eternalism_show_prompt').checked = !!settings.showStage2Prompt;
    document.getElementById('le_eternalism_analysis1').value = settings.analysisPrompt1 ?? '';
    document.getElementById('le_eternalism_analysis2').value = settings.analysisPrompt2 ?? '';
    document.getElementById('le_eternalism_post').value = settings.postProcessPrompt;
    document.getElementById('le_eternalism_stage1_tokens').value = settings.stage1ContextTokens;
    renderLibraryList();
    updateStage1Preview();
}

function collectSettingsFromUi() {
    const settings = getSettings();
    settings.enabled = document.getElementById('le_eternalism_enabled').checked;
    settings.debugMode = document.getElementById('le_eternalism_debug').checked;
    settings.postProcessEnabled = document.getElementById('le_eternalism_post_enabled').checked;
    settings.showStage2Prompt = document.getElementById('le_eternalism_show_prompt').checked;
    settings.analysisPrompt1 = clean(document.getElementById('le_eternalism_analysis1').value);
    settings.analysisPrompt2 = clean(document.getElementById('le_eternalism_analysis2').value);
    settings.postProcessPrompt = clean(document.getElementById('le_eternalism_post').value);
    settings.stage1ContextTokens = Number(document.getElementById('le_eternalism_stage1_tokens').value) || 0;
    saveSettings();
    ensureAllMacrosRegistered();
}

async function initExtension() {
    const context = SillyTavern.getContext();
    try {
        const settingsHtml = await context.renderExtensionTemplateAsync('third-party/LE_ETERNALISM', 'settings');
        $('#extensions_settings2').append(settingsHtml);

        document.getElementById('le_eternalism_enabled').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_debug').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_post_enabled').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_show_prompt').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_analysis1').addEventListener('input', () => {
            collectSettingsFromUi();
            updateStage1Preview();
        });
        document.getElementById('le_eternalism_analysis2').addEventListener('input', () => {
            collectSettingsFromUi();
            updateStage1Preview();
        });
        document.getElementById('le_eternalism_post').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_stage1_tokens').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_add_prompt').addEventListener('click', () => {
            getSettings().library.push({ name: '', variable: '', prompt: '', enabled: true });
            renderLibraryList();
            saveSettings();
        });
        document.getElementById('le_eternalism_run').addEventListener('click', () => {
            runAnalysisAndApply('manual').then(applied => {
                if (applied) {
                    toastr.info('LE Eternalism: variables applied.');
                }
            });
        });
        document.getElementById('le_eternalism_view_prompt').addEventListener('click', showStage2Prompt);

        context.eventSource.on(context.eventTypes.GENERATION_AFTER_COMMANDS, handleGenerationStart);
        context.eventSource.on(context.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, handleCombinePrompts);
        context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, postProcessMessage);

        loadSettingsIntoUi();
        ensureAllMacrosRegistered();
        log('Extension ready.');
    } catch (error) {
        console.error('[LE Eternalism] Failed to initialize UI:', error);
    }
}

if (SillyTavern.getContext().eventTypes) {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.APP_READY, initExtension);
}
