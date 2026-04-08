/**
 * Lumii (Metaio) login / logout on the Chat page — saves openclaw-lumii channel config after successful login.
 */
import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { LogIn, LogOut, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { normalizeOpenclawLumiiFormValues } from '@/lib/lumii-form';
import { CHANNEL_NAMES } from '@/types/channel';
import { useChannelsStore } from '@/stores/channels';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const LUMII_CHANNEL = 'openclaw-lumii';

function hasMeaningfulLumiiLocalForm(values: Record<string, string> | undefined): boolean {
  if (!values || Object.keys(values).length === 0) return false;
  const mode = (values.metaioLoginMode ?? 'password').trim().toLowerCase();
  if (mode === 'qr') return true;
  return Boolean(values.metaioUsername?.trim());
}

interface ChannelAccountItem {
  accountId: string;
  name: string;
  configured: boolean;
}

interface ChannelGroupItem {
  channelType: string;
  defaultAccountId: string;
  accounts: ChannelAccountItem[];
}

export function LumiiAccountBar() {
  const { t } = useTranslation('chat');
  const channels = useChannelsStore((s) => s.channels);
  const addChannel = useChannelsStore((s) => s.addChannel);
  const fetchChannels = useChannelsStore((s) => s.fetchChannels);

  const [loading, setLoading] = useState(true);
  /** True when openclaw.json has a Lumii account section (not only gateway runtime). */
  const [hasLocalLumiiConfig, setHasLocalLumiiConfig] = useState(false);
  const [localFormValues, setLocalFormValues] = useState<Record<string, string> | null>(null);
  const [lumiiGroup, setLumiiGroup] = useState<ChannelGroupItem | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [res, cfgRes] = await Promise.all([
        hostApiFetch<{ success: boolean; channels?: ChannelGroupItem[] }>('/api/channels/accounts'),
        hostApiFetch<{ success: boolean; values?: Record<string, string> }>(
          `/api/channels/config/${encodeURIComponent(LUMII_CHANNEL)}`,
        ),
      ]);

      const values = cfgRes.success ? cfgRes.values : undefined;
      setLocalFormValues(values ?? null);
      setHasLocalLumiiConfig(hasMeaningfulLumiiLocalForm(values));

      if (!res.success || !res.channels) {
        setLumiiGroup(null);
        return;
      }
      const g = res.channels.find((c) => c.channelType === LUMII_CHANNEL);
      setLumiiGroup(g ?? null);
    } catch {
      setLumiiGroup(null);
      setLocalFormValues(null);
      setHasLocalLumiiConfig(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = subscribeHostEvent('gateway:channel-status', () => {
      void refresh();
    });
    return off;
  }, [refresh]);

  const primaryAccount =
    lumiiGroup?.accounts.find((a) => a.accountId === lumiiGroup.defaultAccountId)
    ?? lumiiGroup?.accounts.find((a) => a.configured)
    ?? lumiiGroup?.accounts[0];

  const displayLabel =
    primaryAccount?.name
    ?? localFormValues?.metaioAccountDisplayName?.trim()
    ?? localFormValues?.metaioUsername?.trim()
    ?? '';

  async function syncSidebarChannelList() {
    const existing = channels.find((c) => c.type === LUMII_CHANNEL);
    if (!existing) {
      await addChannel({
        type: LUMII_CHANNEL,
        name: CHANNEL_NAMES[LUMII_CHANNEL],
        token: undefined,
      });
    } else {
      await fetchChannels();
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    const u = username.trim();
    const p = password;
    if (!u || !p) {
      toast.error(t('lumii.missingCredentials'));
      return;
    }

    setSubmitting(true);
    try {
      const configFlat: Record<string, string> = normalizeOpenclawLumiiFormValues({
        metaioLoginMode: 'password',
        metaioUsername: u,
        metaioPassword: p,
        channelUiNote: '',
      });

      const validationResponse = await hostApiFetch<{
        success?: boolean;
        valid?: boolean;
        errors?: string[];
        details?: Record<string, string>;
      }>('/api/channels/credentials/validate', {
        method: 'POST',
        body: JSON.stringify({
          channelType: LUMII_CHANNEL,
          config: configFlat,
        }),
      });

      if (!validationResponse.valid) {
        toast.error(validationResponse.errors?.[0] || t('lumii.loginFailed'));
        return;
      }

      const metaioUid = validationResponse.details?.metaioUid?.trim();
      const metaioDisplayName = validationResponse.details?.metaioDisplayName?.trim();
      if (!metaioUid) {
        toast.error(t('lumii.noUid'));
        return;
      }

      const config: Record<string, unknown> = {
        ...configFlat,
        enabled: true,
        ...(metaioDisplayName ? { metaioAccountDisplayName: metaioDisplayName } : {}),
      };

      const saveResult = await hostApiFetch<{ success?: boolean; error?: string }>('/api/channels/config', {
        method: 'POST',
        body: JSON.stringify({
          channelType: LUMII_CHANNEL,
          config,
          accountId: metaioUid,
        }),
      });

      if (!saveResult?.success) {
        throw new Error(saveResult?.error || 'save failed');
      }

      await syncSidebarChannelList();
      await refresh();
      setDialogOpen(false);
      setPassword('');
      toast.success(t('lumii.loginSuccess'));
    } catch (err) {
      toast.error(t('lumii.loginFailedWithError', { error: String(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      if (lumiiGroup?.accounts?.length) {
        for (const acc of lumiiGroup.accounts) {
          const suffix = `?accountId=${encodeURIComponent(acc.accountId)}`;
          try {
            await hostApiFetch(`/api/channels/config/${encodeURIComponent(LUMII_CHANNEL)}${suffix}`, {
              method: 'DELETE',
            });
          } catch {
            /** Removing the last account clears the whole section; later deletes may 404. */
          }
        }
      } else {
        await hostApiFetch(`/api/channels/config/${encodeURIComponent(LUMII_CHANNEL)}`, {
          method: 'DELETE',
        });
      }
      await fetchChannels();
      await refresh();
      toast.success(t('lumii.logoutSuccess'));
    } catch (err) {
      toast.error(t('lumii.logoutFailed', { error: String(err) }));
    } finally {
      setLoggingOut(false);
    }
  }

  if (loading && !dialogOpen) {
    return (
      <div
        className="h-9 w-36 shrink-0 animate-pulse rounded-md bg-muted/50"
        data-testid="lumii-home-auth-skeleton"
        aria-hidden
      />
    );
  }

  return (
    <div className="flex min-w-0 shrink items-center gap-2" data-testid="lumii-home-auth">
      {hasLocalLumiiConfig ? (
        <>
          <span
            className="max-w-[200px] truncate text-[13px] text-muted-foreground"
            title={displayLabel || undefined}
          >
            {displayLabel}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2.5"
            data-testid="lumii-logout-button"
            disabled={loggingOut}
            onClick={() => void handleLogout()}
          >
            {loggingOut ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
            {t('lumii.logout')}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 px-2.5"
          data-testid="lumii-login-button"
          onClick={() => setDialogOpen(true)}
        >
          <LogIn className="h-3.5 w-3.5" />
          {t('lumii.login')}
        </Button>
      )}

      {dialogOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          data-testid="lumii-login-dialog-backdrop"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setDialogOpen(false);
          }}
        >
          <Card
            className="w-full max-w-md shadow-lg"
            onMouseDown={(ev) => ev.stopPropagation()}
          >
            <CardHeader className="space-y-1">
              <CardTitle className="text-lg">{t('lumii.dialogTitle')}</CardTitle>
              <CardDescription>{t('lumii.dialogDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={(e) => void handleLogin(e)}>
                <div className="space-y-2">
                  <Label htmlFor="lumii-home-username">{t('lumii.username')}</Label>
                  <Input
                    id="lumii-home-username"
                    autoComplete="username"
                    value={username}
                    onChange={(ev) => setUsername(ev.target.value)}
                    placeholder={t('lumii.usernamePlaceholder')}
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lumii-home-password">{t('lumii.password')}</Label>
                  <Input
                    id="lumii-home-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    placeholder={t('lumii.passwordPlaceholder')}
                    className="h-10"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDialogOpen(false)}>
                    {t('lumii.cancel')}
                  </Button>
                  <Button type="submit" size="sm" disabled={submitting}>
                    {submitting ? (
                      <>
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        {t('lumii.connecting')}
                      </>
                    ) : (
                      t('lumii.submit')
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
