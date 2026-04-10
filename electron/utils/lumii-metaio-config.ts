/**
 * Metaio / AINO bridge 默认值与请求头 — 与 openclaw-lumii-plugin `src/auth/metaio-config.ts` 对齐。
 */

export const DEFAULT_METAIO_BASE = 'https://core.metaio.cc';

/** 与 AINO-server `/api/lumii/metaio/*` 一致 */
export const DEFAULT_METAIO_LOGIN_PATH = '/api/lumii/metaio/auth/login';
export const DEFAULT_METAIO_QR_SESSION_PATH = '/api/lumii/metaio/auth/qrcode/session';
export const DEFAULT_METAIO_QR_STATUS_PATH =
    '/api/lumii/metaio/auth/qrcode/status?sessionKey={sessionKey}';

export function envOrFile(envKey: string, dev: Record<string, string> | null): string {
    const e = process.env[envKey]?.trim();
    if (e) return e;
    return dev?.[envKey]?.trim() ?? '';
}

export function flagEnabled(envKey: string, dev: Record<string, string> | null): boolean {
    return process.env[envKey] === '1' || dev?.[envKey] === '1';
}

function metaioAuthExplicitlyDisabled(dev: Record<string, string> | null): boolean {
    const v = envOrFile('METAIO_AUTH', dev)?.trim().toLowerCase();
    return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * 与插件 `resolveMetaioBaseUrl` 一致；`METAIO_AUTH=0` 时返回空串。
 */
export function resolveMetaioBaseUrl(dev: Record<string, string> | null): string {
    const explicit = envOrFile('METAIO_BASE_URL', dev)?.trim();
    if (explicit) return explicit.replace(/\/$/, '');

    const ossFromApi = envOrFile('METAIO_OSS_FROM_API', dev)?.trim();
    if (ossFromApi && /^https?:\/\//i.test(ossFromApi)) return ossFromApi.replace(/\/$/, '');
    if (ossFromApi === '1' || flagEnabled('METAIO_OSS_FROM_API', dev)) return DEFAULT_METAIO_BASE;

    if (flagEnabled('METAIO_AUTH', dev)) return DEFAULT_METAIO_BASE;
    if (metaioAuthExplicitlyDisabled(dev)) return '';
    return DEFAULT_METAIO_BASE;
}

/** 未配置 env 时与 openclaw-lumii-plugin 相同的默认 AINO application id */
export const LUMII_PLUGIN_DEFAULT_APPLICATION_ID = 'd3bdefc5-3d7c-4113-adbb-f4dae5d92095';

function isApplicationUuid(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

/**
 * 与 AINO `application_users.application_id`（applications 表 UUID）一致。
 * env 优先于 dev-config；若值为 dev-app、数字等非 UUID（常见于旧配置），回退 {@link LUMII_PLUGIN_DEFAULT_APPLICATION_ID}。
 */
export function metaioBridgeApplicationId(dev: Record<string, string> | null): string {
    const raw =
        envOrFile('METAIO_X_APPLICATION_ID', dev)?.trim() ||
        envOrFile('LUMII_PLUGIN_APPLICATION_ID', dev)?.trim() ||
        envOrFile('LUMII_APPLICATION_ID', dev)?.trim() ||
        '';
    if (raw && isApplicationUuid(raw)) return raw;
    return LUMII_PLUGIN_DEFAULT_APPLICATION_ID;
}

export function mergeMetaioBridgeHeaders(
    dev: Record<string, string> | null,
    headers: Record<string, string>,
): Record<string, string> {
    return { ...headers, 'x-application-id': metaioBridgeApplicationId(dev) };
}

export function metaioLoginPath(dev: Record<string, string> | null): string {
    return (
        envOrFile('METAIO_AUTH_LOGIN_PATH', dev)?.trim() ||
        envOrFile('METAIO_LOGIN_PATH', dev)?.trim() ||
        DEFAULT_METAIO_LOGIN_PATH
    );
}

export function metaioQrStartPath(dev: Record<string, string> | null): string {
    return envOrFile('METAIO_QR_START_PATH', dev)?.trim() || DEFAULT_METAIO_QR_SESSION_PATH;
}

export function metaioQrStatusPathTemplate(dev: Record<string, string> | null): string {
    return envOrFile('METAIO_QR_STATUS_PATH', dev)?.trim() || DEFAULT_METAIO_QR_STATUS_PATH;
}
