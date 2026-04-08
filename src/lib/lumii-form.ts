/**
 * Lumii (openclaw-lumii) form normalization — shared by ChannelConfigModal and Chat login.
 * Aligns with openclaw-lumii plugin env: METAIO_LOGIN_MODE, METAIO_USERNAME, METAIO_PASSWORD.
 */
export function normalizeOpenclawLumiiFormValues(values: Record<string, string>): Record<string, string> {
  const next = { ...values };
  if (!next.metaioLoginMode?.trim() && next.loginMode?.trim()) {
    next.metaioLoginMode = next.loginMode.trim();
  }
  if (!next.metaioLoginMode?.trim()) {
    next.metaioLoginMode = 'password';
  }
  if (!next.metaioUsername?.trim() && next.username?.trim()) {
    next.metaioUsername = next.username.trim();
  }
  if (!next.metaioPassword?.trim() && next.password?.trim()) {
    next.metaioPassword = next.password.trim();
  }
  return next;
}
