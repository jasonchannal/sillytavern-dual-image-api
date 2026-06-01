import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const info = {
    id: 'dual-image-api',
    name: 'Dual Image API',
    description: 'Routes SillyTavern image generation requests to separate SFW and NSFW third-party APIs.',
};

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const validModes = new Set(['sfw', 'nsfw']);
const saveableImageFormats = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
let jimpToolsPromise = null;
const mimeExtensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

export async function init(router) {
    router.get('/health', (_request, response) => {
        response.send({ ok: true, plugin: info.id, version: '0.2.7' });
    });

    router.get('/secrets/status', (request, response) => {
        const secrets = readSecrets(request);
        response.send({
            sfwKeyConfigured: Boolean(secrets.sfw),
            nsfwKeyConfigured: Boolean(secrets.nsfw),
        });
    });

    router.post('/secrets', (request, response) => {
        const mode = normalizeMode(request.body?.mode);
        const apiKey = String(request.body?.apiKey || '').trim();

        if (!mode) {
            return response.status(400).send({ error: 'Invalid mode.' });
        }

        const secrets = readSecrets(request);
        if (apiKey) {
            secrets[mode] = apiKey;
        } else {
            delete secrets[mode];
        }

        writeSecrets(request, secrets);
        response.send({ ok: true, mode, configured: Boolean(apiKey) });
    });

    router.delete('/secrets/:mode', (request, response) => {
        const mode = normalizeMode(request.params.mode);
        if (!mode) {
            return response.status(400).send({ error: 'Invalid mode.' });
        }

        const secrets = readSecrets(request);
        delete secrets[mode];
        writeSecrets(request, secrets);
        response.send({ ok: true, mode, configured: false });
    });

    router.post('/test', (request, response) => {
        const mode = normalizeMode(request.body?.mode);
        const profile = request.body?.profile;

        if (!mode) {
            return response.status(400).send({ error: 'Invalid mode.' });
        }

        const validation = validateProfile(profile);
        if (!validation.ok) {
            return response.status(400).send({ error: validation.error });
        }

        const secrets = readSecrets(request);
        response.send({
            ok: true,
            mode,
            keyConfigured: Boolean(secrets[mode]),
            apiType: profile.apiType || 'openai-compatible',
        });
    });

    router.post('/generate', async (request, response) => {
        try {
            const prompt = String(request.body?.prompt || '').trim();
            const mode = normalizeMode(request.body?.mode);
            const profile = request.body?.profile;

            if (!prompt) {
                return response.status(400).send({ error: 'Prompt is required.' });
            }

            if (!mode) {
                return response.status(400).send({ error: 'Invalid mode.' });
            }

            const validation = validateProfile(profile);
            if (!validation.ok) {
                return response.status(400).send({ error: validation.error });
            }

            const secrets = readSecrets(request);
            const apiKey = secrets[mode];
            if (!apiKey) {
                return response.status(400).send({ error: `${mode.toUpperCase()} API key is not configured.` });
            }

            const result = profile.apiType === 'generic-json'
                ? await generateGenericJson(prompt, profile, apiKey)
                : await generateOpenAiCompatible(prompt, profile, apiKey);

            if (request.body?.saveToUserImages) {
                const saved = await saveResultToUserImages(request, result, {
                    folder: request.body?.saveFolder,
                    filename: request.body?.saveFilename,
                    imageOutput: request.body?.imageOutput,
                });

                result.path = saved.path;
                result.filename = saved.filename;
                result.format = saved.format;
                result.data = saved.data;
            }

            response.send(result);
        } catch (error) {
            console.error('[dual-image-api] Generation failed:', redactSecretLikeText(error?.message || String(error)));
            response.status(500).send({ error: toPublicError(error) });
        }
    });
}

function normalizeMode(mode) {
    const normalized = String(mode || '').toLowerCase();
    return validModes.has(normalized) ? normalized : null;
}

function getStorePath(request) {
    const userRoot = request.user?.directories?.root || request.user?.directories?.user || request.user?.directories?.base;
    const dataDirectory = userRoot
        ? path.join(userRoot, 'dual-image-api')
        : path.join(pluginDirectory, '.data');

    fs.mkdirSync(dataDirectory, { recursive: true });
    return path.join(dataDirectory, 'secrets.json');
}

function readSecrets(request) {
    const filePath = getStorePath(request);
    if (!fs.existsSync(filePath)) {
        return {};
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
        return {};
    }
}

function writeSecrets(request, secrets) {
    const filePath = getStorePath(request);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(secrets, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
}

async function saveResultToUserImages(request, result, options = {}) {
    const userImagesDirectory = request.user?.directories?.userImages;
    const userRootDirectory = request.user?.directories?.root;

    if (!userImagesDirectory || !userRootDirectory) {
        throw new Error('SillyTavern user image directory is unavailable.');
    }

    const data = String(result?.data || '').trim();
    if (!data) {
        throw new Error('Generated image data is empty.');
    }

    const folder = sanitizePathSegment(options.folder) || 'DualImage';
    const filenameBase = sanitizePathSegment(removeFileExtensionFromName(String(options.filename || ''))) || `dual-image-${Date.now()}`;
    const imageBuffer = Buffer.from(data, 'base64');
    if (!imageBuffer.length) {
        throw new Error('Generated image data is invalid.');
    }

    const output = await prepareImageForChat(imageBuffer, result?.format, options.imageOutput);
    const filename = `${filenameBase}.${output.format}`;
    const targetDirectory = path.join(userImagesDirectory, folder);
    let targetPath = path.join(targetDirectory, filename);

    if (!isPathUnderDirectory(userImagesDirectory, targetPath)) {
        throw new Error('Invalid image save path.');
    }

    await fs.promises.mkdir(targetDirectory, { recursive: true });
    targetPath = await getUniqueFilePath(targetPath);
    await fs.promises.writeFile(targetPath, new Uint8Array(output.buffer));

    return {
        path: clientRelativePath(userRootDirectory, targetPath),
        filename: path.basename(targetPath),
        format: output.format,
        data: output.buffer.toString('base64'),
    };
}

async function prepareImageForChat(inputBuffer, originalFormat, options = {}) {
    const outputOptions = normalizeImageOutputOptions(options);
    if (!outputOptions.forceJpeg) {
        return {
            buffer: inputBuffer,
            format: normalizeImageFormat(originalFormat),
        };
    }

    const { Jimp, JimpMime } = await loadJimpTools();
    const image = await Jimp.read(inputBuffer);
    const width = Number(image.bitmap?.width) || 0;
    const height = Number(image.bitmap?.height) || 0;
    const maxSide = outputOptions.maxSide;

    if (maxSide > 0 && Math.max(width, height) > maxSide) {
        const ratio = width >= height ? maxSide / width : maxSide / height;
        image.resize({
            w: Math.max(1, Math.round(width * ratio)),
            h: Math.max(1, Math.round(height * ratio)),
        });
    }

    const buffer = await image.getBuffer(JimpMime.jpeg, {
        quality: outputOptions.jpegQuality,
        jpegColorSpace: 'ycbcr',
    });

    return {
        buffer: Buffer.from(buffer),
        format: 'jpg',
    };
}

function normalizeImageOutputOptions(options = {}) {
    const jpegQuality = clampInteger(options.jpegQuality, 1, 95, 82);
    const maxSide = clampInteger(options.maxSide, 0, 4096, 1024);
    return {
        forceJpeg: options.forceJpeg !== false,
        jpegQuality,
        maxSide,
    };
}

async function loadJimpTools() {
    if (!jimpToolsPromise) {
        jimpToolsPromise = (async () => {
            const root = findSillyTavernRoot(pluginDirectory);
            return await import(pathToFileURL(path.join(root, 'src', 'jimp.js')).href);
        })();
    }

    return await jimpToolsPromise;
}

function findSillyTavernRoot(startDirectory) {
    let current = startDirectory;
    while (current && current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'src', 'jimp.js'))) {
            return current;
        }
        current = path.dirname(current);
    }

    throw new Error('SillyTavern Jimp image processor was not found.');
}

function normalizeImageFormat(format) {
    const normalized = String(format || 'png').toLowerCase().replace(/^\./, '');
    const safeFormat = normalized === 'jpeg' ? 'jpg' : normalized;
    return saveableImageFormats.has(safeFormat) ? safeFormat : 'png';
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(number)));
}

function sanitizePathSegment(value) {
    return String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/^\.+/, '')
        .replace(/\.+$/, '')
        .slice(0, 120);
}

function removeFileExtensionFromName(value) {
    return String(value || '').replace(/\.[a-z0-9]{1,8}$/i, '');
}

function clientRelativePath(rootDirectory, targetPath) {
    return path.relative(rootDirectory, targetPath).replace(/\\/g, '/');
}

function isPathUnderDirectory(parentDirectory, targetPath) {
    const relative = path.relative(parentDirectory, targetPath);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function getUniqueFilePath(filePath) {
    if (!fs.existsSync(filePath)) {
        return filePath;
    }

    const extension = path.extname(filePath);
    const base = filePath.slice(0, -extension.length);
    for (let index = 1; index < 1000; index++) {
        const candidate = `${base}-${index}${extension}`;
        if (!fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return `${base}-${Date.now()}${extension}`;
}

function validateProfile(profile) {
    if (!profile || typeof profile !== 'object') {
        return { ok: false, error: 'API profile is missing.' };
    }

    if (!String(profile.baseUrl || '').trim()) {
        return { ok: false, error: 'Base URL is required.' };
    }

    if ((profile.apiType || 'openai-compatible') === 'generic-json') {
        if (!String(profile.resultPath || '').trim()) {
            return { ok: false, error: 'Result field path is required for Generic JSON APIs.' };
        }
        return { ok: true };
    }

    if (!String(profile.model || '').trim()) {
        return { ok: false, error: 'Model is required.' };
    }

    return { ok: true };
}

async function generateOpenAiCompatible(prompt, profile, apiKey) {
    const finalPrompt = buildPrompt(prompt, profile);
    const url = buildUrl(profile.baseUrl, profile.endpoint || '/v1/images/generations');
    const width = Number(profile.width) || 1024;
    const height = Number(profile.height) || 1024;
    const body = {
        model: String(profile.model || '').trim(),
        prompt: finalPrompt,
        n: 1,
        size: `${width}x${height}`,
        response_format: 'b64_json',
    };

    const data = await requestJson(url, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        timeoutMs: Number(profile.timeoutMs) || 120000,
    });

    return await extractImageResult(data, profile.resultPath);
}

async function generateGenericJson(prompt, profile, apiKey) {
    const finalPrompt = buildPrompt(prompt, profile);
    const url = buildUrl(profile.baseUrl, profile.endpoint || '');
    const headers = parseHeaders(profile.headersJson);
    const keyHeader = String(profile.apiKeyHeader || 'Authorization').trim();
    const keyPrefix = String(profile.apiKeyPrefix ?? 'Bearer ');

    if (keyHeader) {
        headers[keyHeader] = `${keyPrefix}${apiKey}`;
    }

    if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
    }

    const bodyText = renderTemplate(String(profile.bodyTemplate || defaultGenericBodyTemplate()), {
        prompt: finalPrompt,
        rawPrompt: prompt,
        negativePrompt: String(profile.negativePrompt || ''),
        model: String(profile.model || ''),
        width: String(Number(profile.width) || 1024),
        height: String(Number(profile.height) || 1024),
        steps: String(Number(profile.steps) || 30),
        cfg: String(Number(profile.cfgScale) || 7),
    });

    const data = await requestJson(url, {
        method: String(profile.method || 'POST').toUpperCase(),
        headers,
        body: bodyText,
        timeoutMs: Number(profile.timeoutMs) || 120000,
    });

    return await extractImageResult(data, profile.resultPath);
}

function buildPrompt(prompt, profile) {
    return [
        String(profile.promptPrefix || '').trim(),
        prompt.trim(),
        String(profile.promptSuffix || '').trim(),
    ].filter(Boolean).join(' ');
}

function buildUrl(baseUrl, endpoint) {
    const base = String(baseUrl || '').trim();
    const suffix = String(endpoint || '').trim();

    if (!base) {
        throw new Error('Base URL is required.');
    }

    if (!suffix) {
        return base;
    }

    return new URL(suffix, base.endsWith('/') ? base : `${base}/`).toString();
}

async function requestJson(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
        const result = await fetch(url, {
            method: options.method,
            headers: options.headers,
            body: options.body,
            signal: controller.signal,
        });

        const text = await result.text();
        if (!result.ok) {
            throw new Error(`Image API returned ${result.status}: ${redactSecretLikeText(text).slice(0, 500)}`);
        }

        try {
            return JSON.parse(text);
        } catch {
            throw new Error('Image API did not return valid JSON.');
        }
    } finally {
        clearTimeout(timeout);
    }
}

async function extractImageResult(data, preferredPath) {
    const candidates = [
        preferredPath,
        'data.0.b64_json',
        'data.0.url',
        'image',
        'images.0',
        'images.0.url',
        'output.0',
        'result.image',
    ].filter(Boolean);

    for (const candidate of candidates) {
        const value = getByPath(data, candidate);
        const normalized = await normalizeImageValue(value);
        if (normalized) {
            return normalized;
        }
    }

    throw new Error('Image API returned no usable image.');
}

async function normalizeImageValue(value) {
    if (!value) {
        return null;
    }

    if (typeof value === 'object') {
        return normalizeImageValue(value.b64_json || value.base64 || value.image || value.url);
    }

    const text = String(value).trim();
    const dataUrlMatch = /^data:(image\/[^;]+);base64,(.+)$/i.exec(text);
    if (dataUrlMatch) {
        return {
            data: dataUrlMatch[2],
            format: mimeExtensions[dataUrlMatch[1].toLowerCase()] || 'png',
        };
    }

    if (/^https?:\/\//i.test(text)) {
        return await downloadImage(text);
    }

    if (/^[a-z0-9+/=\r\n]+$/i.test(text) && text.length > 100) {
        return { data: text.replace(/\s+/g, ''), format: 'png' };
    }

    return null;
}

async function downloadImage(url) {
    const result = await fetch(url, { headers: { Accept: 'image/*' } });
    if (!result.ok) {
        throw new Error(`Failed to download generated image: ${result.status}`);
    }

    const contentType = String(result.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('image/')) {
        throw new Error('Generated image URL did not return an image.');
    }

    const buffer = Buffer.from(await result.arrayBuffer());
    return {
        data: buffer.toString('base64'),
        format: mimeExtensions[contentType] || 'png',
    };
}

function getByPath(value, dotPath) {
    if (!dotPath) {
        return undefined;
    }

    return String(dotPath).split('.').reduce((current, key) => {
        if (current === undefined || current === null) {
            return undefined;
        }
        return current[key];
    }, value);
}

function parseHeaders(value) {
    if (!value) {
        return {};
    }

    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return Object.fromEntries(Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]));
    } catch {
        throw new Error('Headers must be valid JSON.');
    }
}

function renderTemplate(template, variables) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
        return escapeTemplateValue(variables[key] ?? '');
    });
}

function escapeTemplateValue(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

function defaultGenericBodyTemplate() {
    return JSON.stringify({
        model: '{{model}}',
        prompt: '{{prompt}}',
        negative_prompt: '{{negativePrompt}}',
        width: '{{width}}',
        height: '{{height}}',
        steps: '{{steps}}',
        cfg_scale: '{{cfg}}',
    }, null, 2);
}

function redactSecretLikeText(text) {
    return String(text || '')
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/("api[_-]?key"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
        .replace(/(authorization"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

function toPublicError(error) {
    if (error?.name === 'AbortError') {
        return 'Image API request timed out.';
    }

    const message = redactSecretLikeText(error?.message || String(error));
    return message.length > 600 ? `${message.slice(0, 600)}...` : message;
}
