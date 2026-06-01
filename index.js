import {
    debounce_timeout,
    MEDIA_DISPLAY,
    MEDIA_SOURCE,
    MEDIA_TYPE,
    SCROLL_BEHAVIOR,
} from '/scripts/constants.js';
import {
    appendMediaToMessage,
    event_types,
    eventSource,
    generateQuietPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    systemUserName,
} from '/script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '/scripts/extensions.js';
import { getMessageTimeStamp } from '/scripts/RossAscends-mods.js';
import { saveBase64AsFile } from '/scripts/utils.js';
import { Popup } from '/scripts/popup.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import {
    ARGUMENT_TYPE,
    SlashCommandArgument,
    SlashCommandNamedArgument,
} from '/scripts/slash-commands/SlashCommandArgument.js';

export { MODULE_NAME };

const modulePath = new URL('.', import.meta.url).pathname;
const moduleFolder = modulePath.split('/').filter(Boolean).pop() || 'dual-image-api';
const MODULE_NAME = modulePath.includes('/third-party/') ? `third-party/${moduleFolder}` : moduleFolder;
const SETTINGS_KEY = 'dualImageApi';
const API_BASE = '/api/plugins/dual-image-api';
const AUTO_SKIP_TOKEN = 'SKIP';

const defaultAutoPromptTemplate = `You are converting a roleplay chat reply into one image-generation prompt.
Return only one concise English visual prompt. Do not add explanations, markdown, JSON, quotes, or labels.
Use the current AI reply as the main scene. Include visible characters, action, setting, mood, clothing, camera/framing, and lighting.
Do not include dialogue, internal thoughts, UI text, or non-visual prose.
If the reply has no drawable visual scene, return SKIP.

Recent chat context:
{{context}}

Current AI reply:
{{message}}`;

let activeAbortController = null;
let autoHooksRegistered = false;
const pendingAutoIllustrations = new Set();

const defaultProfile = {
    apiType: 'openai-compatible',
    baseUrl: '',
    endpoint: '/v1/images/generations',
    model: '',
    width: 1024,
    height: 1024,
    steps: 30,
    cfgScale: 7,
    timeoutMs: 120000,
    resultPath: '',
    promptPrefix: '',
    promptSuffix: '',
    negativePrompt: '',
    method: 'POST',
    apiKeyHeader: 'Authorization',
    apiKeyPrefix: 'Bearer ',
    headersJson: '',
    bodyTemplate: JSON.stringify({
        model: '{{model}}',
        prompt: '{{prompt}}',
        negative_prompt: '{{negativePrompt}}',
        width: '{{width}}',
        height: '{{height}}',
        steps: '{{steps}}',
        cfg_scale: '{{cfg}}',
    }, null, 2),
};

const defaultSettings = {
    enabled: true,
    allowNsfw: false,
    showModeNote: true,
    defaultMode: 'auto',
    classifier: {
        nsfwThreshold: 3,
        nsfwKeywords: [
            'nsfw',
            'adult',
            'nude',
            'naked',
            'explicit',
            'erotic',
            'porn',
            'sex',
            'lingerie',
            '成人',
            '裸',
            '色情',
            '性感',
            '私密',
        ],
        sfwKeywords: [
            'sfw',
            'safe',
            'portrait',
            'avatar',
            'landscape',
            'fully clothed',
            'clothed',
            '头像',
            '立绘',
            '风景',
            '穿衣',
            '日常',
            '普通',
        ],
    },
    profiles: {
        sfw: { ...defaultProfile },
        nsfw: { ...defaultProfile },
    },
    autoIllustration: {
        enabled: false,
        usePromptBuilder: true,
        contextMessages: 4,
        minCharacters: 40,
        responseLength: 180,
        delayMs: 800,
        skipFirstMessage: true,
        skipIfHasMedia: true,
        promptTemplate: defaultAutoPromptTemplate,
    },
};

export async function init() {
    ensureSettings();
    await addSettingsPanel();
    addWandButton();
    bindSettings();
    registerSlashCommand();
    registerAutoIllustrationHooks();
    await refreshSecretStatus();
}

function ensureSettings() {
    const existing = extension_settings[SETTINGS_KEY] || {};
    extension_settings[SETTINGS_KEY] = mergeDefaults(existing, defaultSettings);
}

function mergeDefaults(value, defaults) {
    const output = Array.isArray(defaults) ? [...defaults] : { ...defaults };

    if (!value || typeof value !== 'object') {
        return output;
    }

    for (const [key, defaultValue] of Object.entries(defaults)) {
        if (value[key] === undefined) {
            output[key] = clone(defaultValue);
        } else if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
            output[key] = mergeDefaults(value[key], defaultValue);
        } else {
            output[key] = value[key];
        }
    }

    return output;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function settings() {
    return extension_settings[SETTINGS_KEY];
}

async function addSettingsPanel() {
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (container) {
        container.insertAdjacentHTML('beforeend', html);
    }
}

function bindSettings() {
    const current = settings();

    $('#dual_image_enabled').prop('checked', current.enabled).on('input', () => {
        current.enabled = $('#dual_image_enabled').prop('checked');
        saveSettingsDebounced();
    });

    $('#dual_image_allow_nsfw').prop('checked', current.allowNsfw).on('input', () => {
        current.allowNsfw = $('#dual_image_allow_nsfw').prop('checked');
        saveSettingsDebounced();
    });

    $('#dual_image_show_mode').prop('checked', current.showModeNote).on('input', () => {
        current.showModeNote = $('#dual_image_show_mode').prop('checked');
        saveSettingsDebounced();
    });

    $('#dual_image_default_mode').val(current.defaultMode).on('change', () => {
        current.defaultMode = String($('#dual_image_default_mode').val() || 'auto');
        saveSettingsDebounced();
    });

    $('#dual_image_threshold').val(current.classifier.nsfwThreshold).on('input', () => {
        current.classifier.nsfwThreshold = Number($('#dual_image_threshold').val()) || defaultSettings.classifier.nsfwThreshold;
        saveSettingsDebounced();
    });

    bindAutoSettings(current);

    for (const mode of ['sfw', 'nsfw']) {
        loadProfileInputs(mode);
        updateGenericVisibility(mode);
    }

    $('[data-profile][data-field]').on('input change', function () {
        const mode = String($(this).data('profile'));
        const field = String($(this).data('field'));
        const profile = current.profiles[mode];
        profile[field] = readInputValue(this);
        updateGenericVisibility(mode);
        saveSettingsDebounced();
    });

    $('[data-action="save-key"]').on('click', async function () {
        const mode = String($(this).data('mode'));
        await saveSecret(mode);
    });

    $('[data-action="delete-key"]').on('click', async function () {
        const mode = String($(this).data('mode'));
        await deleteSecret(mode);
    });

    $('[data-action="test-profile"]').on('click', async function () {
        const mode = String($(this).data('mode'));
        await testProfile(mode);
    });

    $('#dual_image_health').on('click', checkHealth);
    $('#dual_image_refresh_keys').on('click', refreshSecretStatus);
    $('#dual_image_cancel').on('click', cancelActiveGeneration);
}

function bindAutoSettings(current) {
    const auto = current.autoIllustration;

    $('#dual_image_auto_enabled').prop('checked', auto.enabled).on('input', () => {
        auto.enabled = $('#dual_image_auto_enabled').prop('checked');
        saveSettingsDebounced();
    });

    $('#dual_image_auto_use_prompt_builder').prop('checked', auto.usePromptBuilder).on('input', () => {
        auto.usePromptBuilder = $('#dual_image_auto_use_prompt_builder').prop('checked');
        saveSettingsDebounced();
    });

    $('#dual_image_auto_skip_first_message').prop('checked', auto.skipFirstMessage).on('input', () => {
        auto.skipFirstMessage = $('#dual_image_auto_skip_first_message').prop('checked');
        saveSettingsDebounced();
    });

    $('#dual_image_auto_skip_if_has_media').prop('checked', auto.skipIfHasMedia).on('input', () => {
        auto.skipIfHasMedia = $('#dual_image_auto_skip_if_has_media').prop('checked');
        saveSettingsDebounced();
    });

    $('#dual_image_auto_context_messages').val(auto.contextMessages).on('input', () => {
        auto.contextMessages = Math.max(1, Number($('#dual_image_auto_context_messages').val()) || defaultSettings.autoIllustration.contextMessages);
        saveSettingsDebounced();
    });

    $('#dual_image_auto_min_chars').val(auto.minCharacters).on('input', () => {
        auto.minCharacters = Math.max(0, Number($('#dual_image_auto_min_chars').val()) || defaultSettings.autoIllustration.minCharacters);
        saveSettingsDebounced();
    });

    $('#dual_image_auto_response_length').val(auto.responseLength).on('input', () => {
        auto.responseLength = Math.max(64, Number($('#dual_image_auto_response_length').val()) || defaultSettings.autoIllustration.responseLength);
        saveSettingsDebounced();
    });

    $('#dual_image_auto_delay_ms').val(auto.delayMs).on('input', () => {
        auto.delayMs = Math.max(0, Number($('#dual_image_auto_delay_ms').val()) || defaultSettings.autoIllustration.delayMs);
        saveSettingsDebounced();
    });

    $('#dual_image_auto_prompt_template').val(auto.promptTemplate).on('input', () => {
        auto.promptTemplate = String($('#dual_image_auto_prompt_template').val() || defaultAutoPromptTemplate);
        saveSettingsDebounced();
    });

    $('#dual_image_auto_reset_prompt').on('click', () => {
        auto.promptTemplate = defaultAutoPromptTemplate;
        $('#dual_image_auto_prompt_template').val(auto.promptTemplate);
        saveSettingsDebounced();
        toastr.success('自动配图提示词模板已恢复默认。', 'Dual Image API');
    });
}

function loadProfileInputs(mode) {
    const profile = settings().profiles[mode];
    $(`[data-profile="${mode}"][data-field]`).each(function () {
        const field = String($(this).data('field'));
        $(this).val(profile[field] ?? '');
    });
}

function readInputValue(element) {
    const input = $(element);
    if (input.attr('type') === 'number') {
        return Number(input.val()) || 0;
    }
    return String(input.val() ?? '');
}

function updateGenericVisibility(mode) {
    const profile = settings().profiles[mode];
    $(`[data-generic-for="${mode}"]`).toggleClass('is-visible', profile.apiType === 'generic-json');
}

function addWandButton() {
    const container = document.getElementById('extensionsMenu');
    if (!container || document.getElementById('dual_image_wand_button')) {
        return;
    }

    const button = document.createElement('div');
    button.id = 'dual_image_wand_button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5');
    button.innerHTML = `
        <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
        <span>Dual Image</span>
    `;
    button.addEventListener('click', openPromptPopup);
    container.append(button);
}

async function openPromptPopup() {
    const value = await Popup.show.input(
        '生成图片',
        '输入提示词。需要指定模式时，可以使用 /dualimg mode=sfw 或 mode=nsfw。',
        '',
        {
            rows: 6,
            okButton: '生成',
            cancelButton: '取消',
        },
    );

    const prompt = String(value || '').trim();
    if (!prompt) {
        return;
    }

    await generateImage(prompt, 'auto');
}

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dualimg',
        aliases: ['di'],
        callback: async (args, value) => {
            await generateImage(String(value || '').trim(), String(args.mode || 'auto'));
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'auto, sfw, or nsfw',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'auto',
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('prompt', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: 'Generate an image through Dual Image API. Example: /dualimg mode=auto a cinematic portrait',
    }));
}

async function generateImage(prompt, requestedMode = 'auto') {
    const generated = await createGeneratedImage(prompt, requestedMode, {
        showToasts: true,
        abortActive: true,
        statusPrefix: '正在使用',
    });

    if (!generated) {
        return;
    }

    await sendImageMessage(generated.prompt, generated.imagePath, generated.mode);
    setStatus(`生成完成：${generated.mode.toUpperCase()}`);
    toastr.success('图片已生成。', 'Dual Image API');
}

async function createGeneratedImage(prompt, requestedMode = 'auto', options = {}) {
    const showToasts = options.showToasts !== false;
    const abortActive = options.abortActive !== false;
    const statusPrefix = options.statusPrefix || '正在使用';

    if (!settings().enabled) {
        if (showToasts) {
            toastr.warning('Dual Image API 插件未启用。');
        }
        return null;
    }

    if (!prompt) {
        if (showToasts) {
            toastr.warning('请输入生图提示词。');
        }
        return null;
    }

    if (activeAbortController) {
        if (!abortActive) {
            setStatus('自动配图跳过：当前已有生图任务。');
            return null;
        }
        activeAbortController.abort('New generation started');
    }

    const decision = decideMode(prompt, requestedMode);
    if (decision.blocked) {
        setStatus(`生成已拦截：${decision.reason}`);
        if (showToasts) {
            toastr.error(decision.reason, 'Dual Image API');
        }
        return null;
    }

    if (decision.mode === 'nsfw' && !settings().allowNsfw) {
        const message = 'NSFW 模式未启用。请先在插件设置中打开允许 NSFW 模式。';
        setStatus(message);
        if (showToasts) {
            toastr.error(message, 'Dual Image API');
        }
        return null;
    }

    const profile = settings().profiles[decision.mode];
    const abortController = new AbortController();
    activeAbortController = abortController;
    setStatus(`${statusPrefix} ${decision.mode.toUpperCase()} 生成...`);

    try {
        const result = await fetchJson('/generate', {
            method: 'POST',
            signal: abortController.signal,
            body: {
                prompt,
                mode: decision.mode,
                profile: sanitizeProfile(profile),
            },
        });

        if (!result?.data) {
            throw new Error('服务端没有返回图片。');
        }

        const imagePath = await saveGeneratedImage(result.data, result.format || 'png', prompt);
        return { prompt, imagePath, mode: decision.mode };
    } catch (error) {
        if (abortController.signal.aborted) {
            setStatus('生成已取消。');
            if (showToasts) {
                toastr.info('生成已取消。', 'Dual Image API');
            }
            return null;
        }

        console.error('[dual-image-api] generation failed', error);
        const message = error?.message || String(error);
        setStatus(`生成失败：${message}`);
        if (showToasts) {
            toastr.error(message, 'Dual Image API');
        }
        return null;
    } finally {
        if (activeAbortController === abortController) {
            activeAbortController = null;
        }
    }
}

function registerAutoIllustrationHooks() {
    if (autoHooksRegistered) {
        return;
    }

    autoHooksRegistered = true;
    const handler = (messageId, source) => scheduleAutoIllustration(messageId, source);

    if (typeof eventSource.makeLast === 'function') {
        eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, handler);
    } else {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handler);
    }

    eventSource.on(event_types.CHAT_CHANGED, () => pendingAutoIllustrations.clear());
}

function scheduleAutoIllustration(messageId, source) {
    const auto = settings().autoIllustration;
    if (!settings().enabled || !auto?.enabled) {
        return;
    }

    const numericMessageId = Number(messageId);
    if (!Number.isInteger(numericMessageId) || pendingAutoIllustrations.has(numericMessageId)) {
        return;
    }

    if (source === 'extension') {
        return;
    }

    if (auto.skipFirstMessage && source === 'first_message') {
        return;
    }

    const context = getContext();
    const message = context.chat?.[numericMessageId];
    if (!shouldAutoIllustrateMessage(message, source)) {
        return;
    }

    pendingAutoIllustrations.add(numericMessageId);
    const expectedChatId = context.chatId;
    const delayMs = Math.max(0, Number(auto.delayMs) || defaultSettings.autoIllustration.delayMs);

    setTimeout(() => {
        void processAutoIllustration(numericMessageId, expectedChatId, source)
            .catch((error) => {
                console.error('[dual-image-api] auto illustration failed', error);
                const messageText = error?.message || String(error);
                setStatus(`自动配图失败：${messageText}`);
                toastr.error(messageText, 'Dual Image API');
            })
            .finally(() => pendingAutoIllustrations.delete(numericMessageId));
    }, delayMs);
}

function shouldAutoIllustrateMessage(message, source) {
    const auto = settings().autoIllustration;
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    if (source === 'extension') {
        return false;
    }

    const text = cleanMessageText(message.mes);
    if (!text || text === '...' || text.length < Number(auto.minCharacters || 0)) {
        return false;
    }

    if (message.extra?.dual_image_auto?.done) {
        return false;
    }

    if (message.extra?.dual_image_mode || message.extra?.dual_image_manual) {
        return false;
    }

    if (auto.skipIfHasMedia && Array.isArray(message.extra?.media) && message.extra.media.length > 0) {
        return false;
    }

    return true;
}

async function processAutoIllustration(messageId, expectedChatId, source) {
    const context = getContext();
    if (expectedChatId !== context.chatId) {
        return;
    }

    const message = context.chat?.[messageId];
    if (!shouldAutoIllustrateMessage(message, source)) {
        return;
    }

    setStatus('正在为 AI 回复生成配图提示词...');
    const prompt = await buildAutoImagePrompt(messageId);
    if (!prompt) {
        setStatus('自动配图跳过：这条回复没有可绘制场景。');
        return;
    }

    const generated = await createGeneratedImage(prompt, 'auto', {
        showToasts: false,
        abortActive: false,
        statusPrefix: '正在自动配图，使用',
    });

    if (!generated) {
        return;
    }

    await attachImageToMessage(messageId, generated.prompt, generated.imagePath, generated.mode);
    setStatus(`自动配图完成：${generated.mode.toUpperCase()}`);
    toastr.success('已为 AI 回复插入配图。', 'Dual Image API');
}

async function buildAutoImagePrompt(messageId) {
    const auto = settings().autoIllustration;
    const context = getContext();
    const message = context.chat?.[messageId];
    const fallbackPrompt = cleanMessageText(message?.mes || '').slice(0, 1200);

    if (!fallbackPrompt) {
        return '';
    }

    if (!auto.usePromptBuilder) {
        return fallbackPrompt;
    }

    const promptTemplate = auto.promptTemplate || defaultAutoPromptTemplate;
    const quietPrompt = renderTextTemplate(promptTemplate, {
        message: fallbackPrompt,
        context: buildRecentChatContext(messageId),
        char: context.name2 || '',
        user: context.name1 || '',
    });

    try {
        const reply = await generateQuietPrompt({
            quietPrompt,
            skipWIAN: true,
            responseLength: Math.max(64, Number(auto.responseLength) || defaultSettings.autoIllustration.responseLength),
            trimToSentence: false,
        });
        if (isSkipImagePrompt(reply)) {
            return '';
        }
        const prompt = cleanImagePrompt(reply);
        if (!prompt && String(reply || '').toUpperCase().includes(AUTO_SKIP_TOKEN)) {
            return '';
        }
        return prompt || fallbackPrompt;
    } catch (error) {
        console.warn('[dual-image-api] prompt builder failed, falling back to message text', error);
        return fallbackPrompt;
    }
}

function buildRecentChatContext(messageId) {
    const context = getContext();
    const count = Math.max(1, Number(settings().autoIllustration.contextMessages) || defaultSettings.autoIllustration.contextMessages);
    const start = Math.max(0, messageId - count + 1);
    return context.chat
        .slice(start, messageId + 1)
        .map((message) => {
            const name = message.name || (message.is_user ? context.name1 : context.name2) || 'Message';
            return `${name}: ${cleanMessageText(message.mes).slice(0, 700)}`;
        })
        .filter((line) => line.trim().length > 2)
        .join('\n');
}

async function attachImageToMessage(messageId, prompt, imagePath, mode) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        throw new Error('找不到要插入图片的消息。');
    }

    message.extra = message.extra || {};
    message.extra.media = Array.isArray(message.extra.media) ? message.extra.media : [];
    message.extra.media.push({
        url: imagePath,
        type: MEDIA_TYPE.IMAGE,
        title: prompt,
        source: MEDIA_SOURCE.GENERATED,
        dual_image_mode: mode,
        dual_image_auto: true,
    });
    message.extra.media_display = MEDIA_DISPLAY.GALLERY;
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.inline_image = true;
    message.extra.dual_image_auto = {
        done: true,
        mode,
        prompt,
        source_hash: hashString(message.mes || ''),
        inserted_at: new Date().toISOString(),
    };

    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
    if (messageElement.length) {
        appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.ADJUST);
    }

    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    await context.saveChat();
    setTimeout(() => context.scrollOnMediaLoad(), debounce_timeout.short);
}

function cancelActiveGeneration() {
    if (!activeAbortController) {
        toastr.info('当前没有正在进行的生图任务。', 'Dual Image API');
        return;
    }

    activeAbortController.abort('Cancelled by user');
    setStatus('正在取消当前生成...');
}

function decideMode(prompt, requestedMode) {
    const normalizedPrompt = normalizePrompt(prompt);
    const hasNsfwSignal = scoreTerms(normalizedPrompt, settings().classifier.nsfwKeywords) > 0;
    const hasMinorSignal = scoreTerms(normalizedPrompt, ['minor', 'child', 'kid', 'underage', 'teen', 'loli', 'shota', '未成年', '儿童', '小孩', '幼', '萝莉', '正太']) > 0;
    const hasNonConsentSignal = scoreTerms(normalizedPrompt, ['non-consensual', 'rape', 'forced', '强迫', '无同意', '非自愿']) > 0;

    if (hasNsfwSignal && hasMinorSignal) {
        return { blocked: true, reason: '提示词包含未成年人相关成人内容，已拦截。' };
    }

    if (hasNsfwSignal && hasNonConsentSignal) {
        return { blocked: true, reason: '提示词包含非自愿或强迫相关成人内容，已拦截。' };
    }

    const requested = ['sfw', 'nsfw', 'auto'].includes(String(requestedMode).toLowerCase())
        ? String(requestedMode).toLowerCase()
        : 'auto';
    const preference = requested === 'auto' ? settings().defaultMode : requested;

    if (preference === 'sfw' || preference === 'nsfw') {
        return { blocked: false, mode: preference };
    }

    const nsfwScore = scoreTerms(normalizedPrompt, settings().classifier.nsfwKeywords);
    const sfwScore = scoreTerms(normalizedPrompt, settings().classifier.sfwKeywords);
    const finalScore = nsfwScore - sfwScore;
    const threshold = Number(settings().classifier.nsfwThreshold) || defaultSettings.classifier.nsfwThreshold;

    return {
        blocked: false,
        mode: finalScore >= threshold ? 'nsfw' : 'sfw',
    };
}

function normalizePrompt(prompt) {
    return String(prompt || '')
        .toLowerCase()
        .replace(/[()[\]{}"'`*_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreTerms(text, terms) {
    return terms.reduce((score, term) => {
        const normalizedTerm = normalizePrompt(term);
        if (!normalizedTerm) {
            return score;
        }
        return text.includes(normalizedTerm) ? score + 1 : score;
    }, 0);
}

function cleanMessageText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
        .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanImagePrompt(text) {
    let prompt = String(text || '').trim();
    prompt = prompt.replace(/^```(?:\w+)?/i, '').replace(/```$/i, '').trim();
    prompt = prompt.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    prompt = prompt.replace(/^(image prompt|prompt|caption)\s*:\s*/i, '').trim();

    if (!prompt || isSkipImagePrompt(prompt)) {
        return '';
    }

    if (prompt.split(/\s+/).length <= 3 && prompt.toUpperCase().includes(AUTO_SKIP_TOKEN)) {
        return '';
    }

    return prompt.slice(0, 1200);
}

function isSkipImagePrompt(text) {
    return String(text || '')
        .replace(/^```(?:\w+)?/i, '')
        .replace(/```$/i, '')
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .replace(/[.!。]+$/g, '')
        .trim()
        .toUpperCase() === AUTO_SKIP_TOKEN;
}

function renderTextTemplate(template, variables) {
    return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
        return String(variables[key] ?? '');
    });
}

function hashString(value) {
    let hash = 0;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(index);
        hash |= 0;
    }
    return String(hash);
}

function sanitizeProfile(profile) {
    return {
        ...profile,
        width: Number(profile.width) || defaultProfile.width,
        height: Number(profile.height) || defaultProfile.height,
        steps: Number(profile.steps) || defaultProfile.steps,
        cfgScale: Number(profile.cfgScale) || defaultProfile.cfgScale,
        timeoutMs: Number(profile.timeoutMs) || defaultProfile.timeoutMs,
    };
}

async function saveGeneratedImage(base64, format, prompt) {
    const context = getContext();
    const folderName = context.name2 || 'DualImage';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${folderName}_${timestamp}`;
    return await saveBase64AsFile(base64, folderName, filename, format);
}

async function sendImageMessage(prompt, imagePath, mode) {
    const context = getContext();
    const name = context.groupId ? systemUserName : context.name2;
    const messageText = settings().showModeNote ? `[${mode.toUpperCase()}] ${prompt}` : prompt;
    const message = {
        name,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: messageText,
        extra: {
            media: [{
                url: imagePath,
                type: MEDIA_TYPE.IMAGE,
                title: prompt,
                source: MEDIA_SOURCE.GENERATED,
                dual_image_mode: mode,
            }],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: false,
            dual_image_manual: true,
        },
    };

    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    setTimeout(() => context.scrollOnMediaLoad(), debounce_timeout.short);
}

async function saveSecret(mode) {
    const input = $(`#dual_image_${mode}_api_key`);
    const apiKey = String(input.val() || '').trim();
    if (!apiKey) {
        toastr.warning('请输入要保存的 API Key。', 'Dual Image API');
        return;
    }

    await fetchJson('/secrets', {
        method: 'POST',
        body: { mode, apiKey },
    });
    input.val('');
    await refreshSecretStatus();
    toastr.success(`${mode.toUpperCase()} 密钥已保存。`, 'Dual Image API');
}

async function deleteSecret(mode) {
    await fetchJson(`/secrets/${mode}`, { method: 'DELETE' });
    await refreshSecretStatus();
    toastr.success(`${mode.toUpperCase()} 密钥已删除。`, 'Dual Image API');
}

async function testProfile(mode) {
    try {
        const result = await fetchJson('/test', {
            method: 'POST',
            body: {
                mode,
                profile: sanitizeProfile(settings().profiles[mode]),
            },
        });
        const keyText = result.keyConfigured ? '密钥已配置' : '密钥未配置';
        setStatus(`${mode.toUpperCase()} 配置可用，${keyText}。`);
        toastr.success(`${mode.toUpperCase()} 配置检查通过。`, 'Dual Image API');
    } catch (error) {
        setStatus(`${mode.toUpperCase()} 配置检查失败：${error.message}`);
        toastr.error(error.message, 'Dual Image API');
    }
}

async function checkHealth() {
    try {
        const result = await fetchJson('/health', { method: 'GET' });
        setStatus(result.ok ? '服务端插件已连接。' : '服务端插件状态异常。');
        toastr.success('服务端插件已连接。', 'Dual Image API');
    } catch (error) {
        setStatus(`服务端插件不可用：${error.message}`);
        toastr.error('服务端插件不可用，请确认 SillyTavern 已启用 server plugins。', 'Dual Image API');
    }
}

async function refreshSecretStatus() {
    try {
        const status = await fetchJson('/secrets/status', { method: 'GET' });
        updateKeyState('sfw', Boolean(status.sfwKeyConfigured));
        updateKeyState('nsfw', Boolean(status.nsfwKeyConfigured));
    } catch {
        updateKeyState('sfw', false, '无法检查');
        updateKeyState('nsfw', false, '无法检查');
    }
}

function updateKeyState(mode, configured, label = null) {
    const element = $(`#dual_image_${mode}_key_state`);
    element.toggleClass('is-set', configured);
    element.text(label || (configured ? '密钥已配置' : '密钥未配置'));
}

async function fetchJson(path, options) {
    const fetchOptions = {
        method: options.method || 'GET',
        headers: getRequestHeaders(),
        signal: options.signal,
    };

    if (options.body !== undefined) {
        fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${API_BASE}${path}`, fetchOptions);
    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }

    if (!response.ok) {
        throw new Error(data?.error || text || `Request failed with ${response.status}`);
    }

    return data;
}

function setStatus(message) {
    $('#dual_image_status').text(message || '');
}
