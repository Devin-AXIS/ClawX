/**
 * Metaio `data.info.uid` uniqueness across Lumii account JSON files under
 * ~/.openclaw/openclaw-lumii/accounts/*.json
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveOpenclawStateDir(): string {
    const o = process.env.OPENCLAW_STATE_DIR?.trim();
    if (o) return o;
    return join(homedir(), '.openclaw');
}

export function lumiiAccountsDir(): string {
    return join(resolveOpenclawStateDir(), 'openclaw-lumii', 'accounts');
}

/** Remove Lumii plugin account file and entry from `accounts.json` (logout / delete account). */
export async function removeLumiiAccountState(accountId: string): Promise<void> {
    const id = accountId.trim() || 'default';
    const filePath = join(lumiiAccountsDir(), `${id}.json`);
    if (existsSync(filePath)) {
        await unlink(filePath);
    }
    const indexFile = join(resolveOpenclawStateDir(), 'openclaw-lumii', 'accounts.json');
    if (!existsSync(indexFile)) return;
    try {
        const raw = await readFile(indexFile, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        const next = parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x !== id);
        await writeFile(indexFile, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    } catch {
        // ignore corrupt index
    }
}

/** Remove all `accounts/*.json` and `accounts.json` under openclaw-lumii (full channel delete). */
export async function clearOpenclawLumiiPluginAccountFiles(): Promise<void> {
    const root = join(resolveOpenclawStateDir(), 'openclaw-lumii');
    const accountsDir = join(root, 'accounts');
    const indexFile = join(root, 'accounts.json');
    try {
        if (existsSync(accountsDir)) {
            await rm(accountsDir, { recursive: true, force: true });
        }
        if (existsSync(indexFile)) {
            await unlink(indexFile);
        }
    } catch {
        // ignore
    }
}

/** Normalize Metaio uid from API (`data.info.uid` or string). */
export function normalizeMetaioUid(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
    return null;
}

/**
 * When the QR/status HTTP body omits `data.info.uid`, Metaio often still returns a JWT whose
 * payload contains `uid` / `userId` / `sub` — use that so password vs QR dedupe by the same id.
 */
export function tryExtractMetaioUidFromBearerToken(token: string): string | null {
    const t = token.trim();
    if (!t) return null;
    const parts = t.split('.');
    if (parts.length < 2) return null;
    try {
        let payload = parts[1];
        payload = payload.replace(/-/g, '+').replace(/_/g, '/');
        const pad = payload.length % 4;
        if (pad) payload += '='.repeat(4 - pad);
        const raw = Buffer.from(payload, 'base64').toString('utf8');
        const json = JSON.parse(raw) as Record<string, unknown>;
        const candidates: unknown[] = [json.uid, json.userId, json.user_id, json.sub, json.id];
        for (const c of candidates) {
            const n = normalizeMetaioUid(c);
            if (n) return n;
        }
    } catch {
        return null;
    }
    return null;
}

/** From login JSON `{ code, data: { info: { uid } } }`. */
export function extractMetaioUidFromLoginResponse(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const data = (json as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || data === null) return null;
    const info = (data as Record<string, unknown>).info;
    if (!info || typeof info !== 'object' || info === null) return null;
    return normalizeMetaioUid((info as Record<string, unknown>).uid);
}

/**
 * Metaio `data.info.account_id` → openclaw-lumii account JSON field `applicationId` (plugin id for workspace/app).
 * Distinct from `uid` (user). Same envelope for password login and QR status JSON.
 */
export function extractApplicationIdFromMetaioEnvelope(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const data = (json as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || data === null) return null;
    const info = (data as Record<string, unknown>).info;
    if (!info || typeof info !== 'object' || info === null) return null;
    const i = info as Record<string, unknown>;
    return normalizeMetaioUid(i.account_id ?? i.accountId);
}

/**
 * Phone / login account for `channels.openclaw-lumii` field `metaioUsername` (maps to METAIO_USERNAME).
 * QR status and password login may expose these under `data.info` or `data`.
 */
export function extractMetaioLoginUsernameFromEnvelope(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const o = json as Record<string, unknown>;
    const data =
        o.data && typeof o.data === 'object' && o.data !== null ? (o.data as Record<string, unknown>) : null;
    const info =
        data?.info && typeof data.info === 'object' && data.info !== null
            ? (data.info as Record<string, unknown>)
            : null;
    const candidates: unknown[] = [
        info?.phone,
        info?.mobile,
        info?.phoneNumber,
        info?.tel,
        info?.account,
        data?.phone,
        data?.mobile,
        data?.tel,
        data?.account,
        o.phone,
        o.mobile,
        data?.username,
        info?.username,
        o.username,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
        if (typeof c === 'number' && Number.isFinite(c)) return String(c);
    }
    return null;
}

/** Display name from login or QR status JSON (`data.username`, `data.info.username`, etc.). */
export function extractMetaioDisplayNameFromEnvelope(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const o = json as Record<string, unknown>;
    const data =
        o.data && typeof o.data === 'object' && o.data !== null ? (o.data as Record<string, unknown>) : null;
    const info =
        data?.info && typeof data.info === 'object' && data.info !== null
            ? (data.info as Record<string, unknown>)
            : null;
    const candidates: unknown[] = [
        data?.username,
        data?.name,
        info?.username,
        info?.name,
        o.username,
        o.name,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
}

function readMetaioUidFromLumiiPluginAccountFile(accountId: string): string | null {
    const id = accountId.trim() || 'default';
    const p = join(lumiiAccountsDir(), `${id}.json`);
    if (!existsSync(p)) return null;
    try {
        const j = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
        return normalizeMetaioUid(j.userId) ?? normalizeMetaioUid(j.accountId);
    } catch {
        return null;
    }
}

/**
 * If any `accounts/*.json` already stores this Metaio user uid, return that file's account id
 * so QR login updates the same account as password login instead of adding a second entry.
 */
export function findLumiiAccountIdByMetaioUid(metaioUid: string): string | null {
    const uid = normalizeMetaioUid(metaioUid);
    if (!uid) return null;

    const dir = lumiiAccountsDir();
    if (!existsSync(dir)) return null;
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return null;
    }
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const accountId = name.slice(0, -'.json'.length);
        const p = join(dir, name);
        try {
            const raw = readFileSync(p, 'utf-8');
            const j = JSON.parse(raw) as unknown;
            if (!j || typeof j !== 'object') continue;
            const rec = j as Record<string, unknown>;
            const existing =
                normalizeMetaioUid(rec.userId) ?? normalizeMetaioUid(rec.accountId);
            if (existing && existing === uid) {
                return accountId || null;
            }
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * Map the incoming ClawX account id to an existing openclaw.json account when the Lumii plugin
 * state file for `requestedAccountId` matches a Metaio user already present under another id
 * (e.g. home password login saved `90001`, then "add account" QR used `default` briefly).
 */
export function resolveLumiiAccountIdForChannelSave(
    requestedAccountId: string,
    openClawAccountIds: string[],
    preferredDefaultAccountId?: string,
    fallbackAccountId = 'default',
): string {
    const req = requestedAccountId.trim() || fallbackAccountId;
    const uid = readMetaioUidFromLumiiPluginAccountFile(req);
    if (!uid) return req;

    const matches: string[] = [];
    for (const id of openClawAccountIds) {
        const t = id.trim();
        if (!t) continue;
        const u = readMetaioUidFromLumiiPluginAccountFile(t);
        if (u === uid) matches.push(t);
    }
    if (matches.length > 0) {
        const preferred = preferredDefaultAccountId?.trim() ?? '';
        if (preferred && matches.includes(preferred)) return preferred;
        const sorted = [...matches].sort((a, b) => a.localeCompare(b));
        return sorted[0] ?? req;
    }

    const fromDisk = findLumiiAccountIdByMetaioUid(uid);
    return fromDisk ?? req;
}

/** Drop other `channels.openclaw-lumii.accounts` keys that point at the same Metaio user on disk. */
export function pruneDuplicateLumiiAccountsInOpenClaw(
    accounts: Record<string, unknown> | undefined,
    keepAccountId: string,
): void {
    if (!accounts) return;
    const keep = keepAccountId.trim() || 'default';
    const keepUid = readMetaioUidFromLumiiPluginAccountFile(keep);
    if (!keepUid) return;
    for (const key of Object.keys(accounts)) {
        if (key === keep) continue;
        const u = readMetaioUidFromLumiiPluginAccountFile(key);
        if (u && u === keepUid) {
            delete accounts[key];
        }
    }
}

/**
 * Throws if `metaioUid` is already bound to a different Lumii account file.
 */
export function assertMetaioUidUniqueForAccount(metaioUid: string, forAccountId: string): void {
    const uid = metaioUid.trim();
    const self = forAccountId.trim() || 'default';
    if (!uid) return;

    const dir = lumiiAccountsDir();
    if (!existsSync(dir)) return;
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const accountId = name.slice(0, -'.json'.length);
        if (!accountId || accountId === self) continue;
        const p = join(dir, name);
        try {
            const raw = readFileSync(p, 'utf-8');
            const j = JSON.parse(raw) as unknown;
            if (!j || typeof j !== 'object') continue;
            const rec = j as Record<string, unknown>;
            /** When userId is omitted, Metaio uid matches filename/accountId (see saveLumiiAccountFile). */
            const existing =
                normalizeMetaioUid(rec.userId) ?? normalizeMetaioUid(rec.accountId);
            if (existing && existing === uid) {
                throw new Error(
                    `This Lumii account (uid ${uid}) is already linked as "${accountId}". Remove or edit that account instead.`,
                );
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('already added')) throw e;
        }
    }
}
