import { type JSX, useEffect, useState } from 'react';
import type { SharedPipelinePublicShareInfo } from '@canopy/desktop-shared/types/pipeline';
import { Button } from '@canopy/ui-shared/components';
import { copyTextToClipboard } from '@/lib/clipboard';
import { resolveSharedPipelineUrl } from '@/lib/share-links';
import { ErrorBanner } from '@canopy/ui-shared/components';

interface PipelinePublicShareRowProps {
  remoteId: string;
  initialShare?: SharedPipelinePublicShareInfo | null;
  canManage?: boolean;
}

export function PipelinePublicShareRow({
  remoteId,
  initialShare,
  canManage = true,
}: PipelinePublicShareRowProps): JSX.Element {
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
    void resolveSharedPipelineUrl(share.sharePath).then((resolved): void => {
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
      const result = await window.pipelines.publishPublicShare(remoteId);
      if (result.success && result.data) setShare(result.data);
      else setError(result.error ?? 'Failed to publish public link.');
    } catch {
      setError('Failed to publish public link.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.pipelines.revokePublicShare(remoteId);
      if (result.success) setShare(null);
      else setError(result.error ?? 'Failed to remove public link.');
    } catch {
      setError('Failed to remove public link.');
    } finally {
      setBusy(false);
    }
  }

  if (!canManage && !share) return <></>;

  return (
    <div
      data-testid="pipeline-public-share-row"
      className="flex items-center gap-2 border-b bg-secondary/40 px-4 py-2 text-xs"
    >
      <span className="font-medium fg-primary">Public link</span>
      {!share ? (
        canManage && (
          <Button size="compact" disabled={busy} onClick={() => void publish()}>
            Publish
          </Button>
        )
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate fg-secondary">{url}</span>
          <Button
            size="compact"
            disabled={!url || busy}
            onClick={() => {
              if (url) void copyTextToClipboard(url).then(setCopied);
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {canManage && !share.upToDate && (
            <Button
              size="compact"
              disabled={busy}
              onClick={() => void publish()}
            >
              Update to latest
            </Button>
          )}
          {canManage && (
            <Button
              size="compact"
              disabled={busy}
              variant="ghost-destructive"
              onClick={() => void revoke()}
            >
              Remove
            </Button>
          )}
        </>
      )}
      <ErrorBanner className="" error={error} />
    </div>
  );
}
