const MODULE_NAME = 'le_eternalism';

const defaultSettings = {
    enabled: false,
    debugMode: false,
    postProcessEnabled: true,
    masterEnabled: true,
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
    postProcessPrompt1: [
        'You are the formatting editor of the RPG engine.',
        'Rewrite the draft reply according to these rules: proper markdown, paragraph breaks, no code blocks, no meta commentary, no stage labels.',
        'Output ONLY the final formatted reply text.',
    ].join('\n'),
    postProcessPrompt2: [
        '<think>',
        '{1} Is the reply in character and from the correct POV?',
        '{2} Does it follow the formatting rules?',
        '{3} Verify the final output.',
        '</think>',
    ].join('\n'),
    stage1HistoryDepth: 50,
    stage1Api: { enabled: false, baseUrl: '', apiKey: '', model: '', maxTokens: 2000, temperature: 0.7 },
    stage3Api: { enabled: false, baseUrl: '', apiKey: '', model: '', maxTokens: 2000, temperature: 0.7 },
    library: [],
};

let isPipelineRunning = false;
const activeModuleVariables = new Map();
const registeredMacros = new Set();
let lastStage2Prompt = '';
let previewArmed = false;
let rawRequestInFlight = false;

async function rawGenerate(params) {
    rawRequestInFlight = true;
    try {
        return await SillyTavern.getContext().generateRaw(params);
    } finally {
        rawRequestInFlight = false;
    }
}

function isCustomApiConfigured(config) {
    return !!(config?.enabled
        && String(config.baseUrl ?? '').trim()
        && String(config.model ?? '').trim()
        && String(config.apiKey ?? '').trim());
}

async function customChatCompletion(config, messages, signal = null) {
    const context = SillyTavern.getContext();
    const { ChatCompletionService } = context;
    const baseUrl = String(config.baseUrl ?? '').trim().replace(/\/+$/, '');
    rawRequestInFlight = true;
    try {
        const payload = ChatCompletionService.createRequestData({
            stream: false,
            messages,
            model: String(config.model ?? '').trim(),
            chat_completion_source: 'openai',
            max_tokens: Number(config.maxTokens) || 2000,
            temperature: Number(config.temperature) || 0.7,
            reverse_proxy: baseUrl,
            proxy_password: String(config.apiKey ?? '').trim(),
        });
        const result = await ChatCompletionService.sendRequest(payload, true, signal);
        return result.content;
    } finally {
        rawRequestInFlight = false;
    }
}

function ensureMacroRegistered(variable) {
    const macroName = `le_${variable}`;
    if (registeredMacros.has(macroName)) {
        return;
    }
    const handler = () => {
        if (!getSettings().masterEnabled) {
            return '';
        }
        return activeModuleVariables.get(variable) ?? '';
    };
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
        const variable = normalizeVariable(module.variable);
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

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeVariable(value) {
    return String(value ?? '')
        .trim()
        .replace(/^\[\[|\]\]$/g, '')
        .replace(/^\{\{|\}\}$/g, '');
}

function sanitizeApiBlocks(settings) {
    const clone = JSON.parse(JSON.stringify(settings));
    for (const key of ['stage1Api', 'stage3Api']) {
        if (clone[key] && typeof clone[key] === 'object') {
            delete clone[key].apiKey;
            delete clone[key].baseUrl;
        }
    }
    return clone;
}

function exportSettings() {
    const data = sanitizeApiBlocks(getSettings());
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `le_eternalism_settings_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toastr.success('LE Eternalism: settings exported (API keys and base URLs excluded).');
    log('Settings exported.');
}

async function importSettings(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
        return;
    }
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Invalid settings file.');
        }
        const context = SillyTavern.getContext();
        const previous = context.extensionSettings[MODULE_NAME] || {};
        const preserved = {
            s1: { apiKey: previous.stage1Api?.apiKey ?? '', baseUrl: previous.stage1Api?.baseUrl ?? '' },
            s3: { apiKey: previous.stage3Api?.apiKey ?? '', baseUrl: previous.stage3Api?.baseUrl ?? '' },
        };
        const sanitized = sanitizeApiBlocks(data);
        context.extensionSettings[MODULE_NAME] = sanitized;
        for (const [key, value] of [['stage1Api', preserved.s1], ['stage3Api', preserved.s3]]) {
            if (context.extensionSettings[MODULE_NAME][key] && typeof context.extensionSettings[MODULE_NAME][key] === 'object') {
                context.extensionSettings[MODULE_NAME][key].apiKey = value.apiKey;
                context.extensionSettings[MODULE_NAME][key].baseUrl = value.baseUrl;
            }
        }
        saveSettings();
        loadSettingsIntoUi();
        ensureAllMacrosRegistered();
        toastr.success('LE Eternalism: settings imported (current API keys and base URLs kept).');
        log('Settings imported.');
    } catch (error) {
        toastr.error(`LE Eternalism import failed: ${error.message}`);
        log(`Import failed: ${error}`);
    }
}

function setStatus(text) {
    const el = document.getElementById('le_eternalism_status');
    if (el) {
        el.textContent = text;
    }
}

function log(message) {
    console.log(`[LE Eternalism] ${message}`);
    const logEl = document.getElementById('le_eternalism_log');
    if (logEl) {
        const line = `[${new Date().toLocaleTimeString()}] ${message}`;
        logEl.textContent = `${logEl.textContent}\n${line}`.trim();
        logEl.scrollTop = logEl.scrollHeight;
    }
    setStatus(message);
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
            const cleanedName = name
                .trim()
                .toLowerCase()
                .replace(/^["'`]+|["'`]+$/g, '')
                .replace(/[.,;:]+$/g, '');
            if (cleanedName) {
                target.add(cleanedName);
            }
        }
    }
    return { includes, excludes };
}

function selectIncludedPrompts(includes, excludes, analysisText) {
    const settings = getSettings();
    const lowerAnalysis = String(analysisText ?? '').toLowerCase();
    const library = settings.library.filter(p => p.enabled && p.name && p.name.trim());
    const nameOf = m => m.name.trim().toLowerCase();
    const excludedNames = new Set([...excludes].map(n => String(n).toLowerCase()));

    return library.filter(module => {
        const triggers = String(module.trigger ?? '')
            .split(/\r?\n/)
            .map(t => t.trim())
            .filter(Boolean);
        if (triggers.length > 0) {
            return triggers.some(t => lowerAnalysis.includes(t.toLowerCase()));
        }
        if (excludedNames.has(nameOf(module))) {
            return false;
        }
        if (includes.size === 0 || includes.has('all')) {
            return true;
        }
        return includes.has(nameOf(module));
    });
}

async function buildStage1History() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const depth = Number(settings.stage1HistoryDepth) || 0;
    const messages = context.chat.filter(m => typeof m.mes === 'string' && m.mes.trim().length > 0);
    const toMessage = m => ({
        role: m.is_user ? 'user' : 'assistant',
        content: clean(`${m.name || (m.is_user ? context.name1 : context.name2)}: ${m.mes}`),
    });
    if (depth <= 0) {
        return messages.map(toMessage);
    }
    const selected = messages.slice(-depth);
    log(`Stage 1 history: ${selected.length} message(s) (depth ${depth}).`);
    return selected.map(toMessage);
}

function applyVariables(selected) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const selectedNames = new Set(selected.map(p => p.name.trim().toLowerCase()));
    for (const module of settings.library) {
        const variable = normalizeVariable(module.variable);
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
    if (!settings.masterEnabled) {
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
    let stage1Cancelled = false;
    const abortController = new AbortController();
    let handle = context.loader.show({
        message: 'Stage 1: analyzing scene...',
        onStop: () => {
            stage1Cancelled = true;
            abortController.abort();
            try {
                context.stopGeneration();
            } catch (error) {
                console.warn('[LE Eternalism] Could not stop generation:', error);
            }
        },
    });
    log(`Analysis started (${reason}).`);
    try {
        const historyMessages = await buildStage1History();
        const stage1Messages = stage1SystemPrompts.map(p => ({ role: 'system', content: p }));
        stage1Messages.push(...historyMessages);
        stage1Messages.push({
            role: 'user',
            content: 'Analyze the scene above. Reply with your commands only.',
        });
        let analysis;
        try {
            analysis = isCustomApiConfigured(settings.stage1Api)
                ? await customChatCompletion(settings.stage1Api, stage1Messages, abortController.signal)
                : await rawGenerate({
                    prompt: stage1Messages,
                });
        } catch (error) {
            if (stage1Cancelled || abortController.signal.aborted) {
                toastr.info('LE Eternalism: Stage 1 cancelled.');
                log('Stage 1 cancelled by user.');
                return false;
            }
            throw error;
        }

        const { includes, excludes } = parseAnalysisResult(analysis);
        const selected = selectIncludedPrompts(includes, excludes, analysis);
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
                try {
                    context.stopGeneration();
                } catch (error) {
                    console.warn('[LE Eternalism] Could not stop generation:', error);
                }
                toastr.info('LE Eternalism: generation cancelled.');
                return false;
            }
            previewArmed = true;
            log('Stage 1 accepted — Stage 2 preview will be shown before sending.');
            handle = context.loader.show({ message: 'Stage 1: analyzing scene...' });
        }

        applyVariables(selected);
        log('Variables applied. Generation continues.');
        const activeList = [...activeModuleVariables.entries()].filter(([, v]) => v && v.trim()).map(([k]) => k);
        setStatus(`Analysis: included = ${selected.length ? selected.map(p => p.name).join(', ') : 'none'} | Variables active: ${activeList.join(', ') || 'none'}`);
        return true;
    } finally {
        isPipelineRunning = false;
        await handle.hide();
    }
}

async function postProcessMessage(messageId, type) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (!settings.postProcessEnabled || !settings.masterEnabled) {
        return;
    }

    const s = settings;
    const stage3SystemPrompts = [];
    if (clean(s.postProcessPrompt1).trim() || clean(s.postProcessPrompt2).trim()) {
        if (clean(s.postProcessPrompt1).trim()) {
            stage3SystemPrompts.push(clean(s.postProcessPrompt1).trim());
        }
        if (clean(s.postProcessPrompt2).trim()) {
            stage3SystemPrompts.push(clean(s.postProcessPrompt2).trim());
        }
    } else if (clean(s.postProcessPrompt).trim()) {
        stage3SystemPrompts.push(clean(s.postProcessPrompt).trim());
    }

    if (stage3SystemPrompts.length === 0) {
        return;
    }
    if (messageId !== context.chat.length - 1) {
        return;
    }

    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }
    if (typeof message.mes !== 'string' || !message.mes.trim()) {
        return;
    }

    let handle = null;
    let stage3Cancelled = false;
    const abortController = new AbortController();
    try {
        log(`Post-processing message ${messageId}...`);
        const originalText = clean(message.mes);
        const messages = stage3SystemPrompts.map(p => ({ role: 'system', content: p }));
        messages.push({ role: 'user', content: originalText });

        if (settings.debugMode) {
            const applied = await previewStage2Messages(messages, 'Stage 3 prompt preview');
            if (applied === null) {
                log('Stage 3 preview cancelled — keeping the original message.');
                return;
            }
            if (applied === false) {
                toastr.warning('LE Eternalism: edits not applied (message structure changed). Sending the original prompt.');
            } else {
                log('Stage 3 preview confirmed.');
            }
        }

        handle = context.loader.show({
            message: 'Stage 3: post-processing reply...',
            blocking: false,
            onStop: () => {
                stage3Cancelled = true;
                abortController.abort();
                try {
                    context.stopGeneration();
                } catch (error) {
                    console.warn('[LE Eternalism] Could not stop generation:', error);
                }
            },
        });

        let formatted;
        try {
            if (isCustomApiConfigured(settings.stage3Api)) {
                formatted = await customChatCompletion(settings.stage3Api, messages, abortController.signal);
            } else {
                formatted = await rawGenerate({
                    prompt: messages,
                });
            }
        } catch (error) {
            if (stage3Cancelled || abortController.signal.aborted) {
                toastr.info('LE Eternalism: Stage 3 cancelled — keeping the original message.');
                log('Stage 3 cancelled by user.');
                return;
            }
            throw error;
        }
        if (!message.extra) {
            message.extra = {};
        }
        message.extra.le_eternalism_original = originalText;
        message.extra.le_eternalism_processed = formatted;
        message.mes = formatted;
        const swipeId = message.swipe_id ?? 0;
        if (Array.isArray(message.swipes) && message.swipes[swipeId] !== undefined) {
            message.swipes[swipeId] = formatted;
        }
        await context.updateMessageBlock(messageId, message);
        await context.saveChat();
        handleCharacterMessageRendered(messageId);
        log('Message formatted.');
    } catch (error) {
        toastr.error(`LE Eternalism post-process failed: ${error.message}`);
        log(`Post-process failed: ${error}`);
    } finally {
        if (handle) {
            await handle.hide();
        }
    }
}

async function togglePostProcessingState(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    const original = message?.extra?.le_eternalism_original;
    const processed = message?.extra?.le_eternalism_processed;
    if (typeof original !== 'string' || typeof processed !== 'string') {
        return;
    }
    const showOriginal = message.mes === processed;
    message.mes = showOriginal ? original : processed;
    const swipeId = message.swipe_id ?? 0;
    if (Array.isArray(message.swipes) && message.swipes[swipeId] !== undefined) {
        message.swipes[swipeId] = message.mes;
    }
    await context.updateMessageBlock(messageId, message);
    await context.saveChat();
    log(showOriginal ? 'Post-processing reverted to original.' : 'Post-processing re-applied.');
}

let placeholderSwipeIndex = -1;

function handleGenerationStarted(type, params, dryRun) {
    if (dryRun || !getSettings().masterEnabled) {
        return;
    }
    if (type !== 'swipe' && type !== 'regenerate') {
        return;
    }
    const context = SillyTavern.getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || message.is_system || !Array.isArray(message.swipes)) {
        return;
    }
    placeholderSwipeIndex = message.swipes.length;
    message.swipes.push('');
    message.swipe_id = placeholderSwipeIndex;
    message.mes = '';
}

function cleanupPlaceholderSwipe() {
    if (placeholderSwipeIndex < 0) {
        return;
    }
    const context = SillyTavern.getContext();
    const message = context.chat[context.chat.length - 1];
    if (message && Array.isArray(message.swipes) && message.swipes[placeholderSwipeIndex] === '') {
        if (message.swipes.length > placeholderSwipeIndex + 1) {
            message.swipes.splice(placeholderSwipeIndex, 1);
            if (message.swipe_id > message.swipes.length - 1) {
                message.swipe_id = message.swipes.length - 1;
            }
            message.mes = message.swipes[message.swipe_id] ?? '';
        }
    }
    placeholderSwipeIndex = -1;
}

function handleCharacterMessageRendered(messageId) {
    if (!getSettings().masterEnabled) {
        return;
    }
    const context = SillyTavern.getContext();
    if (messageId !== context.chat.length - 1) {
        return;
    }
    const message = context.chat[messageId];
    if (!message?.extra?.le_eternalism_original || typeof message.extra.le_eternalism_processed !== 'string') {
        return;
    }
    const footer = document.querySelector(`.mes[mesid="${messageId}"] .mes_buttons`);
    if (!footer || footer.querySelector('.le_eternalism_revert_btn')) {
        return;
    }
    const button = document.createElement('div');
    button.classList.add('mes_button', 'le_eternalism_revert_btn');
    button.title = 'Go Back (revert post-processing)';
    button.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i>';
    button.addEventListener('click', () => togglePostProcessingState(messageId));
    footer.prepend(button);
}

function cleanupStaleRevertButtons() {
    const context = SillyTavern.getContext();
    const lastId = context.chat.length - 1;
    document.querySelectorAll('.mes[mesid] .le_eternalism_revert_btn').forEach(button => {
        const mesElement = button.closest('.mes');
        const mesId = Number(mesElement?.getAttribute('mesid'));
        if (Number.isFinite(mesId) && mesId !== lastId) {
            button.remove();
        }
    });
}

function handleGenerationStart(type, options, dryRun) {
    if (dryRun) {
        return Promise.resolve();
    }
    if (!['normal', 'continue', 'swipe', 'regenerate'].includes(type)) {
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
    if (!getSettings().masterEnabled) {
        return content;
    }
    let result = content;
    for (const module of getSettings().library) {
        const variable = normalizeVariable(module.variable);
        if (!variable) {
            continue;
        }
        const value = activeModuleVariables.get(variable) ?? '';
        for (const tag of [`[[le_${variable}]]`, `{{le_${variable}}}`]) {
            if (!result.includes(tag)) {
                continue;
            }
            const regex = new RegExp(escapeRegex(tag), 'gi');
            const count = (result.match(regex) || []).length;
            result = result.replace(regex, value);
            log(`Replaced ${tag} in Stage 2 prompt (${count} occurrence(s)).`);
        }
    }
    return result;
}

function serializeMessages(messages) {
    return messages.map((m, i) => {
        const role = m?.role ?? 'message';
        const name = m?.name ? ` (${m.name})` : '';
        const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
        return `[${role}:${i}${name}]\n${content}`;
    }).join('\n\n');
}

function deserializeMessages(text, messages) {
    const blocks = [];
    const regex = /^\[(system|user|assistant|tool):(\d+)(?: \(([^)]*)\))?\]\r?\n([\s\S]*?)(?=^\s*\[(?:system|user|assistant|tool):\d+[^\]]*\]|$)/gm;
    let match;
    while ((match = regex.exec(text))) {
        blocks.push({ index: Number(match[2]), content: match[4].replace(/\s+$/, '') });
    }
    if (blocks.length !== messages.length) {
        return false;
    }
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].index !== i || typeof messages[i].content !== 'string') {
            return false;
        }
    }
    for (let i = 0; i < blocks.length; i++) {
        messages[i].content = blocks[i].content;
    }
    return true;
}

async function previewStage2Messages(messages, title = 'Stage 2 prompt preview') {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    const initialText = serializeMessages(messages);
    const $content = $(`
        <div style="display:flex; flex-direction:column; gap:10px;">
            <div class="le_eternalism_hint">Review or modify the Stage 2 prompt before it is sent. Message boundaries are marked as [role:index]. Do not remove or reorder these markers.</div>
            <textarea class="text_pole le_eternalism_preview_edit">${escapeHtml(initialText)}</textarea>
        </div>
    `);
    let liveText = initialText;
    let dirty = false;
    $content.find('textarea').on('input', function () {
        liveText = $(this).val();
        dirty = true;
    });
    const popup = new Popup($content, POPUP_TYPE.CONFIRM, title, {
        okButton: 'Send prompt',
        cancelButton: 'Cancel generation',
        wide: true,
        large: true,
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }
    if (!dirty) {
        return true;
    }
    return deserializeMessages(liveText, messages);
}

async function handlePromptReady(eventData) {
    if (eventData?.dryRun) {
        return;
    }
    if (!getSettings().masterEnabled) {
        return;
    }
    const messages = eventData?.chat;
    if (!Array.isArray(messages)) {
        return;
    }
    const context = SillyTavern.getContext();
    const modules = getSettings().library.filter(m => normalizeVariable(m.variable));
    if (modules.length === 0) {
        return;
    }
    let replacements = 0;
    messages.forEach(msg => {
        if (!msg || typeof msg.content !== 'string') {
            return;
        }
        for (const module of modules) {
            const variable = normalizeVariable(module.variable);
            const lowerContent = msg.content.toLowerCase();
            let found = false;
            for (const tag of [`[[le_${variable}]]`, `{{le_${variable}}}`]) {
                if (!lowerContent.includes(tag.toLowerCase())) {
                    continue;
                }
                found = true;
                const value = activeModuleVariables.get(variable) ?? '';
                const processed = clean(typeof context.substituteParams === 'function' ? context.substituteParams(value) : value);
                if (processed.trim() === '') {
                    msg.content = msg.content.replace(new RegExp(`^[ \\t]*${escapeRegex(tag)}[ \\t]*\\r?\\n?`, 'gm'), '');
                    log(`Tag ${tag} removed — module inactive (no content).`);
                } else {
                    msg.content = msg.content.replace(new RegExp(escapeRegex(tag), 'g'), processed);
                    log(`Replaced ${tag} in prompt (${processed.length} chars).`);
                }
                replacements++;
            }
            if (!found && (activeModuleVariables.get(variable) ?? '').trim() !== '') {
                log(`WARNING: module "${module.name}" is ACTIVE but its tag [[le_${variable}]] was not found in the prompt. Add it to a preset prompt (e.g. Plaintext) so the content can be injected.`);
            }
        }
        msg.content = msg.content.replace(/(?:^[ \t]*\[\[le_[^\]]*\]\][ \t]*\r?\n?)|(?:\[\[le_[^\]]*\]\])/gm, '');
    });
    if (replacements > 0) {
        log(`Prompt injection done (${replacements} replacement(s)).`);
    }

    if (previewArmed && !rawRequestInFlight) {
        previewArmed = false;
        try {
            log(`Stage 2 request ready (${messages.length} messages).`);
            const applied = await previewStage2Messages(messages);
            if (applied === null) {
                try {
                    SillyTavern.getContext().stopGeneration();
                } catch (error) {
                    console.warn('[LE Eternalism] Could not stop generation:', error);
                }
                toastr.info('LE Eternalism: generation cancelled.');
                return;
            }
            if (applied === false) {
                toastr.warning('LE Eternalism: edits not applied (message structure changed). Sending the original prompt.');
            } else {
                log('Preview confirmed — sending prompt.');
            }
            lastStage2Prompt = serializeMessages(messages);
        } catch (error) {
            console.error('[LE Eternalism] Preview failed, sending the original prompt:', error);
            toastr.warning('LE Eternalism: preview failed — sending the original prompt.');
        }
    }
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
}

function renderLibrarySelector() {
    const settings = getSettings();
    const select = document.getElementById('le_eternalism_library_select');
    if (!select) {
        return;
    }
    select.innerHTML = '';
    settings.library.forEach((prompt, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = (prompt.name && prompt.name.trim()) ? prompt.name : `(unnamed ${index + 1})`;
        select.appendChild(option);
    });
    if (settings.library.length > 0) {
        select.selectedIndex = settings.library.length - 1;
    }
}

async function openLibraryEditor(index) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    if (index < 0 || index >= settings.library.length) {
        return;
    }
    const prompt = settings.library[index];
    const wasEmpty = !(prompt.name || '').trim() && !(prompt.prompt || '').trim();

    const $content = $(`
        <div style="display:flex; flex-direction:column; gap:8px;">
            <label class="le_eternalism_hint">Macro Editing</label>
            <input type="text" id="le_eternalism_lib_name" class="text_pole" placeholder="Prompt name">
            <div class="flex-container alignItemsCenter flexGap5">
                <input type="text" id="le_eternalism_lib_variable" class="text_pole flex1" placeholder="variable (e.g. violence)">
                <input type="text" id="le_eternalism_lib_trigger" class="text_pole flex1" placeholder="trigger (e.g. [include: Combat Rules])">
            </div>
            <label class="checkbox_label"><input type="checkbox" id="le_eternalism_lib_enabled"> <span>Enabled</span></label>
            <label class="le_eternalism_hint">Macro prompt</label>
            <textarea id="le_eternalism_lib_prompt" class="text_pole" style="width:100%; min-height:200px; font-family:monospace; resize:vertical;"></textarea>
        </div>
    `);
    const nameInput = $content.find('#le_eternalism_lib_name');
    const variableInput = $content.find('#le_eternalism_lib_variable');
    const triggerInput = $content.find('#le_eternalism_lib_trigger');
    const enabledInput = $content.find('#le_eternalism_lib_enabled');
    const promptArea = $content.find('#le_eternalism_lib_prompt');

    nameInput.val(prompt.name ?? '');
    variableInput.val(prompt.variable ?? '');
    triggerInput.val(prompt.trigger ?? '');
    enabledInput.prop('checked', !!prompt.enabled);
    promptArea.val(prompt.prompt ?? '');

    nameInput.on('input', () => {
        prompt.name = clean(nameInput.val());
        saveSettings();
    });
    variableInput.on('input', () => {
        prompt.variable = normalizeVariable(variableInput.val());
        variableInput.val(prompt.variable);
        saveSettings();
    });
    triggerInput.on('input', () => {
        prompt.trigger = clean(triggerInput.val());
        saveSettings();
    });
    enabledInput.on('change', () => {
        prompt.enabled = enabledInput.prop('checked');
        saveSettings();
    });
    promptArea.on('input', () => {
        prompt.prompt = clean(promptArea.val());
        saveSettings();
    });

    const popup = new Popup($content, POPUP_TYPE.TEXT, 'Edit prompt module', {
        okButton: 'Close',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        customButtons: [
            { text: 'Delete', icon: 'fa-solid fa-trash', result: POPUP_RESULT.CUSTOM1 },
        ],
    });
    const result = await popup.show();

    if (result === POPUP_RESULT.CUSTOM1) {
        settings.library.splice(index, 1);
        saveSettings();
        renderLibrarySelector();
        log('Prompt module deleted.');
        return;
    }

    const stillEmpty = !(prompt.name || '').trim() && !(prompt.prompt || '').trim();
    if (wasEmpty && stillEmpty) {
        settings.library.splice(index, 1);
        saveSettings();
        log('Empty prompt module removed (not named or edited).');
    }
    renderLibrarySelector();
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
    parts.push('[User: closing instruction]\nAnalyze the scene above. Reply with your commands only.');
    previewEl.textContent = parts.join('\n\n');
}

function loadApiBlock(prefix, config) {
    document.getElementById(`le_eternalism_${prefix}_custom`).checked = !!config.enabled;
    document.getElementById(`le_eternalism_${prefix}_url`).value = config.baseUrl ?? '';
    document.getElementById(`le_eternalism_${prefix}_key`).value = config.apiKey ?? '';
    document.getElementById(`le_eternalism_${prefix}_model`).value = config.model ?? '';
    document.getElementById(`le_eternalism_${prefix}_max`).value = config.maxTokens ?? 2000;
    document.getElementById(`le_eternalism_${prefix}_temp`).value = config.temperature ?? 0.7;
}

function collectApiBlock(prefix, config) {
    config.enabled = document.getElementById(`le_eternalism_${prefix}_custom`).checked;
    config.baseUrl = clean(document.getElementById(`le_eternalism_${prefix}_url`).value);
    config.apiKey = clean(document.getElementById(`le_eternalism_${prefix}_key`).value);
    config.model = clean(document.getElementById(`le_eternalism_${prefix}_model`).value);
    config.maxTokens = Number(document.getElementById(`le_eternalism_${prefix}_max`).value) || 2000;
    config.temperature = Number(document.getElementById(`le_eternalism_${prefix}_temp`).value) || 0.7;
}

function bindApiBlock(prefix) {
    for (const id of [`${prefix}_custom`, `${prefix}_url`, `${prefix}_key`, `${prefix}_model`, `${prefix}_max`, `${prefix}_temp`]) {
        document.getElementById(`le_eternalism_${id}`).addEventListener('input', collectSettingsFromUi);
    }
}

function loadSettingsIntoUi() {
    const settings = getSettings();
    document.getElementById('le_eternalism_master').checked = !!settings.masterEnabled;
    document.getElementById('le_eternalism_enabled').checked = !!settings.enabled;
    document.getElementById('le_eternalism_debug').checked = !!settings.debugMode;
    document.getElementById('le_eternalism_post_enabled').checked = !!settings.postProcessEnabled;
    document.getElementById('le_eternalism_analysis1').value = settings.analysisPrompt1 ?? '';
    document.getElementById('le_eternalism_analysis2').value = settings.analysisPrompt2 ?? '';
    document.getElementById('le_eternalism_post1').value = settings.postProcessPrompt1 ?? '';
    document.getElementById('le_eternalism_post2').value = settings.postProcessPrompt2 ?? '';
    document.getElementById('le_eternalism_stage1_tokens').value = settings.stage1HistoryDepth;
    loadApiBlock('s1', settings.stage1Api);
    loadApiBlock('s3', settings.stage3Api);
    renderLibrarySelector();
    updateStage1Preview();
}

function collectSettingsFromUi() {
    const settings = getSettings();
    settings.masterEnabled = document.getElementById('le_eternalism_master').checked;
    settings.enabled = document.getElementById('le_eternalism_enabled').checked;
    settings.debugMode = document.getElementById('le_eternalism_debug').checked;
    settings.postProcessEnabled = document.getElementById('le_eternalism_post_enabled').checked;
    settings.analysisPrompt1 = clean(document.getElementById('le_eternalism_analysis1').value);
    settings.analysisPrompt2 = clean(document.getElementById('le_eternalism_analysis2').value);
    settings.postProcessPrompt1 = clean(document.getElementById('le_eternalism_post1').value);
    settings.postProcessPrompt2 = clean(document.getElementById('le_eternalism_post2').value);
    settings.stage1HistoryDepth = Number(document.getElementById('le_eternalism_stage1_tokens').value) || 0;
    collectApiBlock('s1', settings.stage1Api);
    collectApiBlock('s3', settings.stage3Api);
    saveSettings();
    ensureAllMacrosRegistered();
}

async function initExtension() {
    const context = SillyTavern.getContext();
    try {
        const settingsHtml = await context.renderExtensionTemplateAsync('third-party/LE_ETERNALISM', 'settings');
        $('#extensions_settings2').append(settingsHtml);

        document.getElementById('le_eternalism_master').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_enabled').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_debug').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_post_enabled').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_analysis1').addEventListener('input', () => {
            collectSettingsFromUi();
            updateStage1Preview();
        });
        document.getElementById('le_eternalism_analysis2').addEventListener('input', () => {
            collectSettingsFromUi();
            updateStage1Preview();
        });
        document.getElementById('le_eternalism_post1').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_post2').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_stage1_tokens').addEventListener('input', collectSettingsFromUi);
        bindApiBlock('s1');
        bindApiBlock('s3');
        document.getElementById('le_eternalism_library_select').addEventListener('change', () => {
            const select = document.getElementById('le_eternalism_library_select');
            const index = Number(select.value);
            if (Number.isFinite(index) && index >= 0) {
                openLibraryEditor(index).catch(error => {
                    console.error('[LE Eternalism] Library editor error:', error);
                });
            }
        });
        document.getElementById('le_eternalism_lib_add').addEventListener('click', () => {
            const settings = getSettings();
            settings.library.push({ name: '', variable: '', trigger: '', prompt: '', enabled: true });
            saveSettings();
            renderLibrarySelector();
            const index = settings.library.length - 1;
            document.getElementById('le_eternalism_library_select').selectedIndex = index;
            openLibraryEditor(index).catch(error => {
                console.error('[LE Eternalism] Library editor error:', error);
            });
        });
        document.getElementById('le_eternalism_save').addEventListener('click', () => {
            collectSettingsFromUi();
            toastr.success('LE Eternalism: settings saved.');
        });
        document.getElementById('le_eternalism_export').addEventListener('click', exportSettings);
        document.getElementById('le_eternalism_import').addEventListener('click', () => {
            document.getElementById('le_eternalism_import_file').click();
        });
        document.getElementById('le_eternalism_import_file').addEventListener('change', importSettings);

        context.eventSource.on(context.eventTypes.GENERATION_AFTER_COMMANDS, handleGenerationStart);
        context.eventSource.on(context.eventTypes.GENERATION_STARTED, handleGenerationStarted);
        context.eventSource.on(context.eventTypes.GENERATION_STOPPED, cleanupPlaceholderSwipe);
        context.eventSource.on(context.eventTypes.GENERATION_ENDED, cleanupPlaceholderSwipe);
        context.eventSource.on(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, handlePromptReady);
        context.eventSource.on(context.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, handleCombinePrompts);
        context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, postProcessMessage);
        context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, cleanupStaleRevertButtons);

        loadSettingsIntoUi();
        ensureAllMacrosRegistered();
    } catch (error) {
        console.error('[LE Eternalism] Failed to initialize UI:', error);
    }
}

if (SillyTavern.getContext().eventTypes) {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.APP_READY, initExtension);
}
