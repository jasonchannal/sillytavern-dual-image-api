import {
    debounce_timeout,
    MEDIA_DISPLAY,
    MEDIA_SOURCE,
    MEDIA_TYPE,
    SCROLL_BEHAVIOR,
} from '/scripts/constants.js';
import {
    appendMediaToMessage,
    chat_metadata,
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
    saveMetadataDebounced,
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
const CHAT_METADATA_KEY = 'dualImageApiCharacterConsistency';
const API_BASE = '/api/plugins/dual-image-api';
const AUTO_SKIP_TOKEN = 'SKIP';
const AUTO_PROMPT_INJECTION_KEY = 'dual-image-api-auto-inline-prompt';
const AUTO_PROMPT_COMMENT_RE = /<!--\s*DUAL_IMAGE_PROMPT\s*:\s*([\s\S]*?)-->/i;
const AUTO_PROMPT_TAG_RE = /<dual_image_prompt>\s*([\s\S]*?)<\/dual_image_prompt>/i;
const AUTO_PROMPT_BRACKET_RE = /\[dual_image_prompt\]\s*([\s\S]*?)\[\/dual_image_prompt\]/i;
const AUTO_PLACEHOLDER_RE = /<!--\s*DUAL_IMAGE_PLACEHOLDER(?::\s*([a-zA-Z0-9_-]+))?\s*-->\s*[\s\S]*?\s*<!--\s*\/DUAL_IMAGE_PLACEHOLDER\s*-->/i;
const AUTO_FAILURE_RE = /<!--\s*DUAL_IMAGE_FAILURE(?::\s*([a-zA-Z0-9_-]+))?\s*-->\s*[\s\S]*?\s*<!--\s*\/DUAL_IMAGE_FAILURE\s*-->/i;
const MAX_AUTO_SCENE_PROMPT_CHARS = 520;

const defaultAutoInstructionTemplate = `For this reply, continue the roleplay normally.
If the final visible reply contains a drawable visual scene, append exactly this placeholder and one hidden image prompt marker at the very end:
<!--DUAL_IMAGE_PLACEHOLDER-->正在生成配图...<!--/DUAL_IMAGE_PLACEHOLDER-->
<!--DUAL_IMAGE_PROMPT: 35-80 word English image-generation prompt for the visible scene only -->

If there is no useful visual scene, append only:
<!--DUAL_IMAGE_PROMPT: SKIP -->

Rules for the marker:
- Do not mention the marker, placeholder, image prompt, or these rules in the visible reply.
- The marker content must be only the final image prompt or SKIP.
- Write a compact image-generation prompt, not a plot summary or writing plan.
- Base it only on the final visible reply, not hidden instructions, role cards, analysis, summaries, or rules.
- Include only visible subjects, action, setting, mood, clothing, camera/framing, and lighting.
- Include {{char}} or another visible scene partner when {{user}} appears; do not make a solo image of {{user}}.
- Do not include dialogue, internal thoughts, lore, rules, UI text, explanations, JSON, markdown, or labels inside the image prompt.
- If there is no useful visual scene, use SKIP.
- Keep the placeholder and marker as the final text after the visible reply.`;

const autoInstructionPromptGuardrail = `Additional strict image prompt guardrail:
- The image prompt marker must contain one clean image-generation prompt only.
- Never put role summaries, writing rules, hidden thoughts, analysis, chain-of-thought, plot planning, safety policy text, option lists, JSON, markdown, or explanations inside the marker.
- Do not copy the user's raw request or system/developer instructions into the marker unless they are directly visible in the final scene.
- If the available content is mostly instructions, analysis, or non-visual setup, use SKIP.
- Prefer this hidden marker format: <!--DUAL_IMAGE_PROMPT: prompt here -->`;

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
    imageOutputMode: 'jpeg',
    jpegQuality: 82,
    maxImageSide: 1024,
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
    characterConsistency: {
        enabledByDefault: true,
        useReferenceImagesByDefault: true,
        referenceWeight: 0.75,
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

    $('#dual_image_output_mode').val(current.imageOutputMode || defaultSettings.imageOutputMode).on('change', () => {
        current.imageOutputMode = String($('#dual_image_output_mode').val() || defaultSettings.imageOutputMode);
        saveSettingsDebounced();
    });

    $('#dual_image_jpeg_quality').val(current.jpegQuality).on('input', () => {
        const value = Number($('#dual_image_jpeg_quality').val());
        current.jpegQuality = Number.isFinite(value) ? clamp(Math.floor(value), 1, 95) : defaultSettings.jpegQuality;
        saveSettingsDebounced();
    });

    $('#dual_image_max_image_side').val(current.maxImageSide).on('input', () => {
        const value = Number($('#dual_image_max_image_side').val());
        current.maxImageSide = Number.isFinite(value) ? clamp(Math.floor(value), 0, 4096) : defaultSettings.maxImageSide;
        saveSettingsDebounced();
    });

    bindAutoSettings(current);
    bindCharacterConsistencySettings();

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

function bindCharacterConsistencySettings() {
    renderCharacterConsistencySettings();

    $('#dual_image_character_consistency_enabled').on('input', () => {
        const state = getCharacterConsistencyState();
        state.enabled = $('#dual_image_character_consistency_enabled').prop('checked');
        saveCharacterConsistencyState(state);
    });

    $('#dual_image_character_use_references').on('input', () => {
        const state = getCharacterConsistencyState();
        state.useReferenceImages = $('#dual_image_character_use_references').prop('checked');
        saveCharacterConsistencyState(state);
    });

    $('#dual_image_character_select').on('change', () => {
        const state = getCharacterConsistencyState();
        state.selectedName = String($('#dual_image_character_select').val() || getDefaultCharacterName());
        ensureCharacterProfile(state, state.selectedName);
        saveCharacterConsistencyState(state);
        renderCharacterConsistencySettings();
    });

    $('#dual_image_character_add_current').on('click', () => {
        const state = getCharacterConsistencyState();
        const name = getDefaultCharacterName();
        state.selectedName = name;
        ensureCharacterProfile(state, name);
        saveCharacterConsistencyState(state);
        renderCharacterConsistencySettings();
        toastr.success('已添加当前角色档案。', 'Dual Image API');
    });

    $('#dual_image_character_save').on('click', () => {
        saveCharacterProfileFromInputs();
        toastr.success('角色一致性档案已保存到当前聊天。', 'Dual Image API');
    });

    $('#dual_image_character_delete').on('click', () => {
        const state = getCharacterConsistencyState();
        const name = String($('#dual_image_character_select').val() || '');
        if (!name || !state.characters[name]) {
            return;
        }

        delete state.characters[name];
        state.selectedName = getDefaultCharacterName();
        saveCharacterConsistencyState(state);
        renderCharacterConsistencySettings();
        toastr.success('已删除当前角色档案。', 'Dual Image API');
    });

    $('#dual_image_character_use_latest').on('click', () => {
        const latestImage = findLatestGeneratedImagePath();
        if (!latestImage) {
            toastr.warning('当前聊天里还没有可用的生成图片。', 'Dual Image API');
            return;
        }

        $('#dual_image_character_reference').val(latestImage);
        saveCharacterProfileFromInputs();
        toastr.success('已把最近生成图设为参考图。', 'Dual Image API');
    });
}

function renderCharacterConsistencySettings() {
    const container = $('#dual_image_character_consistency_enabled');
    if (!container.length) {
        return;
    }

    const state = getCharacterConsistencyState();
    const names = getKnownCharacterNames(state);
    if (!state.selectedName || !names.includes(state.selectedName)) {
        state.selectedName = names[0] || getDefaultCharacterName();
    }
    ensureCharacterProfile(state, state.selectedName);

    $('#dual_image_character_consistency_enabled').prop('checked', state.enabled);
    $('#dual_image_character_use_references').prop('checked', state.useReferenceImages);

    const select = $('#dual_image_character_select');
    select.empty();
    for (const name of names) {
        select.append($('<option></option>').val(name).text(name));
    }
    select.val(state.selectedName);

    const profile = state.characters[state.selectedName] || {};
    $('#dual_image_character_profile_enabled').prop('checked', profile.enabled !== false);
    $('#dual_image_character_aliases').val(profile.aliases || '');
    $('#dual_image_character_visual_prompt').val(profile.visualPrompt || '');
    $('#dual_image_character_reference').val(profile.referenceImage || '');
    $('#dual_image_character_reference_weight').val(Number(profile.referenceWeight ?? state.referenceWeight ?? defaultSettings.characterConsistency.referenceWeight));
}

function saveCharacterProfileFromInputs() {
    const state = getCharacterConsistencyState();
    const name = String($('#dual_image_character_select').val() || getDefaultCharacterName()).trim();
    if (!name) {
        return;
    }

    const profile = ensureCharacterProfile(state, name);
    profile.enabled = $('#dual_image_character_profile_enabled').prop('checked');
    profile.aliases = String($('#dual_image_character_aliases').val() || '').trim();
    profile.visualPrompt = String($('#dual_image_character_visual_prompt').val() || '').trim();
    profile.referenceImage = String($('#dual_image_character_reference').val() || '').trim();
    profile.referenceWeight = clamp(Number($('#dual_image_character_reference_weight').val()) || defaultSettings.characterConsistency.referenceWeight, 0, 2);
    profile.updatedAt = new Date().toISOString();
    state.selectedName = name;
    state.referenceWeight = profile.referenceWeight;
    saveCharacterConsistencyState(state);
    renderCharacterConsistencySettings();
}

function getCharacterConsistencyState() {
    const existing = chat_metadata[CHAT_METADATA_KEY] || {};
    const state = {
        enabled: existing.enabled ?? settings().characterConsistency.enabledByDefault,
        useReferenceImages: existing.useReferenceImages ?? settings().characterConsistency.useReferenceImagesByDefault,
        referenceWeight: Number(existing.referenceWeight ?? settings().characterConsistency.referenceWeight) || defaultSettings.characterConsistency.referenceWeight,
        selectedName: String(existing.selectedName || getDefaultCharacterName()),
        characters: existing.characters && typeof existing.characters === 'object' ? { ...existing.characters } : {},
    };

    for (const [name, profile] of Object.entries(state.characters)) {
        state.characters[name] = normalizeCharacterProfile(name, profile);
    }

    return state;
}

function saveCharacterConsistencyState(state) {
    chat_metadata[CHAT_METADATA_KEY] = {
        enabled: state.enabled !== false,
        useReferenceImages: state.useReferenceImages !== false,
        referenceWeight: Number(state.referenceWeight) || defaultSettings.characterConsistency.referenceWeight,
        selectedName: String(state.selectedName || getDefaultCharacterName()),
        characters: state.characters || {},
    };
    saveMetadataDebounced();
}

function ensureCharacterProfile(state, name) {
    const profileName = String(name || getDefaultCharacterName()).trim();
    if (!profileName) {
        return null;
    }

    state.characters = state.characters || {};
    state.characters[profileName] = normalizeCharacterProfile(profileName, state.characters[profileName]);
    return state.characters[profileName];
}

function normalizeCharacterProfile(name, profile = {}) {
    return {
        name: String(profile.name || name || '').trim(),
        enabled: profile.enabled !== false,
        aliases: String(profile.aliases || '').trim(),
        visualPrompt: String(profile.visualPrompt || '').trim(),
        referenceImage: String(profile.referenceImage || '').trim(),
        referenceWeight: clamp(Number(profile.referenceWeight) || defaultSettings.characterConsistency.referenceWeight, 0, 2),
        updatedAt: profile.updatedAt || '',
    };
}

function getKnownCharacterNames(state = getCharacterConsistencyState()) {
    const context = getContext();
    const names = new Set();
    const addName = (name) => {
        const value = String(name || '').trim();
        if (value) {
            names.add(value);
        }
    };

    addName(context.name2);
    addName(context.name1);

    if (Array.isArray(context.chat)) {
        for (const message of context.chat.slice(-80)) {
            if (!message?.is_system) {
                addName(message?.name);
            }
        }
    }

    for (const name of Object.keys(state.characters || {})) {
        addName(name);
    }

    return [...names];
}

function getDefaultCharacterName() {
    const context = getContext();
    return String(context.name2 || context.name1 || 'Character').trim();
}

function findLatestGeneratedImagePath() {
    const context = getContext();
    if (!Array.isArray(context.chat)) {
        return '';
    }

    for (let index = context.chat.length - 1; index >= 0; index--) {
        const message = context.chat[index];
        const autoPath = message?.extra?.dual_image_auto?.image_path;
        if (autoPath) {
            return autoPath;
        }

        const media = Array.isArray(message?.extra?.media) ? message.extra.media : [];
        const image = [...media].reverse().find(item => item?.type === MEDIA_TYPE.IMAGE && item?.url);
        if (image?.url) {
            return image.url;
        }
    }

    return '';
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

    const normalizedPrompt = normalizeImagePromptInput(prompt);
    if (!normalizedPrompt) {
        if (showToasts) {
            toastr.warning('没有找到可用的画面提示词。');
        }
        if (options.throwOnError) {
            throw new Error('没有找到可用的画面提示词。');
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

    const decision = decideMode(normalizedPrompt, requestedMode);
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
    const baseImagePrompt = prepareImagePromptForMode(normalizedPrompt, decision.mode);
    const characterConsistency = buildCharacterConsistencyPayload(normalizedPrompt, decision.mode);
    const imagePrompt = applyCharacterConsistencyToPrompt(baseImagePrompt, characterConsistency, decision.mode);
    if (!imagePrompt) {
        const error = new Error('提示词里没有可绘制的可见场景。');
        setStatus(error.message);
        if (showToasts) {
            toastr.warning(error.message, 'Dual Image API');
        }
        if (options.throwOnError) {
            throw error;
        }
        return null;
    }
    const abortController = new AbortController();
    activeAbortController = abortController;
    const imageTarget = getGeneratedImageTarget();
    const imageOutput = getImageOutputOptions();
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
                        prompt: imagePrompt,
                        mode: decision.mode,
                        profile: sanitizeProfile(profile),
                        saveToUserImages: true,
                        saveFolder: imageTarget.folderName,
                        saveFilename: imageTarget.filename,
                        imageOutput,
                        referenceImages: characterConsistency.referenceImages,
                    },
                });

                if (!result?.path && !result?.data) {
                    throw new Error('服务端没有返回图片。');
                }

                const imagePath = result.path || await saveGeneratedImage(result.data, result.format || 'png', normalizedPrompt, imageTarget);
                return { prompt: imagePrompt, imagePath, mode: decision.mode, attempts: attempt, characterConsistency };
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
    const handler = (messageId, source) => {
        scheduleAutoIllustration(messageId, source);
        renderAutoImageControls(messageId);
    };
    const updateHandler = (messageId) => renderAutoImageControls(messageId);
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
    eventSource.on(event_types.MESSAGE_UPDATED, updateHandler);
    eventSource.on(event_types.GENERATION_ENDED, generationEndedHandler);
    eventSource.on(event_types.GENERATION_STOPPED, clearAutoPromptInjection);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        pendingAutoIllustrations.clear();
        clearAutoPromptInjection();
        setTimeout(renderAutoImageControlsForChat, 50);
        setTimeout(renderCharacterConsistencySettings, 50);
    });

    $(document).off('click.dualImageRetry').on('click.dualImageRetry', '.dual_image_retry_button', async function () {
        const button = $(this);
        const messageId = Number($(this).closest('.mes').attr('mesid'));
        button.prop('disabled', true).addClass('is-loading');
        try {
            await retryAutoImageForMessage(messageId);
        } finally {
            button.prop('disabled', false).removeClass('is-loading');
        }
    });

    setTimeout(renderAutoImageControlsForChat, 50);
}

function renderAutoImageControls(messageId) {
    const numericMessageId = Number(messageId);
    if (!Number.isInteger(numericMessageId) || numericMessageId < 0) {
        return;
    }

    const context = getContext();
    const message = context.chat?.[numericMessageId];
    const messageElement = $(`#chat .mes[mesid="${numericMessageId}"]`);
    if (!messageElement.length) {
        return;
    }

    messageElement.find('.dual-image-retry-panel').remove();

    const metadata = message?.extra?.dual_image_auto;
    const prompt = cleanImagePrompt(metadata?.prompt || '');
    if (!metadata?.failed || metadata?.pending || pendingAutoIllustrations.has(numericMessageId) || !prompt) {
        return;
    }

    const panel = $('<div class="dual-image-retry-panel"></div>');
    const errorText = truncateDisplayText(metadata.error || '配图生成失败', 80);
    const hint = $('<span class="dual-image-retry-text"></span>').text(errorText ? `配图失败：${errorText}` : '配图生成失败');
    const button = $('<button type="button" class="menu_button dual_image_retry_button" title="使用同一提示词重新生图"></button>');
    button.append('<i class="fa-solid fa-rotate-right" aria-hidden="true"></i>');
    button.append(document.createTextNode('重新生图'));

    panel.append(hint, button);

    const textElement = messageElement.find('.mes_text').last();
    if (textElement.length) {
        panel.insertAfter(textElement);
        return;
    }

    const blockElement = messageElement.find('.mes_block').first();
    if (blockElement.length) {
        blockElement.append(panel);
        return;
    }

    messageElement.append(panel);
}

function renderAutoImageControlsForChat() {
    const context = getContext();
    if (!Array.isArray(context.chat)) {
        return;
    }

    context.chat.forEach((_message, index) => renderAutoImageControls(index));
}

function injectAutoPromptInstruction(type, generationData = {}, dryRun = false) {
    if (!shouldInjectAutoPromptInstruction(type, generationData, dryRun)) {
        clearAutoPromptInjection();
        return;
    }

    const context = getContext();
    const instruction = renderTextTemplate(
        getAutoInstructionTemplate(),
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

function getAutoInstructionTemplate() {
    const template = String(settings().autoIllustration.instructionTemplate || defaultAutoInstructionTemplate);
    const extraRules = [];

    if (!template.includes('DUAL_IMAGE_PLACEHOLDER')) {
        extraRules.push(`Additional required placeholder rule:
- If you output a non-SKIP image prompt marker, put this exact placeholder immediately before it:
<!--DUAL_IMAGE_PLACEHOLDER-->正在生成配图...<!--/DUAL_IMAGE_PLACEHOLDER-->`);
    }

    extraRules.push(autoInstructionPromptGuardrail);

    return [template, ...extraRules].filter(Boolean).join('\n\n');
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
            .finally(() => {
                pendingAutoIllustrations.delete(numericMessageId);
                renderAutoImageControls(numericMessageId);
            });
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
        prompt = buildFallbackPromptFromMessage(message, messageId);
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
            failed: false,
            mode: generated.mode,
            prompt: generated.prompt,
            prompt_source: promptSource,
            image_path: generated.imagePath,
            attempts: generated.attempts || 1,
            character_names: generated.characterConsistency?.characters?.map(character => character.name) || [],
            reference_images: generated.characterConsistency?.referenceImages || [],
            inserted_at: new Date().toISOString(),
        });
        setStatus(`自动配图完成：${generated.mode.toUpperCase()}`);
        toastr.success('已为 AI 回复插入配图。', 'Dual Image API');
    } catch (error) {
        const retryCount = getRetryCount();
        await replaceAutoImagePlaceholder(messageId, placeholderId, formatAutoImageFailure(error, retryCount, placeholderId), {
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

async function retryAutoImageForMessage(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        toastr.error('找不到要重新生图的消息。', 'Dual Image API');
        return;
    }

    if (pendingAutoIllustrations.has(messageId)) {
        toastr.info('这条消息正在生图中。', 'Dual Image API');
        return;
    }

    const metadata = message.extra?.dual_image_auto || {};
    const prompt = cleanImagePrompt(metadata.prompt) || buildFallbackPromptFromMessage(message, messageId);
    if (!prompt) {
        toastr.error('这条消息没有可复用的生图提示词。', 'Dual Image API');
        return;
    }

    pendingAutoIllustrations.add(messageId);
    const placeholderId = createPlaceholderId(messageId);
    const promptSource = metadata.prompt_source || 'manual_retry';
    const baseText = removePriorAutoImageResult(message.mes, metadata);

    try {
        await ensureAutoImagePlaceholder(messageId, placeholderId, baseText, prompt, promptSource);

        const generated = await createGeneratedImage(prompt, 'auto', {
            showToasts: true,
            abortActive: false,
            statusPrefix: '正在重新配图，使用',
            throwOnError: true,
            onRetry: async ({ attempt, retryCount, error }) => {
                const messageText = `重新配图失败，正在重试 ${attempt}/${retryCount}...`;
                await updateAutoImagePlaceholderText(messageId, placeholderId, messageText, error);
            },
        });

        if (!generated) {
            throw new Error('重新生成未完成。');
        }

        await replaceAutoImagePlaceholder(messageId, placeholderId, formatImageMarkdown(generated.imagePath), {
            done: true,
            failed: false,
            mode: generated.mode,
            prompt: generated.prompt,
            prompt_source: promptSource,
            image_path: generated.imagePath,
            attempts: generated.attempts || 1,
            character_names: generated.characterConsistency?.characters?.map(character => character.name) || [],
            reference_images: generated.characterConsistency?.referenceImages || [],
            retried_at: new Date().toISOString(),
        });
        setStatus(`重新配图完成：${generated.mode.toUpperCase()}`);
        toastr.success('已重新生成配图。', 'Dual Image API');
    } catch (error) {
        const retryCount = getRetryCount();
        await replaceAutoImagePlaceholder(messageId, placeholderId, formatAutoImageFailure(error, retryCount, placeholderId), {
            done: true,
            failed: true,
            prompt,
            prompt_source: promptSource,
            retry_count: retryCount,
            error: error?.message || String(error),
            retried_at: new Date().toISOString(),
        });
        const messageText = error?.message || String(error);
        setStatus(`重新配图失败：${messageText}`);
        toastr.error(messageText, 'Dual Image API');
    } finally {
        pendingAutoIllustrations.delete(messageId);
        renderAutoImageControls(messageId);
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

function getAutoImageFailureRegex(placeholderId) {
    return new RegExp(`<!--\\s*DUAL_IMAGE_FAILURE:\\s*${escapeRegExp(placeholderId)}\\s*-->\\s*[\\s\\S]*?\\s*<!--\\s*\\/DUAL_IMAGE_FAILURE\\s*-->`, 'i');
}

function formatImageMarkdown(imagePath) {
    return `![AI 配图](${encodeMarkdownUrl(imagePath)})`;
}

function formatAutoImageFailure(error, retryCount, placeholderId = '') {
    const message = sanitizeInlineText(error?.message || String(error || '未知错误'));
    const body = `（配图生成失败，已重试 ${retryCount} 次：${message}）`;
    if (!placeholderId) {
        return body;
    }

    return `<!--DUAL_IMAGE_FAILURE:${placeholderId}-->${body}<!--/DUAL_IMAGE_FAILURE-->`;
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

function removePriorAutoImageResult(text, metadata = {}) {
    let output = String(text || '');
    const placeholderId = String(metadata.placeholder_id || '');

    if (placeholderId) {
        output = output
            .replace(getAutoImagePlaceholderRegex(placeholderId), '')
            .replace(getAutoImageFailureRegex(placeholderId), '');
    }

    output = output
        .replace(toGlobalRegex(AUTO_PLACEHOLDER_RE), '')
        .replace(toGlobalRegex(AUTO_FAILURE_RE), '');

    if (metadata.image_path) {
        output = removeMarkdownImageByPath(output, metadata.image_path);
    }

    return output
        .replace(/\n?\s*（配图生成失败，已重试\s*\d+\s*次：[^\n]*）/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

function buildFallbackPromptFromMessage(message, messageId = null) {
    if (settings().autoIllustration?.fallbackToMessage === false) {
        return '';
    }

    const minCharacters = getFallbackSceneMinCharacters();
    const primaryScene = extractVisibleSceneText(message?.mes || '');
    if (isUsableScenePrompt(primaryScene, minCharacters)) {
        return primaryScene.slice(0, MAX_AUTO_SCENE_PROMPT_CHARS);
    }

    const previousUserScene = getPreviousUserSceneText(messageId);
    if (isUsableScenePrompt(previousUserScene, minCharacters)) {
        return previousUserScene.slice(0, MAX_AUTO_SCENE_PROMPT_CHARS);
    }

    return '';
}

function getPreviousUserSceneText(messageId) {
    const context = getContext();
    const numericMessageId = Number(messageId);
    if (!Number.isInteger(numericMessageId) || !Array.isArray(context.chat)) {
        return '';
    }

    const lowerBound = Math.max(0, numericMessageId - 6);
    for (let index = numericMessageId - 1; index >= lowerBound; index--) {
        const candidate = context.chat[index];
        if (!candidate || candidate.is_system || !candidate.is_user) {
            continue;
        }

        const scene = extractVisibleSceneText(candidate.mes || '');
        if (scene) {
            return scene;
        }
    }

    return '';
}

function getFallbackSceneMinCharacters() {
    const configured = Number(settings().autoIllustration?.minCharacters);
    if (!Number.isFinite(configured) || configured <= 0) {
        return 0;
    }

    return Math.min(Math.floor(configured), 24);
}

function isUsableScenePrompt(text, minCharacters = 0) {
    const scene = String(text || '').trim();
    return scene.length >= minCharacters && scoreVisibleSentence(scene) > 0 && !looksLikeInstructionDump(scene);
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

function extractVisibleSceneText(value) {
    const text = stripPromptNoise(value);
    if (!text) {
        return '';
    }

    const sentences = splitSceneSentences(text);
    const selected = [];
    let totalLength = 0;

    for (const sentence of sentences) {
        const cleaned = sanitizeSceneSentence(sentence);
        if (!cleaned || isPromptNoiseSentence(cleaned) || scoreVisibleSentence(cleaned) <= 0) {
            continue;
        }

        selected.push(cleaned);
        totalLength += cleaned.length;
        if (totalLength >= MAX_AUTO_SCENE_PROMPT_CHARS) {
            break;
        }
    }

    return compactSceneText(selected.join(' ')).slice(0, MAX_AUTO_SCENE_PROMPT_CHARS).trim();
}

function stripPromptNoise(value) {
    let output = String(value || '');
    output = removeAutoImagePlaceholders(removeInlineImagePrompt(removeNonVisualBlocks(output)));
    output = output
        .replace(toGlobalRegex(AUTO_FAILURE_RE), ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
        .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/[“”]/g, '"')
        .replace(/\r/g, '\n');

    return output
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !isPromptNoiseLine(line))
        .join('\n');
}

function splitSceneSentences(text) {
    return String(text || '')
        .replace(/([。！？!?；;])\s*/g, '$1\n')
        .split(/\n+/)
        .map(sentence => sentence.trim())
        .filter(Boolean);
}

function sanitizeSceneSentence(sentence) {
    return compactSceneText(String(sentence || '')
        .replace(/^\s*[-*•\d.、)）]+\s*/, '')
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .replace(/^[^：:]{1,24}[：:]\s*/, match => {
            return hasPromptNoiseKeywords(match) ? '' : match;
        }));
}

function compactSceneText(value) {
    return String(value || '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\s+/g, ' ')
        .replace(/\s+([。！？!?，,；;:.])/g, '$1')
        .trim();
}

function isPromptNoiseLine(line) {
    const text = String(line || '').trim();
    if (!text) {
        return true;
    }

    if (hasStrongPromptNoiseKeywords(text)) {
        return true;
    }

    if (/^[-*•]\s*\*\*[^*]{1,40}\*\*\s*[：:]/.test(text)) {
        return true;
    }

    if (/^(好的|收到|明白|明确|接到指令|接下来|下面|以下|根据|用户|系统|指令|要求|规则|注意|总结|分析)\b/.test(text)) {
        return true;
    }

    if (/^【[^】]{1,40}】/.test(text) && hasPromptNoiseKeywords(text)) {
        return true;
    }

    if (/^#{1,6}\s+/.test(text) && hasPromptNoiseKeywords(text)) {
        return true;
    }

    return hasPromptNoiseKeywords(text) && scoreVisibleSentence(text) <= 1;
}

function isPromptNoiseSentence(sentence) {
    const text = String(sentence || '').trim();
    if (!text) {
        return true;
    }

    if (hasStrongPromptNoiseKeywords(text)) {
        return true;
    }

    if (hasPromptNoiseKeywords(text) && scoreVisibleSentence(text) <= 2) {
        return true;
    }

    if (/^(不能|不要|必须|需要|应该|请|规则|要求|注意|总结|分析|视角|文风|剧情|设定)[：:，,]/.test(text)) {
        return true;
    }

    return false;
}

function looksLikeInstructionDump(value) {
    const text = String(value || '');
    if (!text) {
        return false;
    }

    const keywordHits = countPromptNoiseKeywords(text);
    return keywordHits >= 2 || /【[^】]{1,40}】/.test(text) || /Rules for the marker|visible scene only|image-generation prompt/i.test(text);
}

function hasPromptNoiseKeywords(value) {
    return countPromptNoiseKeywords(value) > 0;
}

function hasStrongPromptNoiseKeywords(value) {
    const text = String(value || '').toLowerCase();
    const strongKeywords = [
        '接到指令', '用户的', '用户输入', '用户请求', '基于用户', '系统提示', '开发者指令',
        '角色总结', '核心文风', '情感基调', '主观感受', '非传统写作', '写作要求',
        '视角限制', '全知第三人称', '读者知道', '提示词标记', '隐藏要求', '后续剧情',
        '进行扩写', '剧情发展', '不能写', '不要写', '必须', '需要基于',
        'rules for the marker', 'prompt marker', 'chain-of-thought', 'writing plan',
    ];

    return strongKeywords.some(keyword => text.includes(keyword.toLowerCase()));
}

function countPromptNoiseKeywords(value) {
    const text = String(value || '').toLowerCase();
    const keywords = [
        '角色总结', '核心文风', '情感基调', '主观感受', '非传统写作', '写作', '视角', '读者',
        '用户', '系统', '指令', '要求', '规则', '标记', '提示词', '生图', '分析', '总结',
        '剧情发展', '剧情', '设定', '身份', '人设', '输出', '选项', '解释', '背德', 'ntr',
        '精神肉体', '洗脑', '全知第三人称', '限制', '不能写', '不要写', '必须', '需要',
        'image prompt', 'prompt marker', 'visible scene only', 'rules for the marker', 'analysis',
        'chain-of-thought', 'plot summary', 'writing plan', 'lore', 'json', 'markdown', 'caption',
        'dialogue bubble', 'option list',
    ];

    return keywords.reduce((count, keyword) => text.includes(keyword.toLowerCase()) ? count + 1 : count, 0);
}

function scoreVisibleSentence(value) {
    const text = String(value || '').toLowerCase();
    if (!text) {
        return 0;
    }

    const visualTerms = [
        '站', '坐', '走', '跑', '看', '望', '拿', '捡', '递', '伸手', '低头', '弯腰', '钻', '靠',
        '躺', '跪', '抱', '拉', '推', '打开', '关上', '桌', '椅', '床', '窗', '门', '房间', '餐厅',
        '餐桌', '筷子', '地板', '街', '雨', '雪', '灯', '光', '阴影', '镜头', '特写', '构图',
        '衣', '外套', '衬衫', '裙', '鞋', '制服', '表情', '微笑', '眼神', '脸', '手', '头发',
        '身影', '背景', '场景', '画面', '姿势', '动作', '猫', '狗', '车', '书', '杯',
        'standing', 'sitting', 'walking', 'running', 'looking', 'holding', 'reaching', 'kneeling',
        'leaning', 'lying', 'table', 'chair', 'room', 'window', 'door', 'floor', 'street', 'rain',
        'snow', 'light', 'lighting', 'shadow', 'camera', 'close-up', 'composition', 'wearing',
        'dress', 'shirt', 'coat', 'uniform', 'expression', 'smile', 'eyes', 'hair', 'hands',
        'background', 'scene', 'pose', 'action', 'cat', 'dog', 'car',
    ];

    const hits = visualTerms.reduce((score, term) => text.includes(term) ? score + 1 : score, 0);
    if (hits <= 0) {
        return 0;
    }

    const subjectBonus = /[\u4e00-\u9fa5]{2,6}|[a-z][a-z-]{2,}/i.test(text) ? 1 : 0;
    const lengthPenalty = text.length > 900 ? -2 : 0;
    return hits + subjectBonus + lengthPenalty;
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

function prepareImagePromptForMode(prompt, mode) {
    if (mode === 'nsfw') {
        return cleanImagePrompt(prompt);
    }

    const scenePrompt = softenSfwPromptTerms(cleanImageSceneText(prompt)).slice(0, MAX_AUTO_SCENE_PROMPT_CHARS);
    if (!scenePrompt) {
        return '';
    }

    const context = getContext();
    const userName = context.name1 || '<user>';
    const characterName = context.name2 || 'the main character';
    const partnerRule = scenePrompt.includes(userName) || scenePrompt.includes('<user>')
        ? `If ${userName} is visible, include ${characterName} or another visible scene partner in the same frame; do not make a solo ${userName} portrait.`
        : `Avoid a solo portrait of ${userName}; show ${characterName} or another visible scene partner when the scene involves the user.`;

    return [
        scenePrompt,
        'safe-for-work, fully clothed, non-explicit, natural scene, no nudity, no sexual content, no fetish framing, no exposed intimate body parts',
        partnerRule,
        'visible subjects, clear action, setting, mood, clothing, lighting, camera framing',
        'no dialogue, no captions, no UI text, no watermark, no lore notes, no rule text, no analysis',
    ].filter(Boolean).join(', ');
}

function buildCharacterConsistencyPayload(scenePrompt, mode) {
    const state = getCharacterConsistencyState();
    if (!state.enabled) {
        return { characters: [], referenceImages: [] };
    }

    const profiles = getMatchedCharacterProfiles(scenePrompt, state);
    const characters = profiles.map(profile => {
        const visualPrompt = mode === 'sfw'
            ? softenSfwPromptTerms(cleanImageSceneText(profile.visualPrompt) || profile.visualPrompt)
            : cleanImagePrompt(profile.visualPrompt) || String(profile.visualPrompt || '').trim();
        return {
            name: profile.name,
            visualPrompt,
            referenceImage: String(profile.referenceImage || '').trim(),
            referenceWeight: clamp(Number(profile.referenceWeight) || state.referenceWeight || defaultSettings.characterConsistency.referenceWeight, 0, 2),
        };
    }).filter(profile => profile.visualPrompt || profile.referenceImage);

    const referenceImages = state.useReferenceImages
        ? characters
            .filter(profile => profile.referenceImage)
            .map(profile => ({
                name: profile.name,
                url: profile.referenceImage,
                weight: profile.referenceWeight,
            }))
        : [];

    return { characters, referenceImages };
}

function applyCharacterConsistencyToPrompt(basePrompt, payload, mode) {
    const prompt = String(basePrompt || '').trim();
    if (!prompt || !payload?.characters?.length) {
        return prompt;
    }

    const characterPrompts = payload.characters.map(character => {
        const parts = [
            character.name,
            character.visualPrompt,
            character.referenceImage ? 'match the provided reference image identity' : '',
        ].filter(Boolean);
        return parts.join(': ');
    });

    const identityRule = mode === 'sfw'
        ? 'keep the same face, hairstyle, eye color, body type, outfit identity, and recognizable details across images'
        : 'keep the same character identity, face, hairstyle, body type, outfit identity, and recognizable details across images';

    return [
        prompt,
        `Character consistency: ${characterPrompts.join('; ')}`,
        identityRule,
    ].filter(Boolean).join(', ');
}

function getMatchedCharacterProfiles(scenePrompt, state = getCharacterConsistencyState()) {
    const text = normalizePrompt(scenePrompt);
    const profiles = Object.values(state.characters || {})
        .map(profile => normalizeCharacterProfile(profile.name, profile))
        .filter(profile => profile.enabled !== false && (profile.visualPrompt || profile.referenceImage));
    const matched = profiles.filter(profile => characterProfileMatchesPrompt(profile, text));

    if (matched.length > 0) {
        return matched;
    }

    const defaultName = getDefaultCharacterName();
    const defaultProfile = profiles.find(profile => profile.name === defaultName);
    if (defaultProfile && looksLikeHumanScene(scenePrompt)) {
        return [defaultProfile];
    }

    return [];
}

function characterProfileMatchesPrompt(profile, normalizedPrompt) {
    const names = [profile.name, ...splitCharacterAliases(profile.aliases)].map(normalizePrompt).filter(Boolean);
    return names.some(name => normalizedPrompt.includes(name));
}

function splitCharacterAliases(value) {
    return String(value || '')
        .split(/[,，;；、\n]/)
        .map(alias => alias.trim())
        .filter(Boolean);
}

function looksLikeHumanScene(value) {
    const text = String(value || '').toLowerCase();
    return /人|男|女|她|他|少年|少女|角色|脸|头发|眼睛|衣|手|站|坐|躺|走|抱|person|people|man|woman|girl|boy|face|hair|eyes|wearing|standing|sitting/.test(text);
}

function cleanImageSceneText(value) {
    const visibleScene = extractVisibleSceneText(value);
    if (visibleScene) {
        return visibleScene;
    }

    const fallbackText = cleanMessageText(removeAutoImagePlaceholders(removeInlineImagePrompt(removeNonVisualBlocks(value || ''))))
        .replace(/\b(SKIP|image prompt|prompt|caption)\s*:\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_AUTO_SCENE_PROMPT_CHARS);
    return looksLikeInstructionDump(fallbackText) ? '' : fallbackText;
}

function softenSfwPromptTerms(value) {
    return String(value || '')
        .replace(/\b(nude|naked|topless|bottomless|explicit|pornographic|porn|erotic|sexual|sex)\b/gi, 'non-explicit')
        .replace(/\b(lingerie|underwear|panties|bra)\b/gi, 'modest outfit')
        .replace(/\b(seductive|aroused|orgasm|genitals|breasts?|nipples?)\b/gi, 'dramatic')
        .replace(/\b(ntr|cuckold|affair|cheating|fetish)\b/gi, 'subtle dramatic tension')
        .replace(/未成年|高中生|高二|高一|高三|学生|萝莉|正太/gi, 'young adult')
        .replace(/裸露|裸体|色情|情色|性爱|性交|性器|乳头|胸部特写|胸部|内衣|内裤|没穿内裤|私密|性感|勾引|背德|偷情|刺激|调情|丝袜/gi, '安全得体')
        .trim();
}

function getImageOutputOptions() {
    const mode = String(settings().imageOutputMode || defaultSettings.imageOutputMode);
    return {
        forceJpeg: mode !== 'original',
        jpegQuality: getJpegQuality(),
        maxSide: getMaxImageSide(),
    };
}

function getJpegQuality() {
    const quality = Number(settings().jpegQuality);
    return Number.isFinite(quality) ? clamp(Math.floor(quality), 1, 95) : defaultSettings.jpegQuality;
}

function getMaxImageSide() {
    const maxSide = Number(settings().maxImageSide);
    return Number.isFinite(maxSide) ? clamp(Math.floor(maxSide), 0, 4096) : defaultSettings.maxImageSide;
}

function decideMode(prompt, requestedMode) {
    const normalizedPrompt = normalizePrompt(prompt);
    const hasNsfwSignal = scoreTerms(normalizedPrompt, settings().classifier.nsfwKeywords) > 0;
    const hasMinorSignal = scoreTerms(normalizedPrompt, ['minor', 'child', 'kid', 'underage', 'teen', 'loli', 'shota', 'student', 'high school', 'schoolgirl', 'schoolboy', '未成年', '儿童', '小孩', '幼', '萝莉', '正太', '学生', '高中生', '高一', '高二', '高三']) > 0;
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
    prompt = removeAutoImagePlaceholders(removeInlineImagePrompt(prompt)).trim();

    if (!prompt || isSkipImagePrompt(prompt)) {
        return '';
    }

    if (prompt.split(/\s+/).length <= 3 && prompt.toUpperCase().includes(AUTO_SKIP_TOKEN)) {
        return '';
    }

    if (looksLikeInstructionDump(prompt)) {
        const visibleScene = extractVisibleSceneText(prompt);
        if (visibleScene) {
            return visibleScene.slice(0, MAX_AUTO_SCENE_PROMPT_CHARS);
        }

        return '';
    }

    return prompt.slice(0, 1200);
}

function normalizeImagePromptInput(prompt) {
    const cleaned = cleanImagePrompt(prompt);
    if (!cleaned) {
        return '';
    }

    if (!looksLikeInstructionDump(cleaned)) {
        return cleaned;
    }

    return extractVisibleSceneText(cleaned) || '';
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

function sanitizeInlineText(value) {
    return String(value || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncateDisplayText(value, maxLength) {
    const text = sanitizeInlineText(value);
    if (!text || text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function removeMarkdownImageByPath(text, imagePath) {
    const variants = [...new Set([String(imagePath || ''), encodeMarkdownUrl(imagePath)])]
        .filter(Boolean)
        .map(escapeRegExp);
    if (!variants.length) {
        return text;
    }

    return String(text || '').replace(new RegExp(`!\\[[^\\]]*\\]\\((?:${variants.join('|')})\\)`, 'g'), '');
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
