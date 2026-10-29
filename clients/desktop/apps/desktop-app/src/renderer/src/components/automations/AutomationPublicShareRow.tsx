import { type JSX, useEffect, useState } from 'react';
import type { SharedAutomationPublicShareInfo } from '@canopy/protocol/automations';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  resolveSharedAutomationUrl,
  AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT,
} from '@/lib/share-links';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';

interface AutomationPublicShareRowProps {
  remoteId: string;
  initialShare?: SharedAutomationPublicShareInfo | null;
  canManage?: boolean;
}

const PUBLISH_FAILURE_LABEL = 'Failed to publish public link.';
const REVOKE_FAILURE_LABEL = 'Failed to remove public link.';

/**
 * Public-link management for an already-shared automation, rendered on the
 * shared-resource preview rather than the local automation.
 *
 * Structural clone of `PipelinePublicShareRow`, with three deltas the two
 * APIs force: the automations IPC throws instead of returning `IPCResult`
 * envelopes, the share URL resolves through `resolveSharedAutomationUrl`, and
 * every mutation dispatches `AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT` so the
 * Shared tab re-reads the row it is showing.
 */
export function AutomationPublicShareRow({
  remoteId,
  initialShare,
  canManage = true,
}: AutomationPublicShareRowProps): JSX.Element {
  const [share, setShare] = useState(initialShare ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setShare(initialShare ?? null), [initialShare, remoteId]);
  useEffect(() => {
    let cancelled = false;
    setCopied(false);
    setUrl(null);
    if (!share) return undefined;
    void resolveSharedAutomationUrl(share.sharePath).then((resolved): void => {
      if (!cancelled) setUrl(resolved ?? share.sharePath);
    });
    return (): void => {
      cancelled = true;
    };
  }, [share]);

  async function publish(): Promise<void> {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.api.automations.publishPublicShare(remoteId);
      setShare(next);
      window.dispatchEvent(new Event(AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT));
    } catch (err: unknown) {
      setError(
        resolveSharedResourceErrorMessage(err, {
          unsupportedResource: 'automations',
        }) || PUBLISH_FAILURE_LABEL,
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.automations.revokePublicShare(remoteId);
      setShare(null);
      window.dispatchEvent(new Event(AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT));
    } catch (err: unknown) {
      setError(
        resolveSharedResourceErrorMessage(err, {
          unsupportedResource: 'automations',
        }) || REVOKE_FAILURE_LABEL,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!canManage && !share) return <></>;

  return (
    <div
      data-testid="automation-public-share-row"
      className="flex items-center gap-2 border-b bg-secondary/40 px-4 py-2 text-xs"
    >
      <span className="font-medium fg-primary">Public link</span>
      {!share ? (
        canManage && (
          <button
            type="button"
            data-testid="automation-public-share-publish"
            disabled={busy}
            onClick={() => void publish()}
            className="rounded-md border px-2 py-1 fg-primary disabled:opacity-50"
          >
            Publish
          </button>
        )
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate fg-secondary">{url}</span>
          <button
            type="button"
            data-testid="automation-public-share-copy"
            disabled={!url || busy}
            onClick={() => {
              if (url) void copyTextToClipboard(url).then(setCopied);
            }}
            className="rounded-md border px-2 py-1 fg-primary disabled:opacity-50"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          {canManage && !share.upToDate && (
            <button
              type="button"
              data-testid="automation-public-share-update"
              disabled={busy}
              onClick={() => void publish()}
              className="rounded-md border px-2 py-1 fg-primary disabled:opacity-50"
            >
              Update to latest
            </button>
          )}
          {canManage && (
            <button
              type="button"
              data-testid="automation-public-share-revoke"
              disabled={busy}
              onClick={() => void revoke()}
              className="rounded-md border border-line-destructive/40 px-2 py-1 fg-destructive disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </>
      )}
      {error && (
        <span
          className="fg-destructive"
          role="alert"
          data-testid="automation-public-share-error"
        >
          {error}
        </span>
      )}
    </div>
  );
}
