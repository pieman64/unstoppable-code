'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsListSkeleton,
} from '@canopy/ui-shared/components';
import { Copy, Plus, Trash2 } from '@canopy/ui-shared/icons/AppIcons';
import type {
  UserApiKeyListItem,
  UserApiKeySource,
} from '@canopy/protocol/settings/account';
import {
  useSettingsClient,
  useSettingsHost,
  useSettingsPrivacy,
} from '../host';
import { withPrivacyClass } from './privacy-class';
import { useSettingsErrorCopy } from '../errors';

const API_KEYS_ERROR_SCOPE = 'api-keys-panel';

/**
 * Human-facing label for each key provenance value the list shows:
 *
 * - `MANUAL`: created by a user through the API-keys UI.
 * - `OAUTH_DESKTOP`: minted by the desktop OAuth-style sign-in flow.
 *
 * Raw tokens and SHA-256 hashes are NEVER part of a list row — only the
 * metadata needed to render rows, surface provenance, and identify keys for
 * deletion. A created key's `token` is the only raw `csk_…` value ever sent
 * to the client; the panel keeps it strictly in component state and clears
 * it on `Done` / unmount. It is never written to localStorage /
 * sessionStorage / IndexedDB.
 */
const SOURCE_LABELS: Partial<Record<UserApiKeySource, string>> = {
  MANUAL: 'Manual',
  OAUTH_DESKTOP: 'Desktop OAuth',
};

type PanelStatus = 'loading' | 'ready' | 'error';

interface ApiKeysManagerProps {
  brandDisplayName: string;
  /** Render the "API keys" heading. Off when a modal already supplies a title. */
  showHeading?: boolean;
}

interface ApiKeysPanelProps {
  brandDisplayName: string;
}

function formatDate(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString();
}

/**
 * Build the per-key metadata line:
 * `Created {createdAt} · {sourceLabel} · IP {createdIpOrUnknown} · {lastUsedText}`
 *
 * - `createdIpOrUnknown` is the raw IP string or `Unknown` when absent.
 * - `lastUsedText` is `Last used {lastUsedAt}` or `Never used`.
 */
export function formatApiKeyMetadata(key: UserApiKeyListItem): string {
  const sourceLabel = SOURCE_LABELS[key.source] ?? key.source;
  const createdIpOrUnknown =
    key.createdIp && key.createdIp.trim().length > 0
      ? key.createdIp
      : 'Unknown';
  const lastUsedText = key.lastUsedAt
    ? `Last used ${formatDate(key.lastUsedAt)}`
    : 'Never used';
  return `Created ${formatDate(key.createdAt)} · ${sourceLabel} · IP ${createdIpOrUnknown} · ${lastUsedText}`;
}

/**
 * Section-chrome wrapper around {@link ApiKeysManager}. Retained for callers
 * that want the standalone card; the dashboard no longer renders it (API keys
 * now live as a panel on the account details page), but it stays exported for
 * tests and any future standalone placement.
 */
export function ApiKeysPanel({
  brandDisplayName,
}: ApiKeysPanelProps): JSX.Element {
  return (
    <section className="rounded-xl bg-card p-8 shadow-sm">
      <ApiKeysManager brandDisplayName={brandDisplayName} />
    </section>
  );
}

/**
 * API key list/create/revoke management content, without outer card chrome so
 * it can render inside the dashboard section or the account details page panel.
 */
export function ApiKeysManager({
  brandDisplayName,
  showHeading = true,
}: ApiKeysManagerProps): JSX.Element {
  const client = useSettingsClient();
  const host = useSettingsHost();
  const logger = useMemo(() => host.logger(API_KEYS_ERROR_SCOPE), [host]);
  const errorCopy = useSettingsErrorCopy(API_KEYS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  const [status, setStatus] = useState<PanelStatus>('loading');
  const [keys, setKeys] = useState<UserApiKeyListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createdToken, setCreatedToken] = useState<{
    token: string;
    userApiKey: UserApiKeyListItem;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);

  const clearCopiedTimeout = useCallback((): void => {
    if (copiedTimeoutRef.current) {
      window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = null;
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus('loading');
      setLoadError(null);
      setError(null);
      const data = await client.read('account.apiKeys.list', {});
      setKeys(Array.isArray(data) ? data : []);
      setStatus('ready');
    } catch (err: unknown) {
      setStatus('error');
      setLoadError(errorCopy.loadCopy(err));
    }
  }, [client, errorCopy]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [refresh]);

  useEffect(() => {
    return clearCopiedTimeout;
  }, [clearCopiedTimeout]);

  const handleStartCreate = (): void => {
    setCreating(true);
    setNewName('');
    setError(null);
  };

  const handleCancelCreate = (): void => {
    setCreating(false);
    setNewName('');
  };

  const handleSubmitCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      setSubmitting(true);
      setError(null);
      const data = await client.write('account.apiKeys.create', { name });
      setCreatedToken({ token: data.token, userApiKey: data.userApiKey });
      setKeys((prev) => [data.userApiKey, ...prev]);
      setCreating(false);
      setNewName('');
    } catch (err: unknown) {
      setError(errorCopy.actionCopy(err, { action: 'create the API key' }));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken.token);
      clearCopiedTimeout();
      setCopied(true);
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimeoutRef.current = null;
      }, 1500);
    } catch (err: unknown) {
      logger.error('Failed to copy token to clipboard', { error: err });
    }
  };

  const handleDoneToken = (): void => {
    clearCopiedTimeout();
    setCreatedToken(null);
    setCopied(false);
  };

  const handleRequestDelete = (id: string): void => {
    setPendingDeleteId(id);
  };

  const handleCancelDelete = (): void => {
    setPendingDeleteId(null);
  };

  const handleConfirmDelete = async (id: string): Promise<void> => {
    try {
      setDeletingId(id);
      setError(null);
      await client.write('account.apiKeys.revoke', { apiKeyId: id });
      setKeys((prev) => prev.filter((k) => k.id !== id));
      setPendingDeleteId(null);
    } catch (err: unknown) {
      setError(errorCopy.actionCopy(err, { action: 'revoke the API key' }));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {showHeading && (
            <h2 className="text-xl font-semibold fg-primary">API keys</h2>
          )}
          <p className="mt-1 max-w-xl text-s fg-secondary">
            Create manual API keys for {brandDisplayName} clients and review
            keys created by desktop OAuth sign-in. Newly created manual keys are
            shown once and stored only as a secure hash.
          </p>
        </div>
        {!creating && !createdToken && (
          <button
            type="button"
            onClick={handleStartCreate}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90"
          >
            <Plus size={14} />
            Create manual API key
          </button>
        )}
      </header>

      <ErrorBanner
        className="mt-4"
        error={loadError}
        onRetry={() => void refresh()}
      />
      <ErrorBanner className="mt-4" error={error} />

      {createdToken && (
        <div
          className="mt-4 rounded-md border bg-secondary p-4"
          aria-live="polite"
        >
          <p className="text-s font-medium fg-primary">
            Copy this API key now. It will not be shown again.
          </p>
          <p className="mt-1 text-xs fg-secondary">
            Name: {createdToken.userApiKey.name}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code
              className={withPrivacyClass(
                'flex-1 overflow-x-auto rounded-md border bg-card px-3 py-2 font-mono text-xs fg-primary',
                blockClassName,
              )}
            >
              {createdToken.token}
            </code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary"
            >
              <Copy size={14} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={handleDoneToken}
              className="rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {creating && (
        <form
          onSubmit={(event) => void handleSubmitCreate(event)}
          className="mt-4 flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-s fg-secondary">
            <span className="font-medium fg-primary">Name</span>
            <input
              type="text"
              autoFocus
              required
              maxLength={256}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="rounded-md border bg-card px-3 py-2 text-s fg-primary"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={submitting || !newName.trim()}
              className="rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create manual API key'}
            </button>
            <button
              type="button"
              onClick={handleCancelCreate}
              className="rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-6">
        {status === 'loading' && (
          <DelayedLoadingPlaceholder>
            <SettingsListSkeleton rows={2} />
          </DelayedLoadingPlaceholder>
        )}
        {status === 'ready' && keys.length === 0 && !creating && (
          <p className="text-s fg-secondary">No API keys yet.</p>
        )}
        {status === 'ready' && keys.length > 0 && (
          <ul className="divide-y rounded-md border">
            {keys.map((key) => (
              <ApiKeyRow
                key={key.id}
                apiKey={key}
                pendingDelete={pendingDeleteId === key.id}
                deleting={deletingId === key.id}
                onRequestDelete={handleRequestDelete}
                onConfirmDelete={(id) => void handleConfirmDelete(id)}
                onCancelDelete={handleCancelDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface ApiKeyRowProps {
  apiKey: UserApiKeyListItem;
  pendingDelete: boolean;
  deleting: boolean;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
}

/**
 * Presentational row for a single API key. Renders the key name, the
 * provenance/IP/last-used metadata line, and the delete affordance. Kept as a
 * standalone export so it can be unit-tested without driving the list-loading
 * fetch in {@link ApiKeysPanel}.
 */
export function ApiKeyRow({
  apiKey,
  pendingDelete,
  deleting,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: ApiKeyRowProps): JSX.Element {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-s font-medium fg-primary">{apiKey.name}</p>
        <p className="text-xs fg-secondary">{formatApiKeyMetadata(apiKey)}</p>
      </div>
      {pendingDelete ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onConfirmDelete(apiKey.id)}
            disabled={deleting}
            className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            disabled={deleting}
            className="rounded-md border px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onRequestDelete(apiKey.id)}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-secondary"
        >
          <Trash2 size={14} />
          Delete
        </button>
      )}
    </li>
  );
}
