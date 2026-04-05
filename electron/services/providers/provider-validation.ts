import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { getProviderConfig } from '../../utils/provider-registry';

type ValidationProfile =
  | 'openai-completions'
  | 'openai-responses'
  | 'google-query-key'
  | 'anthropic-header'
  | 'openrouter'
  | 'none';

type ValidationResult = { valid: boolean; error?: string; status?: number };
export type DiscoveredProviderModel = { id: string; name: string };

function logValidationStatus(provider: string, status: number): void {
  console.log(`[clawx-validate] ${provider} HTTP ${status}`);
}

function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return `${secret.slice(0, 2)}***`;
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

function sanitizeValidationUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const key = url.searchParams.get('key');
    if (key) url.searchParams.set('key', maskSecret(key));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  if (next.Authorization?.startsWith('Bearer ')) {
    const token = next.Authorization.slice('Bearer '.length);
    next.Authorization = `Bearer ${maskSecret(token)}`;
  }
  if (next['x-api-key']) {
    next['x-api-key'] = maskSecret(next['x-api-key']);
  }
  return next;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function buildOpenAiModelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models?limit=1`;
}

function resolveOpenAiProbeUrls(
  baseUrl: string,
  apiProtocol: 'openai-completions' | 'openai-responses',
): { modelsUrl: string; probeUrl: string } {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const endpointSuffixPattern = /(\/responses?|\/chat\/completions)$/;
  const rootBase = normalizedBase.replace(endpointSuffixPattern, '');
  const modelsUrl = buildOpenAiModelsUrl(rootBase);

  if (apiProtocol === 'openai-responses') {
    const probeUrl = /(\/responses?)$/.test(normalizedBase)
      ? normalizedBase
      : `${rootBase}/responses`;
    return { modelsUrl, probeUrl };
  }

  const probeUrl = /\/chat\/completions$/.test(normalizedBase)
    ? normalizedBase
    : `${rootBase}/chat/completions`;
  return { modelsUrl, probeUrl };
}

function logValidationRequest(
  provider: string,
  method: string,
  url: string,
  headers: Record<string, string>,
): void {
  console.log(
    `[clawx-validate] ${provider} request ${method} ${sanitizeValidationUrl(url)} headers=${JSON.stringify(sanitizeHeaders(headers))}`,
  );
}

function getValidationProfile(
  providerType: string,
  options?: { apiProtocol?: string }
): ValidationProfile {
  const providerApi = options?.apiProtocol || getProviderConfig(providerType)?.api;
  if (providerApi === 'anthropic-messages') {
    return 'anthropic-header';
  }
  if (providerApi === 'openai-responses') {
    return 'openai-responses';
  }
  if (providerApi === 'openai-completions') {
    return 'openai-completions';
  }

  switch (providerType) {
    case 'anthropic':
      return 'anthropic-header';
    case 'google':
      return 'google-query-key';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
      return 'none';
    default:
      return 'openai-completions';
  }
}

async function performProviderValidationRequest(
  providerLabel: string,
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    logValidationRequest(providerLabel, 'GET', url, headers);
    const response = await proxyAwareFetch(url, { headers });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));
    const result = classifyAuthResponse(response.status, data);
    return { ...result, status: response.status };
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function classifyAuthResponse(
  status: number,
  data: unknown,
): { valid: boolean; error?: string } {
  if (status >= 200 && status < 300) return { valid: true };
  if (status === 429) return { valid: true };
  if (status === 401 || status === 403) return { valid: false, error: 'Invalid API key' };

  const obj = data as { error?: { message?: string }; message?: string } | null;
  const msg = obj?.error?.message || obj?.message || `API error: ${status}`;
  return { valid: false, error: msg };
}

async function validateOpenAiCompatibleKey(
  providerType: string,
  apiKey: string,
  apiProtocol: 'openai-completions' | 'openai-responses',
  baseUrl?: string,
): Promise<ValidationResult> {
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) {
    return { valid: false, error: `Base URL is required for provider "${providerType}" validation` };
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  const { modelsUrl, probeUrl } = resolveOpenAiProbeUrls(trimmedBaseUrl, apiProtocol);
  const modelsResult = await performProviderValidationRequest(providerType, modelsUrl, headers);

  if (modelsResult.status === 404) {
    console.log(
      `[clawx-validate] ${providerType} /models returned 404, falling back to ${apiProtocol} probe`,
    );
    if (apiProtocol === 'openai-responses') {
      return await performResponsesProbe(providerType, probeUrl, headers);
    }
    return await performChatCompletionsProbe(providerType, probeUrl, headers);
  }

  return modelsResult;
}

async function performResponsesProbe(
  providerLabel: string,
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    logValidationRequest(providerLabel, 'POST', url, headers);
    const response = await proxyAwareFetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        input: 'hi',
      }),
    });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }
    if (
      (response.status >= 200 && response.status < 300) ||
      response.status === 400 ||
      response.status === 429
    ) {
      return { valid: true };
    }
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function performChatCompletionsProbe(
  providerLabel: string,
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    logValidationRequest(providerLabel, 'POST', url, headers);
    const response = await proxyAwareFetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }
    if (
      (response.status >= 200 && response.status < 300) ||
      response.status === 400 ||
      response.status === 429
    ) {
      return { valid: true };
    }
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function performAnthropicMessagesProbe(
  providerLabel: string,
  url: string,
  headers: Record<string, string>,
): Promise<ValidationResult> {
  try {
    logValidationRequest(providerLabel, 'POST', url, headers);
    const response = await proxyAwareFetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }
    if (
      (response.status >= 200 && response.status < 300) ||
      response.status === 400 ||
      response.status === 429
    ) {
      return { valid: true };
    }
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function validateGoogleQueryKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ValidationResult> {
  const base = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  const url = `${base}/models?pageSize=1&key=${encodeURIComponent(apiKey)}`;
  return await performProviderValidationRequest(providerType, url, {});
}

async function validateAnthropicHeaderKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ValidationResult> {
  const rawBase = normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1');
  const base = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`;
  const url = `${base}/models?limit=1`;
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  const modelsResult = await performProviderValidationRequest(providerType, url, headers);

  // If the endpoint doesn't implement /models (like Minimax Anthropic compatibility), fallback to a /messages probe.
  if (
    modelsResult.status === 404 ||
    modelsResult.status === 400 ||
    modelsResult.error?.includes('API error: 404') ||
    modelsResult.error?.includes('API error: 400')
  ) {
    console.log(
      `[clawx-validate] ${providerType} /models returned error, falling back to /messages probe`,
    );
    const messagesUrl = `${base}/messages`;
    return await performAnthropicMessagesProbe(providerType, messagesUrl, headers);
  }

  return modelsResult;
}

async function validateOpenRouterKey(
  providerType: string,
  apiKey: string,
): Promise<ValidationResult> {
  const url = 'https://openrouter.ai/api/v1/auth/key';
  const headers = { Authorization: `Bearer ${apiKey}` };
  return await performProviderValidationRequest(providerType, url, headers);
}

export async function validateApiKeyWithProvider(
  providerType: string,
  apiKey: string,
  options?: { baseUrl?: string; apiProtocol?: string },
): Promise<ValidationResult> {
  const profile = getValidationProfile(providerType, options);
  const resolvedBaseUrl = options?.baseUrl || getProviderConfig(providerType)?.baseUrl;

  if (profile === 'none') {
    return { valid: true };
  }

  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { valid: false, error: 'API key is required' };
  }

  try {
    switch (profile) {
      case 'openai-completions':
        return await validateOpenAiCompatibleKey(
          providerType,
          trimmedKey,
          'openai-completions',
          resolvedBaseUrl,
        );
      case 'openai-responses':
        return await validateOpenAiCompatibleKey(
          providerType,
          trimmedKey,
          'openai-responses',
          resolvedBaseUrl,
        );
      case 'google-query-key':
        return await validateGoogleQueryKey(providerType, trimmedKey, resolvedBaseUrl);
      case 'anthropic-header':
        return await validateAnthropicHeaderKey(providerType, trimmedKey, resolvedBaseUrl);
      case 'openrouter':
        return await validateOpenRouterKey(providerType, trimmedKey);
      default:
        return { valid: false, error: `Unsupported validation profile for provider: ${providerType}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { valid: false, error: errorMessage };
  }
}

function normalizeDiscoveredModels(
  items: Array<{ id?: unknown; name?: unknown }>,
): DiscoveredProviderModel[] {
  const result: DiscoveredProviderModel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
    result.push({ id, name });
  }
  return result;
}

async function discoverOpenAiCompatibleModels(
  providerType: string,
  apiKey: string,
  apiProtocol: 'openai-completions' | 'openai-responses',
  baseUrl?: string,
): Promise<{ models: DiscoveredProviderModel[]; error?: string }> {
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) {
    return { models: [], error: `Base URL is required for provider "${providerType}"` };
  }
  const { modelsUrl } = resolveOpenAiProbeUrls(trimmedBaseUrl, apiProtocol);
  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    logValidationRequest(providerType, 'GET', modelsUrl, headers);
    const response = await proxyAwareFetch(modelsUrl, { headers });
    logValidationStatus(providerType, response.status);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const classified = classifyAuthResponse(response.status, payload);
      return { models: [], error: classified.error || `API error: ${response.status}` };
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { models: [], error: 'Model list response has invalid format' };
    }
    return {
      models: normalizeDiscoveredModels(
        data.map((model) => {
          const obj = model as Record<string, unknown>;
          const id = typeof obj.id === 'string' ? obj.id : undefined;
          const name =
            (typeof obj.name === 'string' && obj.name)
            || (typeof obj.display_name === 'string' ? obj.display_name : undefined)
            || id;
          return { id, name };
        }),
      ),
    };
  } catch (error) {
    return {
      models: [],
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function discoverAnthropicModels(
  providerType: string,
  apiKey: string,
  baseUrl?: string,
): Promise<{ models: DiscoveredProviderModel[]; error?: string }> {
  const rawBase = normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1');
  const base = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`;
  const modelsUrl = `${base}/models?limit=100`;
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  try {
    logValidationRequest(providerType, 'GET', modelsUrl, headers);
    const response = await proxyAwareFetch(modelsUrl, { headers });
    logValidationStatus(providerType, response.status);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const classified = classifyAuthResponse(response.status, payload);
      return { models: [], error: classified.error || `API error: ${response.status}` };
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { models: [], error: 'Model list response has invalid format' };
    }
    return {
      models: normalizeDiscoveredModels(
        data.map((model) => {
          const obj = model as Record<string, unknown>;
          const id = typeof obj.id === 'string' ? obj.id : undefined;
          const name =
            (typeof obj.display_name === 'string' && obj.display_name)
            || (typeof obj.name === 'string' ? obj.name : undefined)
            || id;
          return { id, name };
        }),
      ),
    };
  } catch (error) {
    return {
      models: [],
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function discoverGoogleModels(
  providerType: string,
  apiKey: string,
  baseUrl?: string,
): Promise<{ models: DiscoveredProviderModel[]; error?: string }> {
  const base = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  const url = `${base}/models?pageSize=100&key=${encodeURIComponent(apiKey)}`;
  try {
    logValidationRequest(providerType, 'GET', url, {});
    const response = await proxyAwareFetch(url);
    logValidationStatus(providerType, response.status);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const classified = classifyAuthResponse(response.status, payload);
      return { models: [], error: classified.error || `API error: ${response.status}` };
    }
    const models = (payload as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      return { models: [], error: 'Model list response has invalid format' };
    }
    return {
      models: normalizeDiscoveredModels(
        models.map((model) => {
          const obj = model as Record<string, unknown>;
          const rawName = typeof obj.name === 'string' ? obj.name : '';
          const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName;
          const name = typeof obj.displayName === 'string' ? obj.displayName : id;
          return { id, name };
        }),
      ),
    };
  } catch (error) {
    return {
      models: [],
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function discoverModelsWithProvider(
  providerType: string,
  apiKey: string,
  options?: { baseUrl?: string; apiProtocol?: string },
): Promise<{ models: DiscoveredProviderModel[]; error?: string }> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { models: [], error: 'API key is required' };
  }
  const profile = getValidationProfile(providerType, options);
  const resolvedBaseUrl = options?.baseUrl || getProviderConfig(providerType)?.baseUrl;
  switch (profile) {
    case 'openai-completions':
      return await discoverOpenAiCompatibleModels(providerType, trimmedKey, 'openai-completions', resolvedBaseUrl);
    case 'openai-responses':
      return await discoverOpenAiCompatibleModels(providerType, trimmedKey, 'openai-responses', resolvedBaseUrl);
    case 'anthropic-header':
      return await discoverAnthropicModels(providerType, trimmedKey, resolvedBaseUrl);
    case 'google-query-key':
      return await discoverGoogleModels(providerType, trimmedKey, resolvedBaseUrl);
    case 'openrouter':
      return await discoverOpenAiCompatibleModels(providerType, trimmedKey, 'openai-completions', 'https://openrouter.ai/api/v1');
    case 'none':
      return { models: [] };
    default:
      return { models: [], error: `Unsupported model discovery profile for provider: ${providerType}` };
  }
}
