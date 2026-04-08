/**
 * Loads OpenClaw channel helper functions for ClawX host API routes.
 *
 * Packaged builds put openclaw under resources/openclaw/ (extraResources). Static
 * `import from 'openclaw/...'` would resolve inside the asar incorrectly, so we
 * use createRequire from the resolved openclaw package root.
 *
 * Recent OpenClaw releases dropped package.json "exports" entries such as
 * `openclaw/plugin-sdk/discord`; the same logic now lives in hashed dist/*.js
 * files. We locate those files via stable substring markers, then require()
 * them by absolute path. Telegram directory listers are rebuilt using
 * `createInspectedDirectoryEntriesLister` from `openclaw/plugin-sdk/directory-runtime`
 * so we never load the heavy `channel-*.js` graph (grammy, etc.).
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getOpenClawDir, getOpenClawResolvedDir } from './paths';
import { resolveOpenClawDistFile } from './openclaw-dist-resolve';

const _openclawPath = getOpenClawDir();
const _openclawResolvedPath = getOpenClawResolvedDir();
const _openclawDist = join(_openclawResolvedPath, 'dist');

const _openclawSdkRequire = createRequire(join(_openclawResolvedPath, 'package.json'));
const _projectSdkRequire = createRequire(join(_openclawPath, 'package.json'));

function requireOpenClawPackageExport(subpath: string): Record<string, unknown> {
  try {
    return _openclawSdkRequire(subpath);
  } catch {
    return _projectSdkRequire(subpath);
  }
}

function requireOpenClawDistAbs(absPath: string): Record<string, unknown> {
  return _openclawSdkRequire(absPath) as Record<string, unknown>;
}

/** Discord directory listers (hashed chunk name changes between OpenClaw releases). */
const _discordDir = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'discord-directory',
    'listDiscordDirectoryPeersFromConfig as a, listDiscordDirectoryGroupsFromConfig as i',
    (n) => n.startsWith('status-issues-'),
  ),
);
const _discordNorm = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'discord-normalize',
    'normalizeDiscordMessagingTarget as n',
    (n) =>
      n.startsWith('normalize-') &&
      !n.startsWith('normalize-target-') &&
      !n.startsWith('normalize-reply-'),
  ),
);

const _slackDir = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'slack-directory',
    // Export order in threading-tool-context-*.js is groups → peers, not peers → groups.
    'listSlackDirectoryPeersFromConfig as r',
    (n) => n.startsWith('threading-tool-context-'),
  ),
);
const _slackNorm = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'slack-normalize',
    'normalizeSlackMessagingTarget as n',
    (n) => n.startsWith('slack-targets-'),
  ),
);

const _waNorm = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'whatsapp-normalize',
    'normalizeWhatsAppAllowFromEntries as n, normalizeWhatsAppMessagingTarget as r',
    (n) => n.startsWith('whatsapp-') && !n.includes('targets'),
  ),
);

const { createInspectedDirectoryEntriesLister } = requireOpenClawPackageExport(
  'openclaw/plugin-sdk/directory-runtime',
) as {
  createInspectedDirectoryEntriesLister: (p: {
    kind: 'user' | 'group';
    inspectAccount: (cfg: unknown, accountId: string | undefined) => unknown;
    resolveSources: (account: {
      config: { allowFrom?: unknown; dms?: Record<string, unknown>; groups?: Record<string, unknown> };
    }) => unknown[];
    normalizeId: (entry: string) => string | null;
  }) => (configParams: unknown) => Promise<unknown[]>;
};

const _accountInspectTg = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'telegram-account-inspect',
    'export { inspectTelegramAccount as t }',
    (n) => n.startsWith('account-inspect-'),
  ),
);
const inspectTelegramAccount = _accountInspectTg.t as (params: {
  cfg: unknown;
  accountId: string | undefined;
}) => { config: { allowFrom?: unknown; dms?: Record<string, unknown>; groups?: Record<string, unknown> } };

const _chHelpers = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'channel-config-helpers',
    'mapAllowFromEntries as g',
    (n) => n.startsWith('channel-config-helpers-'),
  ),
);
const mapAllowFromEntries = _chHelpers.g as (allowFrom: unknown) => unknown[];

const _tgTargets = requireOpenClawDistAbs(
  resolveOpenClawDistFile(
    _openclawDist,
    'telegram-targets',
    'parseTelegramTarget as i',
    (n) => n.startsWith('targets-') && n.endsWith('.js'),
  ),
);
const parseTelegramTarget = _tgTargets.i as (raw: string) => {
  chatId: string;
  messageThreadId?: number | null;
};
const normalizeTelegramLookupTarget = _tgTargets.r as (chatId: string) => string | undefined;

const TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;
function normalizeTelegramTargetBody(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const prefixStripped = trimmed.replace(TELEGRAM_PREFIX_RE, '').trim();
  if (!prefixStripped) return;
  const parsed = parseTelegramTarget(trimmed);
  const normalizedChatId = normalizeTelegramLookupTarget(parsed.chatId);
  if (!normalizedChatId) return;
  const keepLegacyGroupPrefix = /^group:/i.test(prefixStripped);
  const hasTopicSuffix = /:topic:\d+$/i.test(prefixStripped);
  const chatSegment = keepLegacyGroupPrefix ? `group:${normalizedChatId}` : normalizedChatId;
  if (parsed.messageThreadId == null) return chatSegment;
  return `${chatSegment}${hasTopicSuffix ? `:topic:${parsed.messageThreadId}` : `:${parsed.messageThreadId}`}`;
}

function normalizeTelegramMessagingTarget(raw: string): string | undefined {
  const normalizedBody = normalizeTelegramTargetBody(raw);
  if (!normalizedBody) return;
  return `telegram:${normalizedBody}`.toLowerCase();
}

const listTelegramDirectoryPeersFromConfig = createInspectedDirectoryEntriesLister({
  kind: 'user',
  inspectAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
  resolveSources: (account) => [
    mapAllowFromEntries(account.config.allowFrom),
    Object.keys(account.config.dms ?? {}),
  ],
  normalizeId: (entry: string) => {
    const trimmed = entry.replace(/^(telegram|tg):/i, '').trim();
    if (!trimmed) return null;
    if (/^-?\d+$/.test(trimmed)) return trimmed;
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  },
});

const listTelegramDirectoryGroupsFromConfig = createInspectedDirectoryEntriesLister({
  kind: 'group',
  inspectAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
  resolveSources: (account) => [Object.keys(account.config.groups ?? {})],
  normalizeId: (entry: string) => entry.trim() || null,
});

export const listDiscordDirectoryPeersFromConfig = _discordDir.a as (params: unknown) => Promise<unknown[]>;
export const listDiscordDirectoryGroupsFromConfig = _discordDir.i as (params: unknown) => Promise<unknown[]>;

export const normalizeDiscordMessagingTarget = _discordNorm.n as (target: string) => string | undefined;

export { listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, normalizeTelegramMessagingTarget };

export const listSlackDirectoryPeersFromConfig = _slackDir.r as (params: unknown) => Promise<unknown[]>;
export const listSlackDirectoryGroupsFromConfig = _slackDir.n as (params: unknown) => Promise<unknown[]>;

export const normalizeSlackMessagingTarget = _slackNorm.n as (target: string) => string | undefined;

export const normalizeWhatsAppMessagingTarget = _waNorm.r as (target: string) => string | undefined;
