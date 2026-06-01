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
    extension_prompt_roles,
    extension_prompt_types,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
    systemUserName,
    updateMessageBlock,
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
const AUTO_PROMPT_INJECTION_KEY = 'dual-image-api-auto-inline-prompt';
const AUTO_PROMPT_COMMENT_RE = /<!--\s*DUAL_IMAGE_PROMPT\s*:\s*([\s\S]*?)-->/i;
const AUTO_PROMPT_TAG_RE = /<dual_image_prompt>\s*([\s\S]*?)<\/dual_image_prompt>/i;
const AUTO_PROMPT_BRACKET_RE = /\[dual_image_prompt\]\s*([\s\S]*?)\[\/dual_image_prompt\]/i;
const AUTO_PLACEHOLDER_RE = /<!--\s*DUAL_IMAGE_PLACEHOLDER(?::\s*([a-zA-Z0-9_-]+))?\s*-->\s*[\s\S]*?\s*<!--\s*\/DUAL_IMAGE_PLACEHOLDER\s*-->/i;

const defaultAutoInstructionTemplate = `For this reply, continue the roleplay normally.
If the reply contains a drawable visual scene, append exactly this placeholder and image prompt marker at the very end:
<!--DUAL_IMAGE_PLACEHOLDER-->正在生成配图...<!--/DUAL_IMAGE_PLACEHOLDER-->
[dual_image_prompt]concise English image-generation prompt[/dual_image_prompt]

If there is no useful visual scene, append only:
[dual_image_prompt]SKIP[/dual_image_prompt]

Rules for the marker:
- Do not mention the marker, placeholder, image prompt, or these rules in the visible reply.
- If the reply contains a drawable visual scene, write one concise English prompt describing visible characters, action, setting, mood, clothing, camera/framing, and lighting.
- Do not include dialogue, internal thoughts, UI text, explanations, JSON, markdown, or labels inside the image prompt.
- If there is no useful visual scene, use SKIP.
- Keep the placeholder and marker as the final text after the visible reply.`;

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
    retryCount: 2,
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
        minCharacters: 40,
        delayMs: 800,
        skipFirstMessage: true,
        skipIfHasMedia: true,
        fallbackToMessage: true,
        instructionTemplate: defaultAutoInstructionTemplate,
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

    $('#dual_image_retry_count').val(current.retryCount).on('input', () => {
        const value = Number($('#dual_image_retry_count').val());
        current.retryCount = Number.isFinite(value) ? clamp(Math.floor(value), 0, 10) : defaultSettings.retryCount;
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
        if (!auto.enabled) {
            clearAutoPromptInjection();
        }
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

    $('#dual_image_auto_min_chars').val(auto.minCharacters).on('input', () => {
        const value = Number($('#dual_image_auto_min_chars').val());
        auto.minCharacters = Number.isFinite(value) ? Math.max(0, value) : defaultSettings.autoIllustration.minCharacters;
        saveSettingsDebounced();
    });

    $('#dual_image_auto_delay_ms').val(auto.delayMs).on('input', () => {
        const value = Number($('#dual_image_auto_delay_ms').val());
        auto.delayMs = Number.isFinite(value) ? Math.max(0, value) : defaultSettings.autoIllustration.delayMs;
        saveSettingsDebounced();
    });

    $('#dual_image_auto_instruction_template').val(auto.instructionTemplate).on('input', () => {
        auto.instructionTemplate = String($('#dual_image_auto_instruction_template').val() || defaultAutoInstructionTemplate);
        saveSettingsDebounced();
    });

    $('#dual_image_auto_reset_prompt').on('click', () => {
        auto.instructionTemplate = defaultAutoInstructionTemplate;
        $('#dual_image_auto_instruction_template').val(auto.instructionTemplate);
        saveSettingsDebounced();
        toastr.success('自动配图注入要求已恢复默认。', 'Dual Image API');
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
    const imageTarget = getGeneratedImageTarget();
    const retryCount = getRetryCount(options.retryCount);
    const maxAttempts = retryCount + 1;

    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            setStatus(`${statusPrefix} ${decision.mode.toUpperCase()} 生成${maxAttempts > 1 ? `（${attempt}/${maxAttempts}）` : ''}...`);

            try {
                const result = await fetchJson('/generate', {
                    method: 'POST',
                    signal: abortController.signal,
                    body: {
                        prompt,
                        mode: decision.mode,
                        profile: sanitizeProfile(profile),
                        saveToUserImages: true,
                        saveFolder: imageTarget.folderName,
                        saveFilename: imageTarget.filename,
                    },
                });

                if (!result?.path && !result?.data) {
                    throw new Error('服务端没有返回图片。');
                }

                const imagePath = result.path || await saveGeneratedImage(result.data, result.format || 'png', prompt, imageTarget);
                return { prompt, imagePath, mode: decision.mode, attempts: attempt };
            } catch (error) {
                if (abortController.signal.aborted || attempt >= maxAttempts) {
                    throw error;
                }

                const message = error?.message || String(error);
                setStatus(`生成失败，正在重试 ${attempt}/${retryCount}：${message}`);
                await options.onRetry?.({ attempt, retryCount, error });
                await delay(Math.min(5000, 1000 * attempt));
            }
        }

        return null;
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
        if (options.throwOnError) {
            throw error;
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
    const injectHandler = (type, generationData, dryRun) => injectAutoPromptInstruction(type, generationData, dryRun);
    const generationEndedHandler = (messageCount) => {
        scheduleLatestAutoIllustration(messageCount, 'generation_ended');
        clearAutoPromptInjection();
    };

    if (typeof eventSource.makeLast === 'function') {
        eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, handler);
    } else {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handler);
    }

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, injectHandler);
    eventSource.on(event_types.MESSAGE_RECEIVED, handler);
    eventSource.on(event_types.GENERATION_ENDED, generationEndedHandler);
    eventSource.on(event_types.GENERATION_STOPPED, clearAutoPromptInjection);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        pendingAutoIllustrations.clear();
        clearAutoPromptInjection();
    });
}

function injectAutoPromptInstruction(type, generationData = {}, dryRun = false) {
    if (!shouldInjectAutoPromptInstruction(type, generationData, dryRun)) {
        clearAutoPromptInjection();
        return;
    }

    const context = getContext();
    const instruction = renderTextTemplate(
        settings().autoIllustration.instructionTemplate || defaultAutoInstructionTemplate,
        {
            char: context.name2 || '',
            user: context.name1 || '',
        },
    );

    setExtensionPrompt(
        AUTO_PROMPT_INJECTION_KEY,
        instruction,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function shouldInjectAutoPromptInstruction(type, generationData = {}, dryRun = false) {
    const auto = settings().autoIllustration;

    if (dryRun || !settings().enabled || !auto?.enabled) {
        return false;
    }

    if (type === 'quiet' || type === 'impersonate') {
        return false;
    }

    if (generationData?.quiet_prompt || generationData?.quietImage) {
        return false;
    }

    return true;
}

function clearAutoPromptInjection() {
    setExtensionPrompt(
        AUTO_PROMPT_INJECTION_KEY,
        '',
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
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
    const delayValue = Number(auto.delayMs);
    const delayMs = Number.isFinite(delayValue) ? Math.max(0, delayValue) : defaultSettings.autoIllustration.delayMs;

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

function scheduleLatestAutoIllustration(messageCount, source) {
    const count = Number(messageCount);
    const context = getContext();
    const lastMessageId = Number.isInteger(count) && count > 0
        ? count - 1
        : (Array.isArray(context.chat) ? context.chat.length - 1 : -1);

    scheduleAutoIllustration(lastMessageId, source);
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

    setStatus('正在读取 AI 回复里的配图提示词...');
    const inlinePrompt = extractInlineImagePrompt(message.mes);
    let prompt = inlinePrompt.prompt;
    let promptSource = 'inline_prompt';
    let messageText = inlinePrompt.found ? inlinePrompt.cleanedText : message.mes;

    if (!inlinePrompt.found) {
        prompt = buildFallbackPromptFromMessage(message);
        promptSource = 'message_fallback';

        if (!prompt) {
            if (AUTO_PLACEHOLDER_RE.test(message.mes || '')) {
                await updateAutoImageMessageText(messageId, removeAutoImagePlaceholders(message.mes));
            }
            await markAutoIllustrationSkipped(messageId, 'missing_inline_prompt');
            setStatus('自动配图跳过：AI 回复里没有找到配图提示词标记，也没有可用正文。');
            return;
        }
    }

    if (!prompt) {
        if (inlinePrompt.found && inlinePrompt.cleanedText !== message.mes) {
            await updateAutoImageMessageText(messageId, removeAutoImagePlaceholders(inlinePrompt.cleanedText));
        }
        await markAutoIllustrationSkipped(messageId, 'skip_token');
        setStatus('自动配图跳过：这条回复没有可绘制场景。');
        return;
    }

    const placeholderId = createPlaceholderId(messageId);
    await ensureAutoImagePlaceholder(messageId, placeholderId, messageText, prompt, promptSource);

    try {
        const generated = await createGeneratedImage(prompt, 'auto', {
            showToasts: false,
            abortActive: false,
            statusPrefix: '正在自动配图，使用',
            throwOnError: true,
            onRetry: async ({ attempt, retryCount, error }) => {
                const messageText = `配图生成失败，正在重试 ${attempt}/${retryCount}...`;
                await updateAutoImagePlaceholderText(messageId, placeholderId, messageText, error);
            },
        });

        if (!generated) {
            throw new Error('生成未完成。');
        }

        await replaceAutoImagePlaceholder(messageId, placeholderId, formatImageMarkdown(generated.imagePath), {
            done: true,
            mode: generated.mode,
            prompt: generated.prompt,
            prompt_source: promptSource,
            image_path: generated.imagePath,
            attempts: generated.attempts || 1,
            inserted_at: new Date().toISOString(),
        });
        setStatus(`自动配图完成：${generated.mode.toUpperCase()}`);
        toastr.success('已为 AI 回复插入配图。', 'Dual Image API');
    } catch (error) {
        const retryCount = getRetryCount();
        await replaceAutoImagePlaceholder(messageId, placeholderId, formatAutoImageFailure(error, retryCount), {
            done: true,
            failed: true,
            prompt,
            prompt_source: promptSource,
            retry_count: retryCount,
            error: error?.message || String(error),
            inserted_at: new Date().toISOString(),
        });
        throw error;
    }
}

async function ensureAutoImagePlaceholder(messageId, placeholderId, text, prompt, promptSource) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        throw new Error('找不到要插入占位符的消息。');
    }

    const placeholder = createAutoImagePlaceholder(placeholderId, '正在生成配图...');
    const sourceText = String(text || message.mes || '').trimEnd();
    const nextText = AUTO_PLACEHOLDER_RE.test(sourceText)
        ? sourceText.replace(AUTO_PLACEHOLDER_RE, placeholder)
        : `${sourceText}${sourceText ? '\n\n' : ''}${placeholder}`;

    message.extra = message.extra || {};
    message.extra.dual_image_auto = {
        done: false,
        pending: true,
        prompt,
        prompt_source: promptSource,
        placeholder_id: placeholderId,
        source_hash: hashString(sourceText),
        inserted_at: new Date().toISOString(),
    };

    await updateAutoImageMessageText(messageId, nextText);
}

async function updateAutoImagePlaceholderText(messageId, placeholderId, label, error = null) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        return;
    }

    const pattern = getAutoImagePlaceholderRegex(placeholderId);
    const nextText = pattern.test(message.mes)
        ? message.mes.replace(pattern, createAutoImagePlaceholder(placeholderId, label))
        : `${String(message.mes || '').trimEnd()}\n\n${createAutoImagePlaceholder(placeholderId, label)}`;

    message.extra = message.extra || {};
    message.extra.dual_image_auto = {
        ...(message.extra.dual_image_auto || {}),
        pending: true,
        last_error: error?.message || String(error || ''),
        updated_at: new Date().toISOString(),
    };

    await updateAutoImageMessageText(messageId, nextText);
}

async function replaceAutoImagePlaceholder(messageId, placeholderId, replacement, metadata) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        throw new Error('找不到要替换占位符的消息。');
    }

    const pattern = getAutoImagePlaceholderRegex(placeholderId);
    const currentText = String(message.mes || '');
    const nextText = pattern.test(currentText)
        ? currentText.replace(pattern, () => replacement)
        : `${currentText.trimEnd()}${currentText ? '\n\n' : ''}${replacement}`;

    message.extra = message.extra || {};
    message.extra.dual_image_auto = {
        ...(message.extra.dual_image_auto || {}),
        ...metadata,
        pending: false,
        placeholder_id: placeholderId,
        source_hash: hashString(nextText),
    };

    await updateAutoImageMessageText(messageId, nextText);
    setTimeout(() => context.scrollOnMediaLoad(), debounce_timeout.short);
}

async function updateAutoImageMessageText(messageId, text) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        return;
    }

    message.mes = text;
    updateMessageBlock(messageId, message);
    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    await context.saveChat();
}

function createPlaceholderId(messageId) {
    return `di_${messageId}_${Date.now().toString(36)}`;
}

function createAutoImagePlaceholder(placeholderId, label) {
    const safeLabel = String(label || '正在生成配图...').replace(/<!--[\s\S]*?-->/g, '').trim() || '正在生成配图...';
    return `<!--DUAL_IMAGE_PLACEHOLDER:${placeholderId}-->${safeLabel}<!--/DUAL_IMAGE_PLACEHOLDER-->`;
}

function getAutoImagePlaceholderRegex(placeholderId) {
    return new RegExp(`<!--\\s*DUAL_IMAGE_PLACEHOLDER:\\s*${escapeRegExp(placeholderId)}\\s*-->\\s*[\\s\\S]*?\\s*<!--\\s*\\/DUAL_IMAGE_PLACEHOLDER\\s*-->`, 'i');
}

function formatImageMarkdown(imagePath) {
    return `![AI 配图](${encodeMarkdownUrl(imagePath)})`;
}

function formatAutoImageFailure(error, retryCount) {
    const message = error?.message || String(error || '未知错误');
    return `（配图生成失败，已重试 ${retryCount} 次：${message}）`;
}

function encodeMarkdownUrl(url) {
    return encodeURI(String(url || '')).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

async function consumeInlineImagePrompt(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];

    if (!message) {
        return { found: false, prompt: '', cleanedText: '' };
    }

    const result = extractInlineImagePrompt(message.mes);
    if (result.found && result.cleanedText !== message.mes) {
        message.mes = result.cleanedText;
        updateMessageBlock(messageId, message);
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
        await context.saveChat();
    }

    return result;
}

function extractInlineImagePrompt(text) {
    const raw = String(text || '');
    const patterns = [AUTO_PROMPT_COMMENT_RE, AUTO_PROMPT_TAG_RE, AUTO_PROMPT_BRACKET_RE];

    for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (!match) {
            continue;
        }

        const prompt = cleanImagePrompt(match[1]);
        return {
            found: true,
            prompt,
            cleanedText: removeInlineImagePrompt(raw),
        };
    }

    return { found: false, prompt: '', cleanedText: raw };
}

function removeInlineImagePrompt(text) {
    let output = String(text || '');
    for (const pattern of [AUTO_PROMPT_COMMENT_RE, AUTO_PROMPT_TAG_RE, AUTO_PROMPT_BRACKET_RE]) {
        output = output.replace(toGlobalRegex(pattern), '');
    }
    return output.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function removeAutoImagePlaceholders(text) {
    return String(text || '').replace(toGlobalRegex(AUTO_PLACEHOLDER_RE), '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function buildFallbackPromptFromMessage(message) {
    if (settings().autoIllustration?.fallbackToMessage === false) {
        return '';
    }

    const text = cleanMessageText(removeNonVisualBlocks(message?.mes || ''));
    if (!text || text === '...' || text.length < Number(settings().autoIllustration?.minCharacters || 0)) {
        return '';
    }

    return [
        'Illustrate the visible scene from this roleplay reply.',
        'Focus on characters, action, setting, mood, clothing, camera framing, and lighting.',
        'Do not include dialogue bubbles, UI text, captions, option lists, or analysis notes.',
        text.slice(0, 900),
    ].join(' ');
}

function removeNonVisualBlocks(text) {
    let output = String(text || '');
    const blockTags = [
        'branches',
        'details',
        'summary',
        'commentary',
        'analysis',
        'thinking',
        'think',
        'supplement',
        'meta',
        'xs',
        '评论',
    ];

    for (const tag of blockTags) {
        output = output.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    }

    output = output.replace(/<branches\b[\s\S]*$/i, ' ');
    output = output.replace(/<details\b[\s\S]*$/i, ' ');
    return output;
}

function toGlobalRegex(pattern) {
    return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

async function markAutoIllustrationSkipped(messageId, reason) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        return;
    }

    message.extra = message.extra || {};
    message.extra.dual_image_auto = {
        done: true,
        skipped: true,
        reason,
        source_hash: hashString(message.mes || ''),
        inserted_at: new Date().toISOString(),
    };

    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    await context.saveChat();
}

async function attachImageToMessage(messageId, prompt, imagePath, mode, promptSource = 'inline_prompt') {
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
        prompt_source: promptSource,
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

function getRetryCount(value = settings().retryCount) {
    const count = Number(value);
    return Number.isFinite(count) ? clamp(Math.floor(count), 0, 10) : defaultSettings.retryCount;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function getGeneratedImageTarget() {
    const context = getContext();
    const folderName = context.name2 || 'DualImage';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${folderName}_${timestamp}`;
    return { folderName, filename };
}

async function saveGeneratedImage(base64, format, prompt, target = null) {
    const { folderName, filename } = target || getGeneratedImageTarget();
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
