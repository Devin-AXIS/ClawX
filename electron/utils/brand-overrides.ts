import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type BrandOverrides = {
  appName?: string;
  logoDataUrl?: string;
  customCss?: string;
  cssVariables?: Record<string, string>;
  iconFileName?: string;
  configPath: string;
};

const DEFAULT_ICON_CANDIDATES = ['brand-icon.png', 'brand-icon.ico', 'brand-icon.icns'];

function parseJsonSafe(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function getBrandOverridesPath(): string {
  return join(app.getPath('userData'), 'brand-overrides.json');
}

export function readBrandOverrides(): BrandOverrides {
  const configPath = getBrandOverridesPath();
  if (!existsSync(configPath)) {
    return { configPath };
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = parseJsonSafe(raw);
  if (!parsed) {
    return { configPath };
  }

  const cssVariablesRaw = parsed.cssVariables;
  const cssVariables: Record<string, string> = {};
  if (cssVariablesRaw && typeof cssVariablesRaw === 'object') {
    for (const [key, value] of Object.entries(cssVariablesRaw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        cssVariables[key] = value;
      }
    }
  }

  return {
    appName: typeof parsed.appName === 'string' ? parsed.appName : undefined,
    logoDataUrl: typeof parsed.logoDataUrl === 'string' ? parsed.logoDataUrl : undefined,
    customCss: typeof parsed.customCss === 'string' ? parsed.customCss : undefined,
    cssVariables: Object.keys(cssVariables).length > 0 ? cssVariables : undefined,
    iconFileName: typeof parsed.iconFileName === 'string' ? parsed.iconFileName : undefined,
    configPath,
  };
}

export function resolveOverrideIconPath(): string | null {
  const overrides = readBrandOverrides();
  const userDataDir = app.getPath('userData');
  const candidates = [
    ...(overrides.iconFileName ? [overrides.iconFileName] : []),
    ...DEFAULT_ICON_CANDIDATES,
  ];
  for (const fileName of candidates) {
    const fullPath = join(userDataDir, fileName);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}
