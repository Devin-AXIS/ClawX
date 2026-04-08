/**
 * Lumii (openclaw-lumii) QR login for the Channels UI — Metaio only (no standalone Lumii HTTP product API).
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
import { assertMetaioUidUniqueForAccount, extractMetaioDisplayNameFromEnvelope } from './lumii-metaio-uid';
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

function envOrFile(envKey: string, dev: Record<string, string> | null): string {
    const e = process.env[envKey]?.trim();
    if (e) return e;
    return dev?.[envKey]?.trim() ?? '';
}

function flagEnabled(envKey: string, dev: Record<string, string> | null): boolean {
    return process.env[envKey] === '1' || dev?.[envKey] === '1';
}

function maskSessionKey(key: string): string {
    const t = key.trim();
    if (t.length <= 10) return `${t.slice(0, 4)}…`;
    return `${t.slice(0, 8)}…`;
}

function resolveMetaioBaseUrl(dev: Record<string, string> | null): string {
    const DEFAULT_METAIO_BASE = 'https://server.metaio.cc';
    const explicit = envOrFile('METAIO_BASE_URL', dev)?.trim();
    if (explicit) return explicit.replace(/\/$/, '');
    const ossFromApi = envOrFile('METAIO_OSS_FROM_API', dev)?.trim();
    if (ossFromApi && /^https?:\/\//i.test(ossFromApi)) return ossFromApi.replace(/\/$/, '');
    if (ossFromApi === '1' || flagEnabled('METAIO_OSS_FROM_API', dev)) return DEFAULT_METAIO_BASE;
    if (flagEnabled('METAIO_AUTH', dev)) return DEFAULT_METAIO_BASE;
    /** QR flow from the app implies Metaio; use public default when env/dev-config omitted (override with METAIO_BASE_URL). */
    return DEFAULT_METAIO_BASE;
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

function extractUserId(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
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
    throw new Error(`Metaio API: ${msg}`);
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
 * QR image URL or raw payload from Metaio JSON (session POST or GET status), aligned with openclaw-lumii-plugin Metaio helpers.
 * Status often returns the scannable URL only on `/api/auth/qrcode/status`.
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

    const path = envOrFile('METAIO_QR_START_PATH', dev)?.trim() || '/api/auth/qrcode/session';
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    /** Metaio expects a client-generated id for this QR round-trip; server may echo or override in JSON. */
    const sessionKeyClient = randomUUID();
    const postBody = JSON.stringify({ sessionKey: sessionKeyClient });
    logger.info(`${LOG_PREFIX} Metaio POST (create QR session)`, {
        url,
        sessionKey: maskSessionKey(sessionKeyClient),
    });
    const res = await proxyAwareFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody,
    });
    const text = await res.text();
    logger.info(`${LOG_PREFIX} Metaio POST response`, { status: res.status, ok: res.ok });
    if (!res.ok) {
        throw new Error(`Metaio QR start ${res.status}: ${text.slice(0, 400)}`);
    }
    let json: unknown;
    try {
        json = JSON.parse(text) as unknown;
    } catch {
        throw new Error('Metaio QR start: response is not JSON.');
    }
    assertMetaioEnvelope(json);
    if (!json || typeof json !== 'object') throw new Error('Metaio QR start: invalid JSON root.');
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
    /** From `username` / `data.username` etc., for UI display name. */
    displayName?: string;
    message?: string;
    /** Present when status payload includes a QR URL/image (plugin shows this on each poll). */
    qrcodeUrl?: string;
}> {
    const base = resolveMetaioBaseUrl(dev);
    const pathTemplate =
        envOrFile('METAIO_QR_STATUS_PATH', dev)?.trim() || '/api/auth/qrcode/status?sessionKey={sessionKey}';
    const path = pathTemplate.includes('{sessionKey}')
        ? pathTemplate.replace('{sessionKey}', encodeURIComponent(sessionKey))
        : `${pathTemplate}${pathTemplate.includes('?') ? '&' : '?'}sessionKey=${encodeURIComponent(sessionKey)}`;
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    logger.debug(`${LOG_PREFIX} Metaio GET (poll status)`, { url, sessionKey: maskSessionKey(sessionKey) });
    const res = await proxyAwareFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
    });
    const text = await res.text();
    if (!res.ok) {
        logger.warn(`${LOG_PREFIX} Metaio GET non-OK`, { status: res.status, preview: text.slice(0, 200) });
        return { connected: false, message: `Metaio QR status ${res.status}: ${text.slice(0, 200)}` };
    }
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return { connected: false, message: 'Metaio QR status: invalid JSON.' };
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
    if (token && (status === 'confirmed' || status === 'done' || status === 'success' || connectedFlag)) {
        logger.info(`${LOG_PREFIX} Metaio GET: login complete`, { status: status || '(empty)', connectedFlag });
        return {
            connected: true,
            token,
            userId: extractUserId(json),
            accountId: extractAccountId(json),
            ...(displayFromPoll ? { displayName: displayFromPoll } : {}),
        };
    }
    if (token && !status) {
        logger.info(`${LOG_PREFIX} Metaio GET: login complete (token, no status field)`);
        return {
            connected: true,
            token,
            userId: extractUserId(json),
            accountId: extractAccountId(json),
            ...(displayFromPoll ? { displayName: displayFromPoll } : {}),
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
    extras?: { userId?: string },
): Promise<void> {
    const stateDir = join(resolveOpenclawStateDir(), 'openclaw-lumii');
    const accountsDir = join(stateDir, 'accounts');
    const indexFile = join(stateDir, 'accounts.json');
    await mkdir(accountsDir, { recursive: true });
    const id = accountId.trim() || 'default';
    const filePath = join(accountsDir, `${id}.json`);
    if (extras?.userId?.trim()) {
        assertMetaioUidUniqueForAccount(extras.userId.trim(), id);
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
    if (extras?.userId?.trim()) {
        payload.userId = extras.userId.trim();
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

export function cancelOpenclawLumiiQrLogin(accountId?: string): void {
    const key = `${LUMII_CHANNEL_ID}:${accountId?.trim() || '__new__'}`;
    const ac = activeLumiiQrAborts.get(key);
    if (ac) {
        logger.info(`${LOG_PREFIX} cancel poll`, { accountId: accountId?.trim() || '__new__' });
        ac.abort();
        activeLumiiQrAborts.delete(key);
    }
}

export interface LumiiQrStartContext {
    eventBus: HostEventBus;
    mainWindow: BrowserWindow | null;
}

/**
 * Metaio QR session + poll until token; writes ~/.openclaw/openclaw-lumii/accounts.
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
    logger.info(`${LOG_PREFIX} Metaio base URL`, { base });

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
                    // Prefer the account the user is configuring in ClawX; Metaio ids are fallback (matches expected openclaw.json account).
                    const aid =
                        accountId?.trim() ||
                        r.accountId?.trim() ||
                        r.userId?.trim() ||
                        'default';
                    logger.info(`${LOG_PREFIX} poll finished: success`, { accountId: aid, pollRound });
                    await saveLumiiAccountFile(aid, r.token, base, { userId: r.userId });
                    logger.info(`${LOG_PREFIX} emit success to UI`, { accountId: aid, hasDisplayName: Boolean(r.displayName) });
                    emitLumiiChannelEvent(ctx.eventBus, ctx.mainWindow, 'success', {
                        accountId: aid,
                        ...(r.displayName?.trim() ? { metaioDisplayName: r.displayName.trim() } : {}),
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
            emitLumiiChannelEvent(ctx.eventBus, ctx.mainWindow, 'error', 'Timed out waiting for Metaio QR.');
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
