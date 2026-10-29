'use client';

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import {
  GitHubIcon,
  Globe,
  Lock,
  Mail,
  Shield,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  GoogleIcon,
  SingleSignOnIcon,
  UnstoppableDomainsIcon,
} from '@canopy/ui-shared/icons';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsFormSkeleton,
} from '@canopy/ui-shared/components';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  CREDENTIAL_PROVIDER_ID,
  LAST_AUTH_SOURCE_ERROR,
  SOCIAL_PROVIDER_IDS,
  SSO_SERVER_PROVIDER_ID,
  UD_PROVIDER_ID,
  authSourceLabel,
  isAuthSourcesResponse,
  type AuthProviderId,
  type AuthSource,
  type AuthSourcesResponse,
  type SocialProviderId,
} from '@canopy/protocol/settings/account';
import { useSettingsClient, useSettingsNavigation } from '../host';
import { TwoFactorSetupPanel } from './two-factor-setup-panel';
import { ApiKeysManager } from './api-keys-panel';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';

const SECURITY_ERROR_SCOPE = 'settings.account.security';
const PASSWORD_SAVED = 'Password saved.';

/** Failures of removing a sign-in method that have their own copy. */
const REMOVE_AUTH_SOURCE_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The route refuses to remove the account's last sign-in method.
    status: 400,
    copy: LAST_AUTH_SOURCE_ERROR,
  },
];

type Status = 'loading' | 'ready' | 'error';

export interface SecurityPanelProps {
  brandDisplayName: string;
  emailPasswordAuthEnabled: boolean;
}

/** Human-friendly linked-on date; falls back to the raw value when unparseable. */
export function formatLinkedDate(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleDateString();
}

/**
 * "Security" tab content: sign-in methods (with set/change password), two-factor
 * setup, and API keys. Owns the auth-sources fetch that drives the sign-in-method
 * list and the credential/2FA state.
 */
export function SecurityPanel({
  brandDisplayName,
  emailPasswordAuthEnabled,
}: SecurityPanelProps): JSX.Element {
  const client = useSettingsClient();
  const navigation = useSettingsNavigation();
  const errorCopy = useSettingsErrorCopy(SECURITY_ERROR_SCOPE);
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<AuthSourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const body: unknown = await client.read(
        'account.security.authSources',
        {},
      );
      if (!isAuthSourcesResponse(body)) {
        throw new Error('Invalid auth sources response');
      }
      setData(body);
      setStatus('ready');
    } catch (err: unknown) {
      setStatus('error');
      setError(errorCopy.loadCopy(err));
    }
  }, [client, errorCopy]);

  const retry = (): void => {
    // Back to the loading placeholder while the read runs again.
    setStatus('loading');
    setError(null);
    void refresh();
  };

  useEffect(() => {
    // Defer the initial load out of the synchronous effect body so the fetch's
    // setState does not trigger a cascading render (mirrors ApiKeysPanel).
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [refresh]);

  const sources = (data?.sources ?? []).filter(
    (source) =>
      emailPasswordAuthEnabled || source.providerId !== CREDENTIAL_PROVIDER_ID,
  );
  const hasCredential = sources.some(
    (s) => s.providerId === CREDENTIAL_PROVIDER_ID,
  );
  const linkedProviders = new Set(sources.map((s) => s.providerId));

  const handleLink = (provider: SocialProviderId): void => {
    // The host owns the provider round trip. On web the OAuth callback
    // returns to `/account`; the unchanged session token + valid completion
    // cookie let the protected gate pass without re-prompting.
    navigation.openOAuth(provider);
  };

  return (
    <section className="flex flex-col gap-6">
      {status === 'loading' && (
        <DelayedLoadingPlaceholder>
          <SettingsFormSkeleton rows={3} />
        </DelayedLoadingPlaceholder>
      )}

      <ErrorBanner
        className=""
        error={status === 'error' ? error : null}
        onRetry={retry}
      />

      {status === 'ready' && data && (
        <>
          <SettingsCard icon={<Shield size={18} />} title="Sign-in methods">
            <ul className="divide-y rounded-md border">
              {sources.map((source) => (
                <AuthSourceRow
                  key={source.accountId}
                  source={source}
                  onRemoved={() => void refresh()}
                />
              ))}
              {sources.length === 0 && (
                <li className="px-4 py-3 text-s fg-secondary">
                  No sign-in methods found.
                </li>
              )}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {SOCIAL_PROVIDER_IDS.map((provider) =>
                linkedProviders.has(provider) ? null : (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => handleLink(provider)}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary"
                  >
                    Link {authSourceLabel(provider)}
                  </button>
                ),
              )}
            </div>

            {emailPasswordAuthEnabled && (
              <div className="mt-6 border-t pt-6">
                <PasswordSection
                  hasCredential={hasCredential}
                  onChanged={() => void refresh()}
                />
              </div>
            )}
          </SettingsCard>

          <TwoFactorSetupPanel
            twoFactorEnabled={data.user.twoFactorEnabled}
            hasCredential={hasCredential}
            brandDisplayName={brandDisplayName}
            onChanged={() => void refresh()}
          />
        </>
      )}

      {/* Rendered outside the auth-sources `status` conditional so API keys
          always show and manage their own fetch — an auth-sources load
          failure must not hide this panel. */}
      <SettingsCard
        icon={<Lock size={18} />}
        title="API keys"
        testId="account-api-keys-section"
      >
        <ApiKeysManager
          brandDisplayName={brandDisplayName}
          showHeading={false}
        />
      </SettingsCard>
    </section>
  );
}

/**
 * Provider glyph for a login-method row. Social providers render their real
 * brand logos (shared with the login page), Canopy SSO renders the neutral
 * key mark, and email/password plus unrecognized providers fall back to neutral
 * UI Kit marks.
 */
function AuthSourceIcon({
  providerId,
}: {
  providerId: AuthProviderId;
}): JSX.Element {
  switch (providerId) {
    case 'google':
      return <GoogleIcon size={16} />;
    case 'github':
      return <GitHubIcon size={16} />;
    case UD_PROVIDER_ID:
      return <UnstoppableDomainsIcon size={16} />;
    // Explicit case, not the `Globe` default: without it an SSO row renders the
    // fallback globe and every test still passes.
    case SSO_SERVER_PROVIDER_ID:
      return <SingleSignOnIcon size={16} />;
    case CREDENTIAL_PROVIDER_ID:
      return (
        <Mail
          size={16}
          className="fg-secondary"
          aria-hidden="true"
          data-testid="auth-source-mail-icon"
        />
      );
    default:
      return <Globe size={16} className="fg-secondary" aria-hidden="true" />;
  }
}

interface AuthSourceRowProps {
  source: AuthSource;
  onRemoved: () => void;
}

/** A single linked sign-in method with its remove affordance / confirmation. */
export function AuthSourceRow({
  source,
  onRemoved,
}: AuthSourceRowProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(SECURITY_ERROR_SCOPE);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async (): Promise<void> => {
    setRemoving(true);
    setError(null);
    try {
      await client.write('account.security.unlinkAuthSource', {
        providerId: source.providerId,
        accountId: source.accountId,
      });
    } catch (err: unknown) {
      setError(
        errorCopy.actionCopy(err, {
          action: 'remove this sign-in method',
          known: REMOVE_AUTH_SOURCE_KNOWN_ERRORS,
        }),
      );
      setRemoving(false);
      return;
    }
    onRemoved();
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <AuthSourceIcon providerId={source.providerId} />
        <div className="min-w-0">
          <p className="text-s font-medium fg-primary">{source.label}</p>
          <p className="text-xs fg-secondary">
            Linked {formatLinkedDate(source.linkedAt)}
          </p>
          {error && (
            <p className="mt-1 text-xs fg-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      {!source.canUnlink ? (
        <span className="text-xs fg-secondary">
          Add another method before removing
        </span>
      ) : confirming ? (
        <div className="flex flex-col items-end gap-1">
          <span className="text-xs fg-primary">
            Remove this sign-in method?
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={removing}
              className="rounded-md bg-destructive px-3 py-1.5 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={removing}
              className="rounded-md border px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md border px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-secondary"
        >
          Remove
        </button>
      )}
    </li>
  );
}

interface PasswordSectionProps {
  hasCredential: boolean;
  onChanged: () => void;
}

/**
 * Set-password (OAuth-only users) or change-password (credential users) form.
 *
 * `setPassword` is server-only, so the set flow goes through Canopy's
 * `/api/account/password` route (`account.security.setPassword`); the change
 * flow is Better Auth's `changePassword` (`account.security.changePassword`).
 */
export function PasswordSection({
  hasCredential,
  onChanged,
}: PasswordSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(SECURITY_ERROR_SCOPE);
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const close = (): void => {
    setOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setError(null);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      if (hasCredential) {
        await client.write('account.security.changePassword', {
          currentPassword,
          newPassword,
        });
      } else {
        await client.write('account.security.setPassword', { newPassword });
      }
      setSaved(true);
      close();
      onChanged();
    } catch (err: unknown) {
      setError(errorCopy.actionCopy(err, { action: 'save the password' }));
      setSubmitting(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setSaved(false);
          }}
          className="self-start rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary"
        >
          {hasCredential ? 'Change password' : 'Set password'}
        </button>
        {saved && (
          <p className="text-s fg-secondary" role="status">
            {PASSWORD_SAVED}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex max-w-sm flex-col gap-3"
    >
      {hasCredential && (
        <label className="flex flex-col gap-1 text-s fg-secondary">
          <span className="font-medium fg-primary">Current password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={submitting}
            className="rounded-md border bg-card px-3 py-2 text-s fg-primary disabled:opacity-50"
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-s fg-secondary">
        <span className="font-medium fg-primary">New password</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={submitting}
          className="rounded-md border bg-card px-3 py-2 text-s fg-primary disabled:opacity-50"
        />
      </label>

      {error && (
        <p className="text-s fg-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save password'}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={submitting}
          className="rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
