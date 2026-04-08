/**
 * Resolve hashed OpenClaw dist/*.js chunks by searching for stable export markers.
 * OpenClaw no longer exposes channel helpers at package "exports" subpaths like
 * `openclaw/plugin-sdk/discord`; those live in content-addressed dist files instead.
 */
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RESOLVED_DIST_FILE_CACHE = new Map<string, string>();

const DIST_TAIL_READ_BYTES = 220_000;

function readOpenClawDistFileSlice(absPath: string): string {
  const st = statSync(absPath);
  if (st.size <= DIST_TAIL_READ_BYTES) {
    return readFileSync(absPath, 'utf8');
  }
  const buf = Buffer.alloc(Math.min(DIST_TAIL_READ_BYTES, st.size));
  const fd = openSync(absPath, 'r');
  try {
    readSync(fd, buf, 0, buf.length, st.size - buf.length);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

export function resolveOpenClawDistFile(
  openclawDistDir: string,
  cacheKey: string,
  marker: string,
  nameFilter: (name: string) => boolean,
): string {
  const ck = `${openclawDistDir}\0${cacheKey}`;
  const hit = RESOLVED_DIST_FILE_CACHE.get(ck);
  if (hit) return hit;

  for (const name of readdirSync(openclawDistDir)) {
    if (!name.endsWith('.js') || !nameFilter(name)) continue;
    const abs = join(openclawDistDir, name);
    const slice = readOpenClawDistFileSlice(abs);
    if (slice.includes(marker)) {
      RESOLVED_DIST_FILE_CACHE.set(ck, abs);
      return abs;
    }
  }

  throw new Error(
    `OpenClaw dist: could not find a module for "${cacheKey}" (marker lost after openclaw upgrade?).`,
  );
}
