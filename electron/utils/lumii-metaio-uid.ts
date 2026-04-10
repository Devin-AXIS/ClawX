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
