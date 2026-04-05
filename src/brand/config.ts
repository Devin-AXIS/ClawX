export type LumiiThemeTokenOverrides = {
  lightBackgroundHsl?: string;
  darkBackgroundHsl?: string;
  primaryHsl?: string;
};

export type LumiiBrandConfig = {
  appName: string;
  packageName: string;
  desktopAppId: string;
  marketingName: string;
  website?: string;
  supportEmail?: string;
  theme: LumiiThemeTokenOverrides;
};

/**
 * Single source of truth for Lumii branding overlays.
 *
 * Keep this file small and stable.
 * Downstream code should read from this module instead of hardcoding brand strings.
 */
export const lumiiBrandConfig: LumiiBrandConfig = {
  appName: 'Lumii',
  packageName: 'lumii-desktop',
  desktopAppId: 'app.lumii.desktop',
  marketingName: 'Lumii',
  website: 'https://lumii.ai',
  supportEmail: 'support@lumii.ai',
  theme: {
    lightBackgroundHsl: '45 36.4% 91.4%',
    darkBackgroundHsl: '240 4% 11%',
    primaryHsl: '221.2 83.2% 53.3%',
  },
};

