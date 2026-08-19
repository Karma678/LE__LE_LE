const MODULE_NAME = 'le_eternalism';

let regexEnginePromise = null;

function getRegexEngine() {
    if (!regexEnginePromise) {
        regexEnginePromise = import('../../regex/engine.js').catch(() => null);
    }
    return regexEnginePromise;
}

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
    stage1Enabled: true,
    stage1Api: { enabled: false, baseUrl: '', apiKey: '', model: '', maxTokens: 2000, temperature: 0.7 },
    stage3Api: { enabled: false, baseUrl: '', apiKey: '', model: '', maxTokens: 2000, temperature: 0.7 },
    trackerApi: { enabled: false, baseUrl: '', apiKey: '', model: '', maxTokens: 2000, temperature: 0.7 },
    trackers: [],
    preTracker: { enabled: false, openTag: '', closeTag: '' },
    trackerMainPrompt: '',
    trackerThinkingPrompt: '',
    library: [],
};

let isPipelineRunning = false;
const activeModuleVariables = new Map();
const registeredMacros = new Set();
let lastStage2Prompt = '';
let previewArmed = false;
let rawRequestInFlight = false;

function extractReasoningFromData(data) {
    if (!data || typeof data !== 'object') {
        return '';
    }
    const choice = data?.choices?.[0];
    if (choice?.message) {
        return String(choice.message.reasoning_content ?? choice.message.reasoning ?? '');
    }
    if (Array.isArray(data?.content)) {
        return data.content
            .filter(part => part?.type === 'thinking')
            .map(part => String(part?.thinking ?? part?.text ?? ''))
            .join('\n\n');
    }
    return String(choice?.reasoning ?? '');
}

async function rawGenerate(params) {
    rawRequestInFlight = true;
    try {
        const context = SillyTavern.getContext();
        if (typeof context.generateRawData === 'function') {
            const data = await context.generateRawData({ prompt: params.prompt });
            const extract = typeof context.extractMessageFromData === 'function'
                ? context.extractMessageFromData(data, context.mainApi)
                : String(data?.choices?.[0]?.message?.content ?? data?.content ?? '');
            const content = clean(String(extract ?? ''));
            const reasoning = clean(extractReasoningFromData(data));
            if (!content) {
                throw new Error('No message generated');
            }
            return { content, reasoning };
        }
        const content = clean(await context.generateRaw(params));
        return { content, reasoning: '' };
    } finally {
        rawRequestInFlight = false;
    }
}

function isCustomApiEnabled(config) {
    return !!config?.enabled;
}

function validateCustomApiConfig(config, stageName) {
    const missing = [];
    if (!String(config.baseUrl ?? '').trim()) {
        missing.push('Base URL');
    }
    if (!String(config.apiKey ?? '').trim()) {
        missing.push('API key');
    }
    if (!String(config.model ?? '').trim()) {
        missing.push('Model');
    }
    if (missing.length > 0) {
        throw new Error(`${stageName}: custom API is enabled, but ${missing.join(', ')} is missing.`);
    }
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
        return {
            content: clean(String(result?.content ?? '')),
            reasoning: clean(String(result?.reasoning ?? '')),
        };
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
    if (!Array.isArray(settings.trackers)) {
        settings.trackers = [];
    }
    if (!settings.preTracker || typeof settings.preTracker !== 'object') {
        settings.preTracker = { enabled: false, openTag: '', closeTag: '' };
    }
    settings.enabled = true;
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
    for (const key of ['stage1Api', 'stage3Api', 'trackerApi']) {
        if (clone[key] && typeof clone[key] === 'object') {
            delete clone[key].apiKey;
            delete clone[key].baseUrl;
            delete clone[key].model;
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
    toastr.success('LE Eternalism: settings exported (API keys, base URLs and models excluded).');
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
            s1: { apiKey: previous.stage1Api?.apiKey ?? '', baseUrl: previous.stage1Api?.baseUrl ?? '', model: previous.stage1Api?.model ?? '' },
            s3: { apiKey: previous.stage3Api?.apiKey ?? '', baseUrl: previous.stage3Api?.baseUrl ?? '', model: previous.stage3Api?.model ?? '' },
            s4: { apiKey: previous.trackerApi?.apiKey ?? '', baseUrl: previous.trackerApi?.baseUrl ?? '', model: previous.trackerApi?.model ?? '' },
        };
        const sanitized = sanitizeApiBlocks(data);
        context.extensionSettings[MODULE_NAME] = sanitized;
        for (const [key, value] of [['stage1Api', preserved.s1], ['stage3Api', preserved.s3], ['trackerApi', preserved.s4]]) {
            if (context.extensionSettings[MODULE_NAME][key] && typeof context.extensionSettings[MODULE_NAME][key] === 'object') {
                context.extensionSettings[MODULE_NAME][key].apiKey = value.apiKey;
                context.extensionSettings[MODULE_NAME][key].baseUrl = value.baseUrl;
                context.extensionSettings[MODULE_NAME][key].model = value.model;
            }
        }
        saveSettings();
        loadSettingsIntoUi();
        ensureAllMacrosRegistered();
        toastr.success('LE Eternalism: settings imported (current API keys, base URLs and models kept).');
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

function splitTriggers(text) {
    const parts = [];
    let current = '';
    let depth = 0;
    const source = String(text ?? '');
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === '[') {
            depth++;
        } else if (ch === ']') {
            depth = Math.max(0, depth - 1);
        }
        if ((ch === ',' || ch === '\n' || ch === '\r') && depth === 0) {
            if (current.trim()) {
                parts.push(current.trim());
            }
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) {
        parts.push(current.trim());
    }
    return parts;
}

function selectIncludedPrompts(includes, excludes, analysisText) {
    const settings = getSettings();
    const lowerAnalysis = String(analysisText ?? '').toLowerCase();
    const library = settings.library.filter(p => p.enabled && p.name && p.name.trim());
    const nameOf = m => m.name.trim().toLowerCase();
    const excludedNames = new Set([...excludes].map(n => String(n).toLowerCase()));

    return library.filter(module => {
        const triggers = splitTriggers(module.trigger);
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

async function buildStage1History(genType) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const depth = Number(settings.stage1HistoryDepth) || 0;
    const engine = await getRegexEngine();
    let messages = context.chat.filter(m => typeof m.mes === 'string' && m.mes.trim().length > 0);
    if (genType === 'swipe' || genType === 'regenerate') {
        messages = messages.slice(0, -1);
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].is_user) {
            messages.splice(i, 1);
            break;
        }
    }
    const toMessage = (m, messageIndex, total) => {
        let mes = clean(m.mes);
        if (engine) {
            const placement = m.is_user ? engine.regex_placement.USER_INPUT : engine.regex_placement.AI_OUTPUT;
            mes = engine.getRegexedString(mes, placement, {
                isPrompt: true,
                depth: total - messageIndex - 1,
            });
        }
        return {
            role: m.is_user ? 'user' : 'assistant',
            content: clean(`${m.name || (m.is_user ? context.name1 : context.name2)}: ${mes}`),
        };
    };
    if (depth <= 0) {
        return messages.map((m, i) => toMessage(m, i, messages.length));
    }
    const selected = messages.slice(-depth);
    log(`Stage 1 history: ${selected.length} message(s) (depth ${depth}).`);
    return selected.map((m, i) => toMessage(m, i, selected.length));
}

function applyVariables(selected) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const selectedNames = new Set(selected.map(p => p.name.trim().toLowerCase()));
    const partsByVariable = new Map();
    for (const module of settings.library) {
        const variable = normalizeVariable(module.variable);
        if (!variable) {
            continue;
        }
        if (module.enabled && module.name && selectedNames.has(module.name.trim().toLowerCase())) {
            const parts = partsByVariable.get(variable) ?? [];
            parts.push(module.prompt);
            partsByVariable.set(variable, parts);
        }
    }
    const variables = new Set(settings.library.map(m => normalizeVariable(m.variable)).filter(Boolean));
    for (const variable of variables) {
        const parts = partsByVariable.get(variable);
        const value = parts && parts.length > 0 ? parts.join('\n\n') : '';
        activeModuleVariables.set(variable, value);
        ensureMacroRegistered(variable);
        try {
            context.variables.local.set(variable, value);
        } catch (error) {
            console.warn(`[LE Eternalism] Could not set variable ${variable}:`, error);
        }
        log(`Variable "${variable}" ${value ? `set to ${parts.length} module(s) content` : "cleared ('')."}`);
    }
}

function buildCharacterCard() {
    const context = SillyTavern.getContext();
    const char = context.characters?.[context.characterId];
    if (!char) {
        return '';
    }
    const parts = [];
    if (String(char.name ?? '').trim()) {
        parts.push(`Name: ${String(char.name).trim()}`);
    }
    if (String(char.description ?? '').trim()) {
        parts.push(`Description:\n${String(char.description).trim()}`);
    }
    if (String(char.personality ?? '').trim()) {
        parts.push(`Personality:\n${String(char.personality).trim()}`);
    }
    if (String(char.scenario ?? '').trim()) {
        parts.push(`Scenario:\n${String(char.scenario).trim()}`);
    }
    if (String(char.mes_example ?? '').trim()) {
        parts.push(`Example messages:\n${String(char.mes_example).trim()}`);
    }
    if (String(char.system_prompt ?? '').trim()) {
        parts.push(`System prompt:\n${String(char.system_prompt).trim()}`);
    }
    if (String(char.post_history_instructions ?? '').trim()) {
        parts.push(`Post-history instructions:\n${String(char.post_history_instructions).trim()}`);
    }
    if (String(char.creator_notes ?? '').trim()) {
        parts.push(`Creator notes:\n${String(char.creator_notes).trim()}`);
    }
    if (parts.length === 0) {
        return '';
    }
    return `<npc_card>\n${parts.join('\n\n')}\n</npc_card>`;
}

function buildPlayerCard() {
    const context = SillyTavern.getContext();
    const persona = String(context.powerUserSettings?.persona_description ?? '').trim();
    const name = String(context.name1 ?? '').trim();
    if (!persona && !name) {
        return '';
    }
    const parts = [];
    if (name) {
        parts.push(`Name: ${name}`);
    }
    if (persona) {
        parts.push(`Description:\n${persona}`);
    }
    return `<player_card>\n${parts.join('\n\n')}\n</player_card>`;
}

async function runAnalysisAndApply(reason, genType) {
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
        const historyMessages = await buildStage1History(genType);
        const stage1Messages = [];
        const npcCard = buildCharacterCard();
        const playerCard = buildPlayerCard();
        if (npcCard) {
            stage1Messages.push({ role: 'system', content: npcCard });
            log(`Stage 1: character card added (${npcCard.length} chars).`);
        } else {
            log('Stage 1: no character card available.');
        }
        if (playerCard) {
            stage1Messages.push({ role: 'system', content: playerCard });
            log(`Stage 1: player card added (${playerCard.length} chars).`);
        } else {
            log('Stage 1: no player card available.');
        }
        stage1Messages.push(...historyMessages);
        const engine = await getRegexEngine();
        const latestUserMessage = [...context.chat].reverse().find(m => m.is_user && typeof m.mes === 'string' && m.mes.trim().length > 0);
        if (latestUserMessage) {
            let latestText = clean(latestUserMessage.mes);
            if (engine) {
                latestText = engine.getRegexedString(latestText, engine.regex_placement.USER_INPUT, {
                    isPrompt: true,
                    depth: 0,
                });
            }
            stage1Messages.push({
                role: 'user',
                content: `<latest_context>\n${latestText}\n</latest_context>`,
            });
            log(`Stage 1: latest user message appended (${latestText.length} chars).`);
        } else {
            log('Stage 1: no latest user message found.');
        }
        for (const prompt of stage1SystemPrompts) {
            stage1Messages.push({ role: 'system', content: prompt });
        }

        if (settings.debugMode) {
            const applied = await previewStage2Messages(stage1Messages, 'Stage 1 prompt preview');
            if (applied === null) {
                log('Stage 1 preview cancelled.');
                try {
                    context.stopGeneration();
                } catch (stopError) {
                    console.warn('[LE Eternalism] Could not stop generation:', stopError);
                }
                toastr.info('LE Eternalism: generation cancelled.');
                return false;
            }
            if (applied === false) {
                toastr.warning('LE Eternalism: edits not applied (message structure changed). Sending the original Stage 1 prompt.');
                log('Stage 1 preview edits not applied — sending the original prompt.');
            } else {
                log('Stage 1 preview confirmed.');
            }
        }

        let analysis;
        let reasoning = '';
        let usingCustom = false;
        try {
            if (isCustomApiEnabled(settings.stage1Api)) {
                usingCustom = true;
                validateCustomApiConfig(settings.stage1Api, 'Stage 1');
                const result = await customChatCompletion(settings.stage1Api, stage1Messages, abortController.signal);
                analysis = result.content;
                reasoning = result.reasoning;
            } else {
                const result = await rawGenerate({
                    prompt: stage1Messages,
                });
                analysis = result.content;
                reasoning = result.reasoning;
            }
        } catch (error) {
            if (stage1Cancelled || abortController.signal.aborted) {
                toastr.info('LE Eternalism: Stage 1 cancelled.');
                log('Stage 1 cancelled by user.');
                return false;
            }
            if (usingCustom) {
                try {
                    context.stopGeneration();
                } catch (stopError) {
                    console.warn('[LE Eternalism] Could not stop generation:', stopError);
                }
                toastr.error(`LE Eternalism: Stage 1 custom API error — generation cancelled. ${error.message}`);
                log(`Stage 1 custom API failed, generation cancelled: ${error}`);
                return false;
            }
            throw error;
        }

        const { includes, excludes } = parseAnalysisResult(analysis);
        const selected = selectIncludedPrompts(includes, excludes, analysis);
        log(`Stage 1 output:\n${analysis}`);
        if (reasoning.trim()) {
            log(`Stage 1 reasoning:\n${reasoning}`);
        }
        log(`Stage 1 parsed. Included modules: ${selected.length > 0 ? selected.map(p => p.name).join(', ') : '(none)'}`);

        if (settings.debugMode) {
            await handle.hide();
            const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
            const reasoningBlock = reasoning.trim()
                ? `<details class="le_eternalism_reasoning_block">
                    <summary>Model reasoning (${reasoning.length} chars)</summary>
                    <pre class="le_eternalism_debug">${escapeHtml(reasoning)}</pre>
                   </details>`
                : '';
            const popup = new Popup(
                `<h3>Stage 1 — Analysis output</h3>`
                + reasoningBlock
                + `<div class="le_eternalism_hint">Output (directives only, no reasoning):</div>`
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

async function postProcessStage3(messageId, type) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (type === 'first_message') {
        log('Post-process skipped (first message/greeting).');
        return;
    }
    if (!settings.postProcessEnabled || !settings.masterEnabled) {
        log(`Post-process skipped (postProcessEnabled=${settings.postProcessEnabled}, masterEnabled=${settings.masterEnabled}).`);
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
        log('Post-process skipped (no Stage 3 prompts configured).');
        return;
    }
    if (messageId !== context.chat.length - 1) {
        log(`Post-process skipped (message ${messageId} is not the last one; last is ${context.chat.length - 1}).`);
        return;
    }

    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system) {
        log('Post-process skipped (message is missing, user or system).');
        return;
    }
    if (typeof message.mes !== 'string' || !message.mes.trim()) {
        log('Post-process skipped (message body is empty).');
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
            if (isCustomApiEnabled(settings.stage3Api)) {
                validateCustomApiConfig(settings.stage3Api, 'Stage 3');
                const result = await customChatCompletion(settings.stage3Api, messages, abortController.signal);
                formatted = result.content;
            } else {
                const result = await rawGenerate({
                    prompt: messages,
                });
                formatted = result.content;
            }
        } catch (error) {
            if (stage3Cancelled || abortController.signal.aborted) {
                toastr.info('LE Eternalism: Stage 3 cancelled — keeping the original message.');
                log('Stage 3 cancelled by user.');
                return;
            }
            if (isCustomApiEnabled(settings.stage3Api)) {
                toastr.error(`LE Eternalism: Stage 3 custom API error — original message kept. ${error.message}`);
                log(`Stage 3 custom API failed: ${error}`);
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
        if (Array.isArray(message.swipe_info) && message.swipe_info[swipeId]) {
            if (!message.swipe_info[swipeId].extra || typeof message.swipe_info[swipeId].extra !== 'object') {
                message.swipe_info[swipeId].extra = {};
            }
            message.swipe_info[swipeId].extra.le_eternalism_original = originalText;
            message.swipe_info[swipeId].extra.le_eternalism_processed = formatted;
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

async function postProcessMessage(messageId, type) {
    await postProcessStage3(messageId, type);
    try {
        await runTrackerStage(messageId);
    } catch (error) {
        toastr.error(`LE Eternalism tracker stage failed: ${error.message}`);
        log(`Tracker stage failed: ${error}`);
    }
}

function extractBetween(text, openTag, closeTag) {
    const source = String(text ?? '');
    const openMatch = new RegExp(escapeRegex(openTag), 'i').exec(source);
    if (!openMatch) {
        return null;
    }
    const after = source.slice(openMatch.index + openMatch[0].length);
    const closeMatch = new RegExp(escapeRegex(closeTag), 'i').exec(after);
    if (!closeMatch) {
        return null;
    }
    return after.slice(0, closeMatch.index).trim();
}

function removeTaggedBlocks(text, openTag, closeTag) {
    const regex = new RegExp(`${escapeRegex(openTag)}[\\s\\S]*?${escapeRegex(closeTag)}`, 'gi');
    return String(text ?? '').replace(regex, '');
}

async function buildTrackerHistory() {
    const context = SillyTavern.getContext();
    const engine = await getRegexEngine();
    const messages = context.chat.filter(m => typeof m.mes === 'string' && m.mes.trim().length > 0);
    return messages.map((m, index) => {
        let mes = clean(m.mes);
        if (engine) {
            const placement = m.is_user ? engine.regex_placement.USER_INPUT : engine.regex_placement.AI_OUTPUT;
            mes = engine.getRegexedString(mes, placement, {
                isPrompt: true,
                depth: messages.length - index - 1,
            });
        }
        return {
            role: m.is_user ? 'user' : 'assistant',
            content: clean(`${m.name || (m.is_user ? context.name1 : context.name2)}: ${mes}`),
        };
    });
}

async function buildLorebookText() {
    const context = SillyTavern.getContext();
    try {
        if (typeof context.lorebook?.getContextLorebook === 'function') {
            const chatText = context.chat.map(m => (typeof m.mes === 'string' ? m.mes : '')).join('\n');
            const text = await context.lorebook.getContextLorebook(chatText, context.characterId, 1000);
            if (typeof text === 'string' && text.trim()) {
                return text.trim();
            }
        }
    } catch (error) {
        console.warn('[LE Eternalism] getContextLorebook failed, using fallback:', error);
    }
    try {
        const current = context.lorebook?.current;
        if (Array.isArray(current)) {
            const parts = [];
            for (const item of current) {
                const content = item?.entry?.content ?? item?.content ?? '';
                const name = item?.entry?.name ?? item?.name ?? '';
                if (String(content).trim()) {
                    parts.push(name ? `${name}:\n${content}` : content);
                }
            }
            if (parts.length > 0) {
                return parts.join('\n\n');
            }
        }
    } catch (error) {
        console.warn('[LE Eternalism] lorebook fallback failed:', error);
    }
    return '';
}

function isValidTracker(tracker) {
    if (!tracker || !tracker.enabled) {
        return false;
    }
    if (!normalizeVariable(tracker.variable)) {
        log(`Tracker "${tracker.name || '(unnamed)'}" skipped: macro variable is empty.`);
        return false;
    }
    if (!clean(tracker.systemPrompt ?? '').trim()) {
        log(`Tracker "${tracker.name || '(unnamed)'}" skipped: system prompt is empty.`);
        return false;
    }
    const open = String(tracker.openTag ?? '').trim();
    const close = String(tracker.closeTag ?? '').trim();
    if (!open || !close) {
        log(`Tracker "${tracker.name || '(unnamed)'}" skipped: opening or closing tag is empty.`);
        return false;
    }
    if (open === close) {
        log(`Tracker "${tracker.name || '(unnamed)'}" skipped: opening and closing tags are the same.`);
        return false;
    }
    return true;
}

async function runTrackerStage(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.masterEnabled) {
        return false;
    }

    const trackers = settings.trackers.filter(isValidTracker);
    if (trackers.length === 0) {
        log('Tracker stage skipped: no enabled tracker with a valid macro, tags and system prompt.');
        return false;
    }
    if (messageId !== context.chat.length - 1) {
        log(`Tracker stage skipped (message ${messageId} is not the last one; last is ${context.chat.length - 1}).`);
        return false;
    }
    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system) {
        log('Tracker stage skipped (message is missing, user or system).');
        return false;
    }
    if (typeof message.mes !== 'string' || !message.mes.trim()) {
        log('Tracker stage skipped (message body is empty).');
        return false;
    }

    const cleaner = settings.preTracker ?? {};
    let preTrackerContent = '';
    if (cleaner.enabled) {
        const open = String(cleaner.openTag ?? '').trim();
        const close = String(cleaner.closeTag ?? '').trim();
        if (open && close && open !== close) {
            const extracted = extractBetween(message.mes, open, close);
            if (extracted !== null) {
                preTrackerContent = extracted;
                message.mes = removeTaggedBlocks(message.mes, open, close);
                log(`Pre-tracker cleaner: extracted ${extracted.length} chars of context, tags cleaned out of the last AI message.`);
            } else {
                log('Pre-tracker cleaner: no opening tag found in the last AI message.');
            }
        } else {
            log('Pre-tracker cleaner skipped: tags must be non-empty and different.');
        }
    } else {
        log('Pre-tracker cleaner disabled.');
    }

    const messages = [];
    const lorebookText = await buildLorebookText();
    if (lorebookText) {
        messages.push({ role: 'system', content: `Lorebook:\n${lorebookText}` });
        log(`Tracker stage: lorebook context added (${lorebookText.length} chars).`);
    } else {
        log('Tracker stage: no lorebook context available.');
    }
    const npcCard = buildCharacterCard();
    if (npcCard) {
        messages.push({ role: 'system', content: npcCard });
        log(`Tracker stage: character card added (${npcCard.length} chars).`);
    } else {
        log('Tracker stage: no character card available.');
    }
    const history = await buildTrackerHistory();
    if (history.length > 0) {
        messages.push(...history);
        log(`Tracker stage: full chat context added (${history.length} messages).`);
    }
    if (clean(settings.trackerMainPrompt).trim()) {
        messages.push({ role: 'system', content: clean(settings.trackerMainPrompt).trim() });
        log('Tracker stage: main system prompt added.');
    }
    if (preTrackerContent) {
        messages.push({ role: 'user', content: `<pre_tracker>\n${preTrackerContent}\n</pre_tracker>` });
        log(`Tracker stage: pre-tracker content added (${preTrackerContent.length} chars).`);
    }
    for (const tracker of trackers) {
        messages.push({ role: 'system', content: clean(tracker.systemPrompt).trim() });
        log(`Tracker stage: system prompt of "${tracker.name}" added.`);
    }
    if (clean(settings.trackerThinkingPrompt).trim()) {
        messages.push({ role: 'system', content: clean(settings.trackerThinkingPrompt).trim() });
        log('Tracker stage: thinking prompt added.');
    }

    let handle = null;
    let stage4Cancelled = false;
    const abortController = new AbortController();
    handle = context.loader.show({
        message: 'Stage 4: extracting trackers...',
        blocking: false,
        onStop: () => {
            stage4Cancelled = true;
            abortController.abort();
            try {
                context.stopGeneration();
            } catch (error) {
                console.warn('[LE Eternalism] Could not stop generation:', error);
            }
        },
    });
    let response = '';
    let reasoning = '';
    try {
        if (isCustomApiEnabled(settings.trackerApi)) {
            validateCustomApiConfig(settings.trackerApi, 'Stage 4');
            const result = await customChatCompletion(settings.trackerApi, messages, abortController.signal);
            response = result.content;
            reasoning = result.reasoning;
        } else {
            const result = await rawGenerate({ prompt: messages });
            response = result.content;
            reasoning = result.reasoning;
        }
        log(`Tracker stage response (${response.length} chars).`);
        if (reasoning.trim()) {
            log(`Tracker stage reasoning:\n${reasoning}`);
        }
    } catch (error) {
        if (stage4Cancelled || abortController.signal.aborted) {
            toastr.info('LE Eternalism: Stage 4 cancelled — message kept as is.');
            log('Stage 4 cancelled by user.');
            return false;
        }
        if (isCustomApiEnabled(settings.trackerApi)) {
            toastr.error(`LE Eternalism: Stage 4 custom API error — message kept as is. ${error.message}`);
            log(`Stage 4 custom API failed: ${error}`);
            return false;
        }
        throw error;
    } finally {
        if (handle) {
            await handle.hide();
        }
    }

    const extracted = new Map();
    for (const tracker of trackers) {
        const content = extractBetween(response, String(tracker.openTag).trim(), String(tracker.closeTag).trim());
        const variable = normalizeVariable(tracker.variable);
        if (content !== null) {
            extracted.set(variable, content);
            log(`Tracker "${tracker.name}": extracted ${content.length} chars for [[le_tracker_${variable}]].`);
        } else {
            log(`Tracker "${tracker.name}": no content found between its tags in the Stage 4 response.`);
        }
    }

    if (settings.debugMode) {
        const confirmed = await previewTrackerStageResult(response, reasoning, trackers, extracted);
        if (!confirmed) {
            toastr.info('LE Eternalism: Stage 4 cancelled — message kept as is.');
            log('Stage 4 aborted by user at debug checkpoint.');
            return false;
        }
        log('Stage 4 debug checkpoint confirmed.');
    }

    for (const tracker of trackers) {
        const variable = normalizeVariable(tracker.variable);
        const tag = `[[le_tracker_${variable}]]`;
        if (!message.mes.toLowerCase().includes(tag.toLowerCase())) {
            message.mes = `${message.mes.trimEnd()}\n${tag}`;
            log(`Tracker "${tracker.name}": macro ${tag} appended to the end of the last AI message.`);
        }
    }
    for (const tracker of trackers) {
        const variable = normalizeVariable(tracker.variable);
        const tag = `[[le_tracker_${variable}]]`;
        const value = extracted.get(variable) ?? '';
        const regex = new RegExp(escapeRegex(tag), 'gi');
        const count = (message.mes.match(regex) || []).length;
        if (count > 0) {
            message.mes = message.mes.replace(regex, value);
            log(`Tracker "${tracker.name}": macro ${tag} replaced with extracted content (${value.length} chars, ${count} occurrence(s)).`);
        }
    }

    const swipeId = message.swipe_id ?? 0;
    if (Array.isArray(message.swipes) && message.swipes[swipeId] !== undefined) {
        message.swipes[swipeId] = message.mes;
    }
    if (message.extra && typeof message.extra.le_eternalism_processed === 'string') {
        message.extra.le_eternalism_processed = message.mes;
    }
    await context.updateMessageBlock(messageId, message);
    await context.saveChat();
    log('Tracker stage finished: macros filled at the end of the last AI message.');
    return true;
}

async function previewTrackerStageResult(response, reasoning, trackers, extracted) {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    const summary = trackers.map(tracker => {
        const variable = normalizeVariable(tracker.variable);
        const content = extracted.get(variable);
        return `${tracker.name || '(unnamed)'}: ${content !== undefined ? `extracted ${content.length} chars` : 'tags not found in the response'}`;
    }).join('\n');
    const reasoningBlock = String(reasoning ?? '').trim()
        ? `<details class="le_eternalism_reasoning_block">
            <summary>Model reasoning (${String(reasoning).length} chars)</summary>
            <pre class="le_eternalism_debug">${escapeHtml(reasoning)}</pre>
           </details>`
        : '';
    const popup = new Popup(
        `<h3>Stage 4 — Tracker output</h3>`
        + reasoningBlock
        + `<div class="le_eternalism_hint">Output of the tracker stage. The content inside the tracker tags will be placed into the macros at the end of the last AI message.</div>`
        + `<pre class="le_eternalism_debug">${escapeHtml(response)}</pre>`
        + `<div class="le_eternalism_debug_summary">Parsed trackers:\n${escapeHtml(summary)}</div>`,
        POPUP_TYPE.TEXT,
        '',
        {
            wide: true,
            allowVerticalScrolling: true,
            okButton: 'Apply to the last message',
            cancelButton: 'Abort',
        },
    );
    const result = await popup.show();
    return result === POPUP_RESULT.AFFIRMATIVE;
}

async function manualRunTrackerStage() {
    const context = SillyTavern.getContext();
    if (!getSettings().masterEnabled) {
        toastr.warning('LE Eternalism: master toggle is disabled.');
        return;
    }
    if (isPipelineRunning) {
        toastr.warning('LE Eternalism: another stage is already running.');
        return;
    }
    const messageId = context.chat.length - 1;
    if (messageId < 0) {
        toastr.warning('LE Eternalism: the chat is empty.');
        return;
    }
    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system) {
        toastr.warning('LE Eternalism: the last message is not an AI message.');
        return;
    }
    if (typeof message.mes !== 'string' || !message.mes.trim()) {
        toastr.warning('LE Eternalism: the last AI message is empty.');
        return;
    }
    isPipelineRunning = true;
    try {
        const done = await runTrackerStage(messageId);
        if (!done) {
            toastr.info('LE Eternalism: Stage 4 skipped — see the log for details.');
        }
    } catch (error) {
        toastr.error(`LE Eternalism: Stage 4 failed: ${error.message}`);
        log(`Stage 4 failed: ${error}`);
    } finally {
        isPipelineRunning = false;
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

function handleGenerationStopped() {
    if (!getSettings().masterEnabled) {
        return;
    }
    const context = SillyTavern.getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user || message.is_system || !Array.isArray(message.swipes)) {
        return;
    }
    const swipeId = message.swipe_id ?? 0;
    // Materialize the current swipe slot so the swipe flow shows this (empty/partial)
    // content instead of reverting to the previous swipe's text.
    if (typeof message.swipes[swipeId] !== 'string') {
        message.swipes[swipeId] = typeof message.mes === 'string' ? message.mes : '';
    }
    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = [];
    }
    if (!message.swipe_info[swipeId] || typeof message.swipe_info[swipeId] !== 'object') {
        message.swipe_info[swipeId] = { extra: structuredClone(message.extra ?? {}) };
    }
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
    context.chat.forEach((message, index) => {
        if (index === lastId || !Array.isArray(message.swipes)) {
            return;
        }
        let changed = false;
        for (let i = message.swipes.length - 1; i >= 0; i--) {
            if (message.swipes[i] === '') {
                message.swipes.splice(i, 1);
                if (Array.isArray(message.swipe_info)) {
                    message.swipe_info.splice(i, 1);
                }
                changed = true;
            }
        }
        if (changed) {
            if (message.swipe_id > message.swipes.length - 1) {
                message.swipe_id = Math.max(0, message.swipes.length - 1);
            }
            if (typeof message.mes !== 'string' || message.mes === '') {
                message.mes = message.swipes[message.swipe_id] ?? '';
            }
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
    if (getSettings().stage1Enabled === false) {
        log('Stage 1 skipped (disabled).');
        return Promise.resolve();
    }
    const context = SillyTavern.getContext();
    const hasUserMessage = Array.isArray(context.chat) && context.chat.some(m => m.is_user && typeof m.mes === 'string' && m.mes.trim().length > 0);
    if (!hasUserMessage) {
        log('Stage 1 skipped: no user message in the chat yet.');
        return Promise.resolve();
    }
    return runAnalysisAndApply('auto', type).catch(error => {
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
    let replacements = 0;
    const foundTags = new Set();
    messages.forEach(msg => {
        if (!msg || typeof msg.content !== 'string') {
            return;
        }
        for (const module of modules) {
            const variable = normalizeVariable(module.variable);
            const lowerContent = msg.content.toLowerCase();
            for (const tag of [`[[le_${variable}]]`, `{{le_${variable}}}`]) {
                if (!lowerContent.includes(tag.toLowerCase())) {
                    continue;
                }
                foundTags.add(variable);
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
        }
        msg.content = msg.content.replace(/(?:^[ \t]*\[\[le_(?!tracker_)[^\]]*\]\][ \t]*\r?\n?)|(?:\[\[le_(?!tracker_)[^\]]*\]\])/gm, '');
    });

    let droppedEmpty = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg && typeof msg.content === 'string' && msg.content.trim() === '' && !msg.tool_calls && !msg.tool_call_id) {
            messages.splice(i, 1);
            droppedEmpty++;
        }
    }
    if (droppedEmpty > 0) {
        log(`Dropped ${droppedEmpty} empty message(s) from the prompt (${messages.length} remaining).`);
    }
    for (const module of modules) {
        const variable = normalizeVariable(module.variable);
        if (!foundTags.has(variable) && (activeModuleVariables.get(variable) ?? '').trim() !== '') {
            log(`WARNING: module "${module.name}" is ACTIVE but its tag [[le_${variable}]] was not found anywhere in the prompt. Add it to a preset prompt (e.g. Plaintext) so the content can be injected.`);
        }
    }
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
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose macro...';
    placeholder.disabled = true;
    placeholder.hidden = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    settings.library.forEach((prompt, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = (prompt.name && prompt.name.trim()) ? prompt.name : `(unnamed ${index + 1})`;
        select.appendChild(option);
    });
    select.selectedIndex = 0;
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
        <div class="le_eternalism_editor" style="display:flex; flex-direction:column; gap:8px;">
            <label class="le_eternalism_hint">Macro Editing</label>
            <input type="text" id="le_eternalism_lib_name" class="text_pole" placeholder="Prompt name">
            <div class="flex-container alignItemsCenter flexGap5">
                <input type="text" id="le_eternalism_lib_variable" class="text_pole flex1" placeholder="variable (e.g. violence)">
                <input type="text" id="le_eternalism_lib_trigger" class="text_pole flex1" placeholder="trigger1, trigger2, ... (comma-separated)">
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

function renderTrackerSelector() {
    const settings = getSettings();
    const select = document.getElementById('le_eternalism_tracker_select');
    if (!select) {
        return;
    }
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose tracker...';
    placeholder.disabled = true;
    placeholder.hidden = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    settings.trackers.forEach((tracker, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = (tracker.name && tracker.name.trim()) ? tracker.name : `(unnamed ${index + 1})`;
        select.appendChild(option);
    });
    select.selectedIndex = 0;
}

async function openTrackerEditor(index) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    if (index < 0 || index >= settings.trackers.length) {
        return;
    }
    const tracker = settings.trackers[index];
    const wasEmpty = !(tracker.name || '').trim() && !(tracker.systemPrompt || '').trim();

    const $content = $(`
        <div class="le_eternalism_editor" style="display:flex; flex-direction:column; gap:8px;">
            <label class="le_eternalism_hint">Tracker Editing</label>
            <input type="text" id="le_eternalism_trk_name" class="text_pole" placeholder="Tracker name">
            <div class="flex-container alignItemsCenter flexGap5">
                <input type="text" id="le_eternalism_trk_variable" class="text_pole flex1" placeholder="variable (e.g. hp)">
                <span class="le_eternalism_hint" id="le_eternalism_trk_macro_hint"></span>
            </div>
            <div class="flex-container alignItemsCenter flexGap5">
                <input type="text" id="le_eternalism_trk_open" class="text_pole flex1" placeholder="Opening tag, e.g. <hp>">
                <input type="text" id="le_eternalism_trk_close" class="text_pole flex1" placeholder="Closing tag, e.g. </hp>">
            </div>
            <div class="le_eternalism_hint le_eternalism_error" id="le_eternalism_trk_error" hidden>Opening and closing tags must be different.</div>
            <label class="checkbox_label"><input type="checkbox" id="le_eternalism_trk_enabled"> <span>Enabled</span></label>
            <label class="le_eternalism_hint">Tracker system prompt (the AI fills the tags with information)</label>
            <textarea id="le_eternalism_trk_prompt" class="text_pole" style="width:100%; min-height:200px; font-family:monospace; resize:vertical;"></textarea>
        </div>
    `);
    const nameInput = $content.find('#le_eternalism_trk_name');
    const variableInput = $content.find('#le_eternalism_trk_variable');
    const macroHint = $content.find('#le_eternalism_trk_macro_hint');
    const openInput = $content.find('#le_eternalism_trk_open');
    const closeInput = $content.find('#le_eternalism_trk_close');
    const errorHint = $content.find('#le_eternalism_trk_error');
    const enabledInput = $content.find('#le_eternalism_trk_enabled');
    const promptArea = $content.find('#le_eternalism_trk_prompt');

    const updateMacroHint = () => {
        const variable = normalizeVariable(variableInput.val());
        macroHint.text(variable ? `→ [[le_tracker_${variable}]]` : '→ [[le_tracker_…]]');
    };
    const updateError = () => {
        const open = openInput.val().trim();
        const close = closeInput.val().trim();
        errorHint.prop('hidden', !(open && close && open === close));
    };

    nameInput.val(tracker.name ?? '');
    variableInput.val(tracker.variable ?? '');
    openInput.val(tracker.openTag ?? '');
    closeInput.val(tracker.closeTag ?? '');
    enabledInput.prop('checked', !!tracker.enabled);
    promptArea.val(tracker.systemPrompt ?? '');
    updateMacroHint();
    updateError();

    nameInput.on('input', () => {
        tracker.name = clean(nameInput.val());
        saveSettings();
    });
    variableInput.on('input', () => {
        tracker.variable = normalizeVariable(variableInput.val());
        variableInput.val(tracker.variable);
        updateMacroHint();
        saveSettings();
    });
    openInput.on('input', () => {
        tracker.openTag = clean(openInput.val());
        updateError();
        saveSettings();
    });
    closeInput.on('input', () => {
        tracker.closeTag = clean(closeInput.val());
        updateError();
        saveSettings();
    });
    enabledInput.on('change', () => {
        tracker.enabled = enabledInput.prop('checked');
        saveSettings();
    });
    promptArea.on('input', () => {
        tracker.systemPrompt = clean(promptArea.val());
        saveSettings();
    });

    const popup = new Popup($content, POPUP_TYPE.TEXT, 'Edit tracker', {
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
        settings.trackers.splice(index, 1);
        saveSettings();
        renderTrackerSelector();
        log('Tracker deleted.');
        return;
    }
    const stillEmpty = !(tracker.name || '').trim() && !(tracker.systemPrompt || '').trim();
    if (wasEmpty && stillEmpty) {
        settings.trackers.splice(index, 1);
        saveSettings();
        log('Empty tracker removed (not named or edited).');
    }
    renderTrackerSelector();
}

function updateStage1Preview() {
    const previewEl = document.getElementById('le_eternalism_stage1_preview');
    if (!previewEl) {
        return;
    }
    const p1 = document.getElementById('le_eternalism_analysis1').value.trim();
    const p2 = document.getElementById('le_eternalism_analysis2').value.trim();
    const parts = [];
    parts.push('[Character card]\n<npc_card>... character description ...</npc_card>');
    parts.push('[Player card]\n<player_card>... player persona ...</player_card>');
    parts.push('[Chat history]\n...alternating messages: player = user role, AI = assistant role...');
    parts.push('[Latest user message]\n<latest_context>... most recent player message ...</latest_context>');
    if (p1) {
        parts.push(`[System prompt 1]\n${p1}`);
    }
    if (p2) {
        parts.push(`[System prompt 2]\n${p2}`);
    }
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
    document.getElementById('le_eternalism_debug').checked = !!settings.debugMode;
    document.getElementById('le_eternalism_post_enabled').checked = !!settings.postProcessEnabled;
    const stage1EnabledEl = document.getElementById('le_eternalism_stage1_enabled');
    if (stage1EnabledEl) {
        stage1EnabledEl.checked = settings.stage1Enabled !== false;
    }
    document.getElementById('le_eternalism_analysis1').value = settings.analysisPrompt1 ?? '';
    document.getElementById('le_eternalism_analysis2').value = settings.analysisPrompt2 ?? '';
    document.getElementById('le_eternalism_post1').value = settings.postProcessPrompt1 ?? '';
    document.getElementById('le_eternalism_post2').value = settings.postProcessPrompt2 ?? '';
    document.getElementById('le_eternalism_stage1_tokens').value = settings.stage1HistoryDepth;
    loadApiBlock('s1', settings.stage1Api);
    loadApiBlock('s3', settings.stage3Api);
    loadApiBlock('s4', settings.trackerApi);
    const preTracker = settings.preTracker ?? {};
    document.getElementById('le_eternalism_pretracker_enabled').checked = !!preTracker.enabled;
    document.getElementById('le_eternalism_pretracker_open').value = preTracker.openTag ?? '';
    document.getElementById('le_eternalism_pretracker_close').value = preTracker.closeTag ?? '';
    document.getElementById('le_eternalism_tracker_think').value = settings.trackerThinkingPrompt ?? '';
    document.getElementById('le_eternalism_tracker_main').value = settings.trackerMainPrompt ?? '';
    renderLibrarySelector();
    renderTrackerSelector();
    updateStage1Preview();
}

function collectSettingsFromUi() {
    const settings = getSettings();
    settings.masterEnabled = document.getElementById('le_eternalism_master').checked;
    settings.debugMode = document.getElementById('le_eternalism_debug').checked;
    settings.postProcessEnabled = document.getElementById('le_eternalism_post_enabled').checked;
    const stage1EnabledEl = document.getElementById('le_eternalism_stage1_enabled');
    if (stage1EnabledEl) {
        settings.stage1Enabled = stage1EnabledEl.checked;
    }
    settings.analysisPrompt1 = clean(document.getElementById('le_eternalism_analysis1').value);
    settings.analysisPrompt2 = clean(document.getElementById('le_eternalism_analysis2').value);
    settings.postProcessPrompt1 = clean(document.getElementById('le_eternalism_post1').value);
    settings.postProcessPrompt2 = clean(document.getElementById('le_eternalism_post2').value);
    settings.stage1HistoryDepth = Number(document.getElementById('le_eternalism_stage1_tokens').value) || 0;
    collectApiBlock('s1', settings.stage1Api);
    collectApiBlock('s3', settings.stage3Api);
    collectApiBlock('s4', settings.trackerApi);
    settings.preTracker = {
        enabled: document.getElementById('le_eternalism_pretracker_enabled').checked,
        openTag: clean(document.getElementById('le_eternalism_pretracker_open').value),
        closeTag: clean(document.getElementById('le_eternalism_pretracker_close').value),
    };
    settings.trackerThinkingPrompt = clean(document.getElementById('le_eternalism_tracker_think').value);
    settings.trackerMainPrompt = clean(document.getElementById('le_eternalism_tracker_main').value);
    saveSettings();
    ensureAllMacrosRegistered();
}

async function initExtension() {
    const context = SillyTavern.getContext();
    try {
        const response = await fetch(`/scripts/extensions/third-party/LE__LE_LE/settings.html?v=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Failed to load settings template: ${response.status}`);
        }
        const settingsHtml = await response.text();
        $('#extensions_settings2').append(settingsHtml);

        document.getElementById('le_eternalism_master').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_debug').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_post_enabled').addEventListener('change', collectSettingsFromUi);
        const stage1EnabledEl = document.getElementById('le_eternalism_stage1_enabled');
        if (stage1EnabledEl) {
            stage1EnabledEl.addEventListener('change', collectSettingsFromUi);
        }
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
        bindApiBlock('s4');
        document.getElementById('le_eternalism_pretracker_enabled').addEventListener('change', collectSettingsFromUi);
        document.getElementById('le_eternalism_pretracker_open').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_pretracker_close').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_tracker_think').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_tracker_main').addEventListener('input', collectSettingsFromUi);
        document.getElementById('le_eternalism_tracker_select').addEventListener('change', () => {
            const select = document.getElementById('le_eternalism_tracker_select');
            const index = Number(select.value);
            select.selectedIndex = 0;
            if (Number.isFinite(index) && index >= 0) {
                openTrackerEditor(index).catch(error => {
                    console.error('[LE Eternalism] Tracker editor error:', error);
                });
            }
        });
        document.getElementById('le_eternalism_tracker_add').addEventListener('click', () => {
            const settings = getSettings();
            settings.trackers.push({ name: '', variable: '', openTag: '', closeTag: '', systemPrompt: '', enabled: true });
            saveSettings();
            renderTrackerSelector();
            const index = settings.trackers.length - 1;
            document.getElementById('le_eternalism_tracker_select').selectedIndex = index;
            openTrackerEditor(index).catch(error => {
                console.error('[LE Eternalism] Tracker editor error:', error);
            });
        });
        document.getElementById('le_eternalism_tracker_run').addEventListener('click', () => {
            manualRunTrackerStage().catch(error => {
                console.error('[LE Eternalism] Manual Stage 4 error:', error);
            });
        });
        document.getElementById('le_eternalism_library_select').addEventListener('change', () => {
            const select = document.getElementById('le_eternalism_library_select');
            const index = Number(select.value);
            select.selectedIndex = 0;
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
        context.eventSource.on(context.eventTypes.GENERATION_STOPPED, handleGenerationStopped);
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
