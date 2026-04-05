import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeOpenClawAccountId } from './channel-alias';

export const DEFAULT_LUMII_BASE_URL = process.env.LUMII_QR_BASE_URL?.trim() || 'http://127.0.0.1:3007';
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const LUMII_STATE_DIR = join(OPENCLAW_DIR, 'openclaw-lumii');
const LUMII_ACCOUNT_INDEX_FILE = join(LUMII_STATE_DIR, 'accounts.json');
const LUMII_ACCOUNTS_DIR = join(LUMII_STATE_DIR, 'accounts');

type ActiveLogin = {
  sessionKey: string;
  qrcodeUrl: string;
  startedAt: number;
  apiBaseUrl: string;
  pollable: boolean;
};

type LumiiStartQrResponse = {
  sessionKey?: string;
  qrcodeUrl?: string;
  qrCodeUrl?: string;
  qr?: string;
  raw?: string;
  pairing_code?: string;
  device_code?: string;
  verification_uri?: string;
  message?: string;
};

type LumiiQrStatusResponse = {
  status: 'wait' | 'scanned' | 'confirmed' | 'expired';
  accountId?: string;
  token?: string;
  refreshToken?: string;
  baseUrl?: string;
  userId?: string;
};

type LumiiRefreshQrResponse = {
  qrcodeUrl?: string;
};

export type LumiiLoginStartResult = {
  sessionKey: string;
  qrcodeUrl?: string;
  message: string;
  pollable?: boolean;
};

export type LumiiLoginWaitResult = {
  connected: boolean;
  message: string;
  token?: string;
  refreshToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
};

const activeLogins = new Map<string, ActiveLogin>();

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

async function requestJson<T>(url: string, init: RequestInit, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Lumii API ${response.status}: ${raw}`);
    }
    return JSON.parse(raw) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJsonOrNull<T>(url: string, init: RequestInit, timeoutMs = 15_000): Promise<T | null> {
  try {
    return await requestJson<T>(url, init, timeoutMs);
  } catch {
    return null;
  }
}

function toQrImageUrl(rawPayload: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(rawPayload)}`;
}

function normalizeQrStartResponse(
  response: LumiiStartQrResponse | null,
): (LumiiStartQrResponse & { pollable: boolean }) | null {
  if (!response) return null;
  const qrcodeUrl = response.qrcodeUrl?.trim() || response.qrCodeUrl?.trim();
  if (qrcodeUrl) {
    return {
      ...response,
      qrcodeUrl,
      sessionKey: response.sessionKey?.trim() || response.device_code?.trim() || randomUUID(),
      pollable: true,
    };
  }

  const pairingCode = response.pairing_code?.trim();
  const deviceCode = response.device_code?.trim();
  const verificationUri = response.verification_uri?.trim();
  if (pairingCode || deviceCode || verificationUri) {
    const raw = JSON.stringify(
      {
        ...(deviceCode ? { device_code: deviceCode } : {}),
        ...(pairingCode ? { pairing_code: pairingCode } : {}),
        ...(verificationUri ? { verification_uri: verificationUri } : {}),
      },
      null,
      0,
    );
    return {
      ...response,
      sessionKey: response.sessionKey?.trim() || deviceCode || randomUUID(),
      qrcodeUrl: toQrImageUrl(raw),
      message: response.message || 'Pairing QR generated. Scan with Lumii app to continue.',
      pollable: false,
    };
  }
  return null;
}

async function fetchLumiiQrCode(apiBaseUrl: string): Promise<LumiiStartQrResponse> {
  const base = normalizeBaseUrl(apiBaseUrl);
  const directQr = normalizeQrStartResponse(
    await requestJsonOrNull<LumiiStartQrResponse>(`${base}/lumii/qr/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  if (directQr) return directQr;

  const pairingQr = normalizeQrStartResponse(
    await requestJsonOrNull<LumiiStartQrResponse>(`${base}/api/lumii/openclaw/pairing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  if (pairingQr) return pairingQr;

  throw new Error('Failed to generate Lumii QR code: both /lumii/qr/start and /api/lumii/openclaw/pairing are unavailable');
}

async function pollLumiiQrStatus(apiBaseUrl: string, sessionKey: string): Promise<LumiiQrStatusResponse> {
  const base = normalizeBaseUrl(apiBaseUrl);
  return await requestJson<LumiiQrStatusResponse>(
    `${base}/lumii/qr/status?sessionKey=${encodeURIComponent(sessionKey)}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  );
}

async function refreshLumiiQrCode(apiBaseUrl: string, sessionKey: string): Promise<LumiiRefreshQrResponse> {
  const base = normalizeBaseUrl(apiBaseUrl);
  return await requestJson<LumiiRefreshQrResponse>(`${base}/lumii/qr/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey }),
  });
}

async function readAccountIndex(): Promise<string[]> {
  try {
    const raw = await readFile(LUMII_ACCOUNT_INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  } catch {
    return [];
  }
}

async function writeAccountIndex(accountIds: string[]): Promise<void> {
  await mkdir(LUMII_STATE_DIR, { recursive: true });
  await writeFile(LUMII_ACCOUNT_INDEX_FILE, JSON.stringify(accountIds, null, 2), 'utf-8');
}

export async function saveLumiiAccountState(rawAccountId: string, payload: {
  token: string;
  refreshToken?: string;
  baseUrl?: string;
  userId?: string;
}): Promise<string> {
  const accountId = normalizeOpenClawAccountId(rawAccountId);
  await mkdir(LUMII_ACCOUNTS_DIR, { recursive: true });

  const filePath = join(LUMII_ACCOUNTS_DIR, `${accountId}.json`);
  const data = {
    token: payload.token.trim(),
    savedAt: new Date().toISOString(),
    ...(payload.refreshToken?.trim() ? { refreshToken: payload.refreshToken.trim() } : {}),
    ...(payload.baseUrl?.trim() ? { baseUrl: payload.baseUrl.trim() } : {}),
    ...(payload.userId?.trim() ? { userId: payload.userId.trim() } : {}),
  };
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await chmod(filePath, 0o600);
  } catch {
    // best effort
  }

  const existing = await readAccountIndex();
  if (!existing.includes(accountId)) {
    await writeAccountIndex([...existing, accountId]);
  }

  return accountId;
}

export async function startLumiiLoginSession(options: {
  sessionKey?: string;
  apiBaseUrl?: string;
  force?: boolean;
}): Promise<LumiiLoginStartResult> {
  const sessionKey = options.sessionKey?.trim() || randomUUID();
  const requestedBase = options.apiBaseUrl?.trim() || DEFAULT_LUMII_BASE_URL;
  const candidateBases = Array.from(new Set([
    requestedBase,
    'http://127.0.0.1:3007',
    'https://api.lumii.ai',
  ].filter((v) => !!v && /^https?:\/\//i.test(v))));
  const existing = activeLogins.get(sessionKey);

  if (!options.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      sessionKey,
      qrcodeUrl: existing.qrcodeUrl,
      message: 'QR code is ready. Scan it with Lumii.',
      pollable: existing.pollable,
    };
  }

  let start: LumiiStartQrResponse | null = null;
  let resolvedApiBaseUrl = requestedBase;
  let lastError: unknown = null;
  for (const base of candidateBases) {
    try {
      start = await fetchLumiiQrCode(base);
      resolvedApiBaseUrl = base;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!start) {
    throw lastError instanceof Error ? lastError : new Error('Failed to generate Lumii QR code');
  }
  activeLogins.set(sessionKey, {
    sessionKey: start.sessionKey?.trim() || sessionKey,
    qrcodeUrl: start.qrcodeUrl || '',
    startedAt: Date.now(),
    apiBaseUrl: resolvedApiBaseUrl,
    pollable: start.pollable !== false,
  });

  return {
    sessionKey: start.sessionKey?.trim() || sessionKey,
    qrcodeUrl: start.qrcodeUrl,
    message: start.message || 'Scan the QR code with Lumii to complete login.',
    pollable: start.pollable,
  };
}

export async function waitForLumiiLoginSession(options: {
  sessionKey: string;
  timeoutMs?: number;
  onQrRefresh?: (payload: { qrcodeUrl: string }) => void | Promise<void>;
}): Promise<LumiiLoginWaitResult> {
  const login = activeLogins.get(options.sessionKey);
  if (!login) {
    return {
      connected: false,
      message: 'No active Lumii login session. Generate a new QR code and try again.',
    };
  }

  if (!isLoginFresh(login)) {
    activeLogins.delete(options.sessionKey);
    return {
      connected: false,
      message: 'The Lumii QR code has expired. Generate a new QR code and try again.',
    };
  }

  const timeoutMs = Math.max(options.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    const current = activeLogins.get(options.sessionKey);
    if (!current) {
      return { connected: false, message: 'The Lumii login session was cancelled.' };
    }

    const status = await pollLumiiQrStatus(current.apiBaseUrl, options.sessionKey);
    switch (status.status) {
      case 'wait':
      case 'scanned':
        break;
      case 'expired': {
        qrRefreshCount += 1;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          activeLogins.delete(options.sessionKey);
          return {
            connected: false,
            message: 'The Lumii QR code expired too many times. Generate a new QR code and try again.',
          };
        }
        const refreshed = await refreshLumiiQrCode(current.apiBaseUrl, options.sessionKey);
        if (refreshed.qrcodeUrl?.trim()) {
          const nextQr = refreshed.qrcodeUrl.trim();
          activeLogins.set(options.sessionKey, {
            ...current,
            qrcodeUrl: nextQr,
            startedAt: Date.now(),
          });
          await options.onQrRefresh?.({ qrcodeUrl: nextQr });
        }
        break;
      }
      case 'confirmed':
        activeLogins.delete(options.sessionKey);
        if (!status.accountId || !status.token) {
          return {
            connected: false,
            message: 'Lumii login succeeded but account credentials were missing in response.',
          };
        }
        return {
          connected: true,
          accountId: status.accountId,
          token: status.token,
          refreshToken: status.refreshToken,
          baseUrl: status.baseUrl,
          userId: status.userId,
          message: 'Lumii connected successfully.',
        };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  activeLogins.delete(options.sessionKey);
  return { connected: false, message: 'Timed out waiting for Lumii QR confirmation.' };
}

export async function cancelLumiiLoginSession(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    activeLogins.clear();
    return;
  }
  activeLogins.delete(sessionKey);
}

export async function clearLumiiLoginState(): Promise<void> {
  activeLogins.clear();
  await rm(LUMII_STATE_DIR, { recursive: true, force: true });
}
