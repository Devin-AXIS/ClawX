export type RuntimeBrandOverrides = {
  appName?: string;
  logoDataUrl?: string;
  customCss?: string;
  cssVariables?: Record<string, string>;
  configPath?: string;
};

let runtimeBrandOverrides: RuntimeBrandOverrides = {};

export function setRuntimeBrandOverrides(overrides: RuntimeBrandOverrides): void {
  runtimeBrandOverrides = { ...overrides };
}

export function getRuntimeBrandOverrides(): RuntimeBrandOverrides {
  return runtimeBrandOverrides;
}
