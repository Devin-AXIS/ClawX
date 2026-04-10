/**
 * One-shot Lumii password login check for Settings credential validation.
 * Aligns with lumii-qr-login base URL + JSON envelope rules.
 *
 * Successful login response shape (example):
 * `{ "code": 200, "msg": "Success", "data": { "token": "<jwt>", "info": { "uid": number, "type": string } } }`
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    envOrFile,
    mergeMetaioBridgeHeaders,
    metaioLoginPath,
    resolveMetaioBaseUrl,
} from './lumii-metaio-config';
import {
    extractApplicationIdFromMetaioEnvelope,
    extractMetaioDisplayNameFromEnvelope,
    extractMetaioUidFromLoginResponse,
} from './lumii-metaio-uid';
import { proxyAwareFetch } from './proxy-fetch';

function resolveOpenclawStateDir(): string {
    const o = process.env.OPENCLAW_STATE_DIR?.trim();
    if (o) return o;
    return join(homedir(), '.openclaw');
}

function lumiiDevConfigPath(): string {
    const override = process.env.LUMII_OPENCLAW_LUMII_DEV_CONFIG?.trim();
    if (override) return override;
    return join(resolveOpenclawStateDir(), 'openclaw-lumii', 'dev-config.json');
}

function readLumiiDevConfigFile(): Record<string, string> | null {
    try {
        const p = lumiiDevConfigPath();
        if (!existsSync(p)) return null;
        const raw = readFileSync(p, 'utf-8');
        const j = JSON.parse(raw) as unknown;
        if (!j || typeof j !== 'object' || j === null) return null;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
            if (typeof v === 'string' && v.trim()) out[k] = v.trim();
            else if (v === true || v === 1) out[k] = '1';
        }
        return Object.keys(out).length > 0 ? out : null;
    } catch {
        return null;
    }
}

/**
 * JSON body keys for POST login. Override when the API expects e.g. `account` / `pwd`
 * instead of `username` / `password`.
 * Env or ~/.openclaw/openclaw-lumii/dev-config.json: METAIO_LOGIN_USERNAME_FIELD, METAIO_LOGIN_PASSWORD_FIELD.
 */
function metaioLoginBodyKeys(dev: Record<string, string> | null): { userKey: string; passKey: string } {
    const userKey = envOrFile('METAIO_LOGIN_USERNAME_FIELD', dev)?.trim() || 'username';
    const passKey = envOrFile('METAIO_LOGIN_PASSWORD_FIELD', dev)?.trim() || 'password';
    return { userKey, passKey };
}

function buildMetaioLoginJsonBody(
    dev: Record<string, string> | null,
    user: string,
    password: string,
): Record<string, string> {
    const { userKey, passKey } = metaioLoginBodyKeys(dev);
    return { [userKey]: user, [passKey]: password };
}

function extractTokenFromLoginEnvelope(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const o = body as Record<string, unknown>;
    const data =
        o.data && typeof o.data === 'object' && o.data !== null ? (o.data as Record<string, unknown>) : null;
    const t = data?.token ?? o.token ?? data?.accessToken ?? o.accessToken;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
}

/** Same as lumii-qr-login `assertMetaioEnvelope`. */
function assertMetaioEnvelope(body: unknown): void {
    if (!body || typeof body !== 'object') return;
    const r = body as Record<string, unknown>;
    if (!('code' in r)) return;
    const code = r.code;
    const ok = code === 200 || code === '200' || code === 0 || code === '0';
    if (ok) return;
    const msg = typeof r.msg === 'string' ? r.msg : typeof r.message === 'string' ? r.message : JSON.stringify(code);
    throw new Error(`Lumii API: ${msg}`);
}

/**
 * Returns whether Lumii login accepts this phone number/password (login API).
 * Does not persist tokens.
 */
export async function probeMetaioPasswordLogin(
    username: string,
    password: string,
): Promise<
    | {
        ok: true;
        metaioUid: string;
        metaioToken: string;
        metaioBaseUrl: string;
        metaioDisplayName?: string;
        /** Metaio `data.info.account_id` → plugin `applicationId`. */
        applicationId?: string;
    }
    | { ok: false; message: string }
> {
    const user = username.trim();
    if (!user) return { ok: false, message: 'Phone number is required.' };
    if (!password) return { ok: false, message: 'Password is required.' };

    const dev = readLumiiDevConfigFile();
    const base = resolveMetaioBaseUrl(dev);
    if (!base) {
        return { ok: false, message: 'METAIO_AUTH=0 或未配置 METAIO_BASE_URL，无法进行 Lumii 密码校验。' };
    }
    const path = metaioLoginPath(dev);
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    const res = await proxyAwareFetch(url, {
        method: 'POST',
        headers: mergeMetaioBridgeHeaders(dev, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(buildMetaioLoginJsonBody(dev, user, password)),
    });

    const text = await res.text();
    let json: unknown;
    try {
        json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
        return {
            ok: false,
            message: res.ok
                ? 'Lumii login: response is not JSON.'
                : `Lumii login failed (${res.status}): ${text.slice(0, 300)}`,
        };
    }

    try {
        assertMetaioEnvelope(json);
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    if (!res.ok) {
        const msg =
            json && typeof json === 'object' && json !== null
                ? String((json as Record<string, unknown>).msg ?? (json as Record<string, unknown>).message ?? text.slice(0, 200))
                : text.slice(0, 300);
        return { ok: false, message: `Lumii login failed (${res.status}): ${msg}` };
    }

    const metaioToken = extractTokenFromLoginEnvelope(json);
    if (!metaioToken) {
        return { ok: false, message: 'Lumii login: expected data.token in success response.' };
    }

    const metaioUid = extractMetaioUidFromLoginResponse(json);
    if (!metaioUid) {
        return { ok: false, message: 'Lumii login: expected data.info.uid in success response.' };
    }

    const applicationId = extractApplicationIdFromMetaioEnvelope(json) ?? undefined;
    const display = extractMetaioDisplayNameFromEnvelope(json);
    return {
        ok: true,
        metaioUid,
        metaioToken,
        metaioBaseUrl: base,
        ...(applicationId ? { applicationId } : {}),
        ...(display ? { metaioDisplayName: display } : {}),
    };
}
