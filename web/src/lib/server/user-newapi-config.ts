import type { AuthSettings, LogicalModel, LogicalModelCapability, SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { inferModelCapability, normalizeModelId } from "@/lib/model-capability";
import { buildModelsUrl, modelCapabilitiesRecord, parseModelCatalog } from "@/lib/server/admin-model-catalog";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "@/lib/server/database";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { decryptSecretValue, encryptSecretValue } from "@/lib/server/secret-crypto";

export const USER_NEWAPI_CHANNEL_ID = "user-newapi";
const MAX_MODEL_CATALOG_BYTES = 2 * 1024 * 1024;

type StoredUserNewApiConfig = {
    user_id: string;
    base_url: string;
    api_key_ciphertext: string;
    models: unknown;
    model_capabilities: unknown;
    credentials: unknown;
    enabled: boolean;
    updated_at: Date | string;
};

export type UserNewApiCredentialCapability = "text" | "image" | "video";
export type UserNewApiCredentialInput = { baseUrl: unknown; apiKey: unknown };
type StoredUserNewApiCredential = { baseUrl: string; apiKeyCiphertext: string; models: unknown; modelCapabilities: unknown; enabled: boolean };
type StoredUserNewApiCredentials = Partial<Record<UserNewApiCredentialCapability, StoredUserNewApiCredential>>;

export type PublicUserNewApiConfig = {
    baseUrl: string;
    hasApiKey: boolean;
    enabled: boolean;
    models: string[];
    modelCapabilities: Record<string, LogicalModelCapability>;
    updatedAt?: string;
    credentials: Record<UserNewApiCredentialCapability, { baseUrl: string; hasApiKey: boolean; enabled: boolean; models: string[]; modelCapabilities: Record<string, LogicalModelCapability> }>;
};

export async function getPublicUserNewApiConfig(userId: string): Promise<PublicUserNewApiConfig | null> {
    const stored = await readStoredUserNewApiConfig(userId);
    if (!stored) return null;
    return {
        baseUrl: stored.base_url,
        hasApiKey: Boolean(stored.api_key_ciphertext),
        enabled: stored.enabled,
        models: normalizeModels(stored.models),
        modelCapabilities: normalizeCapabilities(stored.model_capabilities),
        updatedAt: new Date(stored.updated_at).toISOString(),
        credentials: publicCredentials(stored),
    };
}

export async function saveUserNewApiConfig(userId: string, input: { baseUrl?: unknown; apiKey?: unknown; credentials?: Partial<Record<UserNewApiCredentialCapability, UserNewApiCredentialInput>> }) {
    assertPostgresUserConfigSupported();
    await ensurePostgresSchema();
    await assertNoActiveGenerationTasks(userId);
    const existing = await readStoredUserNewApiConfig(userId);
    const requestedScopes = input.credentials && Object.keys(input.credentials).length > 0;
    const credentials = requestedScopes ? await buildScopedCredentials(existing, input.credentials || {}) : normalizeStoredCredentials(existing?.credentials);
    const legacy = requestedScopes ? legacyCredentialFromScopes(credentials) : await buildLegacyCredential(existing, input.baseUrl, input.apiKey);
    const credentialsJson = JSON.stringify(credentials);
    await postgresQuery(
        `INSERT INTO user_newapi_configs (user_id, base_url, api_key_ciphertext, models, model_capabilities, credentials, enabled, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, true, now())
         ON CONFLICT (user_id) DO UPDATE SET
             base_url = EXCLUDED.base_url,
             api_key_ciphertext = EXCLUDED.api_key_ciphertext,
             models = EXCLUDED.models,
             model_capabilities = EXCLUDED.model_capabilities,
             credentials = EXCLUDED.credentials,
             enabled = true,
             updated_at = now()`,
        [userId, legacy.baseUrl, encryptSecretValue(legacy.apiKey), JSON.stringify(legacy.models), JSON.stringify(legacy.modelCapabilities), credentialsJson],
    );
    return getPublicUserNewApiConfig(userId);
}

export async function deleteUserNewApiConfig(userId: string) {
    assertPostgresUserConfigSupported();
    await ensurePostgresSchema();
    await assertNoActiveGenerationTasks(userId);
    await postgresQuery("DELETE FROM user_newapi_configs WHERE user_id = $1", [userId]);
}

export async function getUserGenerationSettings(settings: AuthSettings, userId: string): Promise<AuthSettings> {
    if (!settings.allowUserApiConfig) return settings;
    const channel = await getUserNewApiChannel(userId);
    if (!channel) return settings;
    return mergeUserGenerationSettings(settings, channel);
}

export function mergeUserGenerationSettings(settings: AuthSettings, channel: SystemModelChannel): AuthSettings {
    const capabilities = channel.advancedConfig?.modelCapabilities || {};
    const personalModels = channel.models.map((model): LogicalModel => {
        const capability = capabilities[normalizeModelId(model)] || inferModelCapability(model);
        return {
            id: model,
            name: model,
            capability,
            enabled: true,
            bindings: [{ id: `${USER_NEWAPI_CHANNEL_ID}:${normalizeModelId(model)}`, channelId: USER_NEWAPI_CHANNEL_ID, upstreamModel: model, enabled: true, priority: 1 }],
        };
    });
    const personalCapabilities = new Set(personalModels.map((model) => model.capability));
    const logicalModels = [...settings.logicalModels.filter((model) => !personalCapabilities.has(model.capability)), ...personalModels];
    const defaultModels = { ...settings.defaultModels };
    for (const capability of personalCapabilities) {
        const model = personalModels.find((candidate) => candidate.capability === capability);
        const defaultKey = capability === "text" ? "textModel" : capability === "image" ? "imageModel" : capability === "video" ? "videoModel" : "audioModel";
        if (model) defaultModels[defaultKey] = model.id;
    }
    return {
        ...settings,
        systemChannels: [...settings.systemChannels.filter((item) => !isUserNewApiChannel(item.id)), channel],
        logicalModels,
        defaultModels,
    };
}

export function isUserNewApiChannel(channelId: string) {
    return channelId === USER_NEWAPI_CHANNEL_ID || /^user-newapi-(text|image|video)$/.test(channelId);
}

export async function getUserNewApiCredential(userId: string, capability: LogicalModelCapability) {
    const stored = await readStoredUserNewApiConfig(userId);
    if (!stored?.enabled) return null;
    const scoped = normalizeStoredCredentials(stored.credentials);
    const scope: UserNewApiCredentialCapability = capability === "audio" ? "text" : capability;
    const selected = scoped[scope];
    const baseUrl = selected?.baseUrl || stored.base_url;
    const apiKey = decryptStoredKey(selected?.apiKeyCiphertext) || decryptStoredKey(stored.api_key_ciphertext);
    return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

export async function getUserNewApiChannel(userId: string): Promise<SystemModelChannel | null> {
    const stored = await readStoredUserNewApiConfig(userId);
    if (!stored?.enabled || !stored.api_key_ciphertext) return null;
    const models = normalizeModels(stored.models);
    if (!models.length) return null;
    let apiKey = "";
    try {
        apiKey = decryptSecretValue(stored.api_key_ciphertext);
    } catch {
        return null;
    }
    if (!apiKey) return null;
    const scoped = normalizeStoredCredentials(stored.credentials);
    const scopedModels = Object.entries(scoped).flatMap(([scope, credential]) => {
        const capability = scope as UserNewApiCredentialCapability;
        const models = normalizeModels(credential.models);
        const capabilities = normalizeCapabilities(credential.modelCapabilities);
        return models.filter((model) => {
            const modelCapability = capabilities[normalizeModelId(model)] || inferModelCapability(model);
            return modelCapability === capability || (capability === "text" && modelCapability === "audio");
        });
    });
    const channelModels = Array.from(new Set(scopedModels.length ? scopedModels : models));
    const scopedCapabilities = Object.values(scoped).reduce<Record<string, LogicalModelCapability>>((all, credential) => ({ ...all, ...normalizeCapabilities(credential.modelCapabilities) }), {});
    const legacyCapabilities = normalizeCapabilities(stored.model_capabilities);
    const channelCapabilities = Object.fromEntries(channelModels.map((model) => [normalizeModelId(model), scopedCapabilities[normalizeModelId(model)] || legacyCapabilities[normalizeModelId(model)] || inferModelCapability(model)]));
    return applyChannelProtocol(
        {
            id: USER_NEWAPI_CHANNEL_ID,
            name: "我的 New API",
            baseUrl: stored.base_url,
            apiKey,
            apiFormat: "openai",
            models: channelModels,
            enabled: true,
            advancedConfig: {
                protocol: "newapi",
                textModel: "",
                imageModel: "",
                videoModel: "",
                createPath: "",
                queryPath: "",
                requestTemplate: "",
                resultField: "",
                statusField: "",
                durationRange: "",
                referenceRule: "",
                supportsReferenceImage: true,
                supportsReferenceVideo: false,
                supportsReferenceAudio: false,
                modelCapabilities: channelCapabilities,
            },
        },
        "newapi",
    );
}

export function normalizeNewApiBaseUrl(value: unknown) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw.length > 500) throw new UserNewApiConfigError("New API URL 无效", 400);
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new UserNewApiConfigError("New API URL 无效", 400);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new UserNewApiConfigError("New API URL 必须是无凭据、无参数的 HTTPS 地址", 400);
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/models$/i, "") || "/";
    return url.toString().replace(/\/$/, "");
}

async function fetchNewApiModelCatalog(baseUrl: string, apiKey: string) {
    let response: Response;
    try {
        response = await fetchSafeOutbound(
            buildModelsUrl(baseUrl, "openai"),
            { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60_000) },
            { allowCredentials: false, allowPrivateUpstreams: false },
        );
    } catch {
        throw new UserNewApiConfigError("无法连接 New API，请检查 URL 和网络", 502);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_MODEL_CATALOG_BYTES) throw new UserNewApiConfigError("New API 模型列表过大", 502);
    const payloadBytes = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (payloadBytes.byteLength > MAX_MODEL_CATALOG_BYTES) throw new UserNewApiConfigError("New API 模型列表过大", 502);
    let payload: unknown;
    try {
        payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown;
    } catch {
        throw new UserNewApiConfigError("New API 模型列表格式无效", 502);
    }
    if (!response.ok) throw new UserNewApiConfigError(response.status === 401 || response.status === 403 ? "New API Key 无效或无权访问模型" : "New API 模型列表读取失败", 502);
    const catalog = parseModelCatalog(payload, "provider", "newapi");
    if (!catalog.length) throw new UserNewApiConfigError("New API 未返回可用模型", 502);
    return catalog;
}

async function readStoredUserNewApiConfig(userId: string) {
    if (getDatabaseProvider() !== "postgres") return null;
    await ensurePostgresSchema();
    const response = await postgresQuery<StoredUserNewApiConfig>(
        `SELECT user_id, base_url, api_key_ciphertext, models, model_capabilities, credentials, enabled, updated_at
         FROM user_newapi_configs WHERE user_id = $1 LIMIT 1`,
        [userId],
    );
    return response.rows[0] || null;
}

async function buildLegacyCredential(existing: StoredUserNewApiConfig | null, baseUrlValue: unknown, apiKeyValue: unknown) {
    const baseUrl = normalizeNewApiBaseUrl(baseUrlValue);
    const providedApiKey = normalizeApiKey(apiKeyValue);
    const apiKey = providedApiKey || decryptStoredKey(existing?.api_key_ciphertext);
    if (!apiKey) throw new UserNewApiConfigError("请填写 New API Key", 400);
    const catalog = await fetchNewApiModelCatalog(baseUrl, apiKey);
    return { baseUrl, apiKey, models: catalog.map((entry) => entry.id), modelCapabilities: modelCapabilitiesRecord(catalog) };
}

async function buildScopedCredentials(existing: StoredUserNewApiConfig | null, requested: Partial<Record<UserNewApiCredentialCapability, UserNewApiCredentialInput>>) {
    const previous = normalizeStoredCredentials(existing?.credentials);
    const legacyKey = decryptStoredKey(existing?.api_key_ciphertext);
    const scopes = {} as StoredUserNewApiCredentials;
    for (const capability of ["text", "image", "video"] as const) {
        const input = requested[capability];
        const old = previous[capability];
        if (!input && !old && !existing?.base_url) continue;
        const baseUrl = normalizeNewApiBaseUrl(input?.baseUrl ?? old?.baseUrl ?? existing?.base_url);
        const apiKey = normalizeApiKey(input?.apiKey) || decryptStoredKey(old?.apiKeyCiphertext) || legacyKey;
        if (!apiKey) throw new UserNewApiConfigError(`请填写${capabilityLabel(capability)} New API Key`, 400);
        const catalog = await fetchNewApiModelCatalog(baseUrl, apiKey);
        scopes[capability] = { baseUrl, apiKeyCiphertext: encryptSecretValue(apiKey), models: catalog.map((entry) => entry.id), modelCapabilities: modelCapabilitiesRecord(catalog), enabled: true };
    }
    if (!Object.keys(scopes).length) throw new UserNewApiConfigError("请至少配置一个 New API 凭据", 400);
    return scopes;
}

function legacyCredentialFromScopes(credentials: StoredUserNewApiCredentials) {
    const credential = credentials.text || credentials.image || credentials.video;
    if (!credential) throw new UserNewApiConfigError("请至少配置一个 New API 凭据", 400);
    return { baseUrl: credential.baseUrl, apiKey: decryptStoredKey(credential.apiKeyCiphertext) || "", models: normalizeModels(credential.models), modelCapabilities: normalizeCapabilities(credential.modelCapabilities) };
}

function decryptStoredKey(ciphertext: string | undefined) {
    if (!ciphertext) return "";
    try {
        return decryptSecretValue(ciphertext);
    } catch {
        return "";
    }
}

function normalizeStoredCredentials(value: unknown): StoredUserNewApiCredentials {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output: StoredUserNewApiCredentials = {};
    for (const capability of ["text", "image", "video"] as const) {
        const item = (value as Record<string, unknown>)[capability];
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.baseUrl !== "string" || typeof record.apiKeyCiphertext !== "string") continue;
        output[capability] = { baseUrl: record.baseUrl, apiKeyCiphertext: record.apiKeyCiphertext, models: record.models, modelCapabilities: record.modelCapabilities, enabled: record.enabled !== false };
    }
    return output;
}

function publicCredentials(stored: StoredUserNewApiConfig) {
    const scoped = normalizeStoredCredentials(stored.credentials);
    const legacy = { baseUrl: stored.base_url, hasApiKey: Boolean(stored.api_key_ciphertext), enabled: stored.enabled, models: normalizeModels(stored.models), modelCapabilities: normalizeCapabilities(stored.model_capabilities) };
    return Object.fromEntries(
        (["text", "image", "video"] as const).map((capability) => {
            const item = scoped[capability];
            return [capability, item ? { baseUrl: item.baseUrl, hasApiKey: Boolean(item.apiKeyCiphertext), enabled: item.enabled, models: normalizeModels(item.models), modelCapabilities: normalizeCapabilities(item.modelCapabilities) } : legacy];
        }),
    ) as PublicUserNewApiConfig["credentials"];
}

function capabilityLabel(capability: UserNewApiCredentialCapability) {
    return capability === "text" ? "文本" : capability === "image" ? "图片" : "视频";
}

async function assertNoActiveGenerationTasks(userId: string) {
    const response = await postgresQuery<{ active: boolean }>(
        `SELECT EXISTS(
             SELECT 1 FROM generation_tasks
             WHERE user_id = $1 AND (status IN ('pending', 'running') OR (status = 'cancelled' AND execution_phase IN ('cancel_requested', 'cancel_polling')))
         ) AS active`,
        [userId],
    );
    if (response.rows[0]?.active) throw new UserNewApiConfigError("存在未完成的生成任务，请在任务结束后修改接口配置", 409);
}

function normalizeApiKey(value: unknown) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw new UserNewApiConfigError("New API Key 无效", 400);
    const apiKey = value.trim();
    if (!apiKey || apiKey.length > 4000 || /[\r\n\0]/.test(apiKey)) throw new UserNewApiConfigError("New API Key 无效", 400);
    return apiKey;
}

function normalizeModels(value: unknown) {
    if (!Array.isArray(value)) return [];
    return Array.from(
        new Set(
            value
                .filter((model): model is string => typeof model === "string")
                .map((model) => model.trim())
                .filter(Boolean),
        ),
    ).slice(0, 5000);
}

function normalizeCapabilities(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).flatMap(([model, capability]) => (capability === "text" || capability === "image" || capability === "video" || capability === "audio" ? [[normalizeModelId(model), capability]] : [])),
    ) as Record<string, LogicalModelCapability>;
}

function assertPostgresUserConfigSupported() {
    if (getDatabaseProvider() !== "postgres") throw new UserNewApiConfigError("当前存储模式不支持用户接口配置", 409);
}

export class UserNewApiConfigError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
