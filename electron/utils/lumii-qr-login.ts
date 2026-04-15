/**
 * Lumii (openclaw-lumii) QR login for the Channels UI.
 * Paths/env align with openclaw-lumii-plugin `src/auth/metaio-auth.ts` + `metaio-config.ts`.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { HostEventBus } from '../api/event-bus';
import { buildQrChannelEventName, toUiChannelType } from './channel-alias';
import { logger } from './logger';
import {
    assertMetaioUidUniqueForAccount,
    extractApplicationIdFromMetaioEnvelope,
    extractMetaioDisplayNameFromEnvelope,
    extractMetaioLoginUsernameFromEnvelope,
    extractMetaioUidFromLoginResponse,
    findLumiiAccountIdByMetaioUid,
    tryExtractMetaioUidFromBearerToken,
} from './lumii-metaio-uid';
import {
    envOrFile,
    mergeMetaioBridgeHeaders,
    metaioQrStartPath,
    metaioQrStatusPathTemplate,
    resolveMetaioBaseUrl,
} from './lumii-metaio-config';
import { proxyAwareFetch } from './proxy-fetch';

const LOG_PREFIX = '[openclaw-lumii][qr]';

const LUMII_CHANNEL_ID = 'openclaw-lumii';
const QR_WAIT_MS = 8 * 60_000;
const POLL_MS = 1000;

const activeLumiiQrAborts = new Map<string, AbortController>();

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

function maskSessionKey(key: string): string {
    const t = key.trim();
    if (t.length <= 10) return `${t.slice(0, 4)}…`;
    return `${t.slice(0, 8)}…`;
}

function emitQrEvent(
    eventBus: HostEventBus,
    mainWindow: BrowserWindow | null,
    payload: { qr?: string; raw?: string; sessionKey?: string },
): void {
    const ui = toUiChannelType(LUMII_CHANNEL_ID);
    const eventName = buildQrChannelEventName(ui, 'qr');
    eventBus.emit(eventName, payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(eventName, payload);
    }
}

function emitLumiiChannelEvent(
    eventBus: HostEventBus,
    mainWindow: BrowserWindow | null,
    event: 'success' | 'error',
    payload: unknown,
): void {
    const ui = toUiChannelType(LUMII_CHANNEL_ID);
    const eventName = buildQrChannelEventName(ui, event);
    eventBus.emit(eventName, payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(eventName, payload);
    }
}

function uidFromDataInfo(data: Record<string, unknown> | null): string | undefined {
    if (!data) return undefined;
    const info = data.info;
    if (!info || typeof info !== 'object' || info === null) return undefined;
    const i = info as Record<string, unknown>;
    const uid = i.uid;
    if (typeof uid === 'number' && Number.isFinite(uid)) return String(uid);
    if (typeof uid === 'string' && uid.trim()) return uid.trim();
    return undefined;
}

/** HTTP body first; if uid missing, parse JWT payload (common when bridge omits `data.info.uid`). */
function resolveUserIdForLumiiQrPoll(json: unknown, token: string): string | undefined {
    const fromJson = extractUserId(json);
    if (fromJson?.trim()) return fromJson.trim();
    return tryExtractMetaioUidFromBearerToken(token) ?? undefined;
}

function extractUserId(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const fromLogin = extractMetaioUidFromLoginResponse(body);
    if (fromLogin) return fromLogin;
    const o = body as Record<string, unknown>;
    const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null;
    const fromInfo = uidFromDataInfo(data);
    if (fromInfo) return fromInfo;
    const u = o.userId ?? o.user_id ?? data?.userId ?? data?.id;
    if (typeof u === 'number' && Number.isFinite(u)) return String(u);
    return typeof u === 'string' && u.trim() ? u.trim() : undefined;
}

function extractAccountId(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const o = body as Record<string, unknown>;
    const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null;
    const a = o.accountId ?? o.account_id ?? data?.accountId;
    if (typeof a === 'string' && a.trim()) return a.trim();
    if (typeof a === 'number' && Number.isFinite(a)) return String(a);
    return uidFromDataInfo(data);
}

/** Same envelope rules as plugin `assertMetaioLoginEnvelopeSuccess` (login + QR). */
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

function extractTokenFromJson(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const o = body as Record<string, unknown>;
    const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null;
    const candidates = [o.token, o.accessToken, o.access_token, data?.token, data?.accessToken, data?.access_token];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
}

/**
 * QR image URL or raw payload from login JSON (session POST or GET status), aligned with openclaw-lumii-plugin helpers.
 * Status often returns the scannable URL only on GET …/qrcode/status（路径可配 METAIO_QR_STATUS_PATH）。
 */
function extractMetaioQrcodeUrl(root: Record<string, unknown>, data: Record<string, unknown> | null): string {
    const src = data ?? root;
    const candidates: unknown[] = [
        src.qrcodeUrl,
        src.qrCodeUrl,
        src.qr_url,
        src.qrUrl,
        src.qrcode,
        root.qrcodeUrl,
        root.qrCodeUrl,
        src.url,
        root.url,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return '';
}

async function metaioStartQr(dev: Record<string, string> | null): Promise<{ sessionKey: string; qrcodeUrl: string; message?: string }> {
    const base = resolveMetaioBaseUrl(dev);
    if (!base) {
        throw new Error('METAIO_AUTH=0 或未配置 METAIO_BASE_URL，无法创建 Lumii 扫码会话。');
    }

    const path = metaioQrStartPath(dev);
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    /** Server expects a client-generated id for this QR round-trip; may echo or override in JSON. */
    const sessionKeyClient = randomUUID();
    const postBody = JSON.stringify({ sessionKey: sessionKeyClient });
    logger.info(`${LOG_PREFIX} Lumii POST (create QR session)`, {
        url,
        sessionKey: maskSessionKey(sessionKeyClient),
    });
    const res = await proxyAwareFetch(url, {
        method: 'POST',
        headers: mergeMetaioBridgeHeaders(dev, { 'Content-Type': 'application/json' }),
        body: postBody,
    });
    const text = await res.text();
    logger.info(`${LOG_PREFIX} Lumii POST response`, { status: res.status, ok: res.ok });
    if (!res.ok) {
        throw new Error(`Lumii QR start ${res.status}: ${text.slice(0, 400)}`);
    }
    let json: unknown;
    try {
        json = JSON.parse(text) as unknown;
    } catch {
        throw new Error('Lumii QR start: response is not JSON.');
    }
    assertMetaioEnvelope(json);
    if (!json || typeof json !== 'object') throw new Error('Lumii QR start: invalid JSON root.');
    const root = json as Record<string, unknown>;
    const data =
        root.data && typeof root.data === 'object' && root.data !== null
            ? (root.data as Record<string, unknown>)
            : null;
    const src = data ?? root;
    const sessionKeyFromResponse = String(
        src.sessionKey ?? src.sessionId ?? src.id ?? root.sessionKey ?? root.sessionId ?? root.id ?? '',
    ).trim();
    const qrcodeUrl = extractMetaioQrcodeUrl(root, data);
    const sessionKey = sessionKeyFromResponse || sessionKeyClient;
    const message =
        typeof src.message === 'string'
            ? src.message
            : typeof root.message === 'string'
              ? root.message
              : undefined;
    logger.info(`${LOG_PREFIX} QR session ready`, {
        sessionKey: maskSessionKey(sessionKey),
        qrcodeFromSession: Boolean(qrcodeUrl),
        qrcodeUrlKind: !qrcodeUrl
            ? '(await GET /qrcode/status)'
            : qrcodeUrl.startsWith('http')
              ? 'http(s)'
              : qrcodeUrl.startsWith('data:')
                ? 'data-url'
                : 'other',
    });
    return { sessionKey, qrcodeUrl, message };
}

async function metaioPollQrOnce(
    dev: Record<string, string> | null,
    sessionKey: string,
    signal?: AbortSignal,
): Promise<{
    connected: boolean;
    token?: string;
    userId?: string;
    accountId?: string;
    /** Metaio `data.info.account_id` → plugin `applicationId`. */
    applicationId?: string;
    /** From `username` / `data.username` etc., for UI display name. */
    displayName?: string;
    /** Phone / login id for `metaioUsername` in openclaw.json (METAIO_USERNAME). */
    metaioUsername?: string;
    message?: string;
    /** Present when status payload includes a QR URL/image (plugin shows this on each poll). */
    qrcodeUrl?: string;
}> {
    const base = resolveMetaioBaseUrl(dev);
    if (!base) {
        return { connected: false, message: 'Lumii QR status: METAIO_BASE_URL 未配置或 METAIO_AUTH=0。' };
    }
    const pathTemplate = metaioQrStatusPathTemplate(dev);
    const paramName = envOrFile('METAIO_QR_STATUS_SESSION_PARAM', dev)?.trim() || 'sessionKey';
    const path = pathTemplate.includes('{sessionKey}')
        ? pathTemplate.replaceAll('{sessionKey}', encodeURIComponent(sessionKey))
        : `${pathTemplate}${pathTemplate.includes('?') ? '&' : '?'}${paramName}=${encodeURIComponent(sessionKey)}`;
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    logger.debug(`${LOG_PREFIX} Lumii GET (poll status)`, { url, sessionKey: maskSessionKey(sessionKey) });
    const res = await proxyAwareFetch(url, {
        method: 'GET',
        headers: mergeMetaioBridgeHeaders(dev, { Accept: 'application/json' }),
        signal,
    });
    const text = await res.text();
    if (!res.ok) {
        logger.warn(`${LOG_PREFIX} Lumii GET non-OK`, { status: res.status, preview: text.slice(0, 200) });
        return { connected: false, message: `Lumii QR status ${res.status}: ${text.slice(0, 200)}` };
    }
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return { connected: false, message: 'Lumii QR status: invalid JSON.' };
    }
    try {
        assertMetaioEnvelope(json);
    } catch (e) {
        return { connected: false, message: e instanceof Error ? e.message : String(e) };
    }
    const data =
        json.data && typeof json.data === 'object' && json.data !== null
            ? (json.data as Record<string, unknown>)
            : null;
    const qrcodeUrlFromStatus = extractMetaioQrcodeUrl(json, data);
    const status = String(json.status ?? json.state ?? data?.status ?? data?.state ?? '').toLowerCase();
    const connectedFlag = json.connected === true || data?.connected === true;
    const token = extractTokenFromJson(json);
    const displayFromPoll = extractMetaioDisplayNameFromEnvelope(json) ?? undefined;
    const loginUsernameFromPoll = extractMetaioLoginUsernameFromEnvelope(json) ?? undefined;
    const applicationIdFromMetaio = extractApplicationIdFromMetaioEnvelope(json) ?? undefined;
    if (token && (status === 'confirmed' || status === 'done' || status === 'success' || connectedFlag)) {
        logger.info(`${LOG_PREFIX} Lumii GET: login complete`, { status: status || '(empty)', connectedFlag });
        return {
            connected: true,
            token,
            userId: resolveUserIdForLumiiQrPoll(json, token),
            accountId: extractAccountId(json),
            ...(applicationIdFromMetaio ? { applicationId: applicationIdFromMetaio } : {}),
            ...(displayFromPoll ? { displayName: displayFromPoll } : {}),
            ...(loginUsernameFromPoll ? { metaioUsername: loginUsernameFromPoll } : {}),
        };
    }
    if (token && !status) {
        logger.info(`${LOG_PREFIX} Lumii GET: login complete (token, no status field)`);
        return {
            connected: true,
            token,
            userId: resolveUserIdForLumiiQrPoll(json, token),
            accountId: extractAccountId(json),
            ...(applicationIdFromMetaio ? { applicationId: applicationIdFromMetaio } : {}),
            ...(displayFromPoll ? { displayName: displayFromPoll } : {}),
            ...(loginUsernameFromPoll ? { metaioUsername: loginUsernameFromPoll } : {}),
        };
    }
    if (status === 'expired' || status === 'failed') {
        const hint =
            typeof json.msg === 'string'
                ? json.msg
                : typeof json.message === 'string'
                  ? json.message
                  : typeof data?.message === 'string'
                    ? data.message
                    : 'QR expired or failed.';
        return { connected: false, message: hint };
    }
    return {
        connected: false,
        message: 'waiting',
        ...(qrcodeUrlFromStatus ? { qrcodeUrl: qrcodeUrlFromStatus } : {}),
    };
}

/** Persist plugin token JSON under ~/.openclaw/openclaw-lumii/accounts (password or QR login). */
export async function saveLumiiAccountFile(
    accountId: string,
    token: string,
    metaioBaseUrl: string,
    extras?: { userId?: string; applicationId?: string },
): Promise<void> {
    const stateDir = join(resolveOpenclawStateDir(), 'openclaw-lumii');
    const accountsDir = join(stateDir, 'accounts');
    const indexFile = join(stateDir, 'accounts.json');
    await mkdir(accountsDir, { recursive: true });
    const id = accountId.trim() || 'default';
    const filePath = join(accountsDir, `${id}.json`);
    const extraUid = extras?.userId?.trim();
    /** Password flow uses numeric Metaio uid as account id; persist uid even if bridge omitted `userId` in extras. */
    const inferredUid =
        extraUid || (/^\d{3,24}$/.test(id) ? id : undefined);
    if (inferredUid) {
        assertMetaioUidUniqueForAccount(inferredUid, id);
    }
    const metaioRoot = metaioBaseUrl.replace(/\/$/, '');
    const payload: Record<string, unknown> = {
        accountId: id,
        token: token.trim(),
        authSource: 'metaio',
        metaioBaseUrl: metaioRoot,
        /** Same as Metaio root — no separate Lumii business API base in this integration. */
        baseUrl: metaioRoot,
        savedAt: new Date().toISOString(),
    };
    /** Plugin expects Metaio user uid (`data.info.uid`); always persist when known. */
    if (inferredUid) {
        payload.userId = inferredUid;
    }
    const appId = extras?.applicationId?.trim();
    if (appId) {
        /** Metaio `data.info.account_id` — openclaw-lumii plugin field `applicationId`. */
        payload.applicationId = appId;
    }
    logger.info(`${LOG_PREFIX} write account file`, { path: filePath, accountId: id });
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    try {
        await chmod(filePath, 0o600);
    } catch {
        // ignore
    }
    let ids: string[] = [];
    try {
        if (existsSync(indexFile)) {
            const raw = await readFile(indexFile, 'utf-8');
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
                ids = parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
            }
        }
    } catch {
        ids = [];
    }
    if (!ids.includes(id)) {
        ids.push(id);
        await writeFile(indexFile, `${JSON.stringify(ids, null, 2)}\n`, 'utf-8');
    }
}

/**
 * Stops `auth/qrcode/status` polling for any in-flight Lumii QR session.
 * Aborts every active controller so a single cancel call always matches the running poll
 * even if start/cancel account keys drifted in the UI.
 */
export function cancelOpenclawLumiiQrLogin(_accountId?: string): void {
    if (activeLumiiQrAborts.size === 0) return;
    for (const [key, ac] of [...activeLumiiQrAborts.entries()]) {
        logger.info(`${LOG_PREFIX} cancel poll`, { key });
        ac.abort();
        activeLumiiQrAborts.delete(key);
    }
}

export interface LumiiQrStartContext {
    eventBus: HostEventBus;
    mainWindow: BrowserWindow | null;
}

/**
 * Lumii QR session + poll until token; writes ~/.openclaw/openclaw-lumii/accounts.
 */
export async function startOpenclawLumiiQrLogin(ctx: LumiiQrStartContext, accountId?: string): Promise<void> {
    const dev = readLumiiDevConfigFile();
    const devPath = lumiiDevConfigPath();
    logger.info(`${LOG_PREFIX} start`, {
        accountId: accountId?.trim() || '(default)',
        devConfigPath: devPath,
        devConfigLoaded: Boolean(dev),
    });

    const base = resolveMetaioBaseUrl(dev);
    if (!base) {
        emitLumiiChannelEvent(ctx.eventBus, ctx.mainWindow, 'error', 'METAIO_AUTH=0 或未配置 METAIO_BASE_URL，无法使用 Lumii 扫码。');
        return;
    }
    logger.info(`${LOG_PREFIX} Lumii base URL`, { base });

    const start = await metaioStartQr(dev);
    let lastQrEmitted = '';
    const emitQrToUiIfNew = (qrUrl: string, from: 'session' | 'status') => {
        const t = qrUrl.trim();
        if (!t || t === lastQrEmitted) return;
        lastQrEmitted = t;
        logger.info(`${LOG_PREFIX} emit QR to UI`, {
            sessionKey: maskSessionKey(start.sessionKey),
            from,
            qrcodeUrlKind: t.startsWith('http')
                ? 'http(s)'
                : t.startsWith('data:')
                  ? 'data-url'
                  : 'other',
        });
        emitQrEvent(ctx.eventBus, ctx.mainWindow, {
            qr: t,
            raw: t,
            sessionKey: start.sessionKey,
        });
    };
    /** Session POST may omit QR; plugin relies on GET /qrcode/status for the scannable URL. */
    emitQrToUiIfNew(start.qrcodeUrl, 'session');

    const key = `${LUMII_CHANNEL_ID}:${accountId?.trim() || '__new__'}`;
    cancelOpenclawLumiiQrLogin(accountId);
    const ac = new AbortController();
    activeLumiiQrAborts.set(key, ac);

    void (async () => {
        const deadline = Date.now() + QR_WAIT_MS;
        let pollRound = 0;
        logger.info(`${LOG_PREFIX} begin polling (max ${QR_WAIT_MS / 1000}s, interval ${POLL_MS}ms)`);
        try {
            while (Date.now() < deadline) {
                if (ac.signal.aborted) return;
                pollRound += 1;
                if (pollRound === 1 || pollRound % 10 === 0) {
                    logger.info(`${LOG_PREFIX} poll round`, { n: pollRound, remainingMs: Math.max(0, deadline - Date.now()) });
                }
                const r = await metaioPollQrOnce(dev, start.sessionKey, ac.signal);
                if (r.qrcodeUrl?.trim()) {
                    emitQrToUiIfNew(r.qrcodeUrl, 'status');
                }
                if (r.connected && r.token) {
                    /**
                     * Password login saves `~/.openclaw/openclaw-lumii/accounts/<metaioUid>.json`.
                     * QR must reuse that file when the same user signs in again — do not prefer server
                     * `accountId` over `userId` when no explicit ClawX account was requested, or we add a duplicate.
                     */
                    const requested = accountId?.trim();
                    const metaioUid = r.userId?.trim();
                    let aid: string;
                    if (requested) {
                        aid = requested;
                    } else if (metaioUid) {
                        aid = findLumiiAccountIdByMetaioUid(metaioUid) ?? metaioUid;
                    } else {
                        aid = r.accountId?.trim() || 'default';
                    }
                    logger.info(`${LOG_PREFIX} poll finished: success`, { accountId: aid, pollRound });
                    await saveLumiiAccountFile(aid, r.token, base, {
                        userId: r.userId,
                        ...(r.applicationId ? { applicationId: r.applicationId } : {}),
                    });
                    logger.info(`${LOG_PREFIX} emit success to UI`, {
                        accountId: aid,
                        hasDisplayName: Boolean(r.displayName),
                        hasMetaioUsername: Boolean(r.metaioUsername),
                    });
                    emitLumiiChannelEvent(ctx.eventBus, ctx.mainWindow, 'success', {
                        accountId: aid,
                        ...(r.displayName?.trim() ? { metaioDisplayName: r.displayName.trim() } : {}),
                        ...(r.metaioUsername?.trim() ? { metaioUsername: r.metaioUsername.trim() } : {}),
                    });
                    return;
                }
                if (r.message && r.message !== 'waiting' && !r.message.toLowerCase().includes('waiting')) {
                    logger.warn(`${LOG_PREFIX} poll finished: error`, { message: r.message, pollRound });
                    emitLumiiChannelEvent(ctx.eventBus, ctx.mainWindow, 'error', r.message);
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
            logger.warn(`${LOG_PREFIX} poll finished: timeout`, { pollRound });
            emitLumiiChannelEvent(ctx.eventBus, ctx.mainWindow, 'error', 'Timed out waiting for Lumii QR.');
        } catch (e) {
            if (ac.signal.aborted) {
                logger.info(`${LOG_PREFIX} poll aborted (cancel)`);
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            logger.error(`${LOG_PREFIX} poll exception`, { message: msg });
            emitLumiiChannelEvent(ctx.eventBus, ctx.mainWindow, 'error', msg);
        } finally {
            activeLumiiQrAborts.delete(key);
        }
    })();
}
