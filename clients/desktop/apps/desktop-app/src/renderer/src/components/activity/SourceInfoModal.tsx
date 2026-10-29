import { useEffect, useState, type JSX } from 'react';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { DialogModal } from '../shared/DialogModal';

interface SourceInfoModalProps<TEntry, TRequest, TInfo> {
  /** Caller-supplied entry; passed to `buildRequest` and `loadInfo`. */
  entry: TEntry;
  title: string;
  subtitle: string;
  titleId: string;
  /** Error string surfaced when `buildRequest` returns null. */
  missingRequestMessage: string;
  /** Empty-state copy passed through to {@link renderLayers}. */
  emptyText: string;
  /** Build the IPC request payload. Return null to short-circuit with
   * `missingRequestMessage`. */
  buildRequest: (entry: TEntry) => TRequest | null;
  /** Resolves the IPC info payload from a request. Errors surface via the
   * `Failed to load source info` fallback. */
  loadInfo: (request: TRequest) => Promise<TInfo>;
  /** Caller renders the per-info body using its own layer/section primitives.
   * Receives the loaded info plus the shared `emptyText` so the consumer can
   * pass it directly to `SourceInfoLayers`. */
  renderLayers: (info: TInfo, emptyText: string) => JSX.Element;
  onClose: () => void;
}

/**
 * Shared "source info" modal used by both {@link HooksSection} and
 * {@link ScriptsSection}. Owns the dialog chrome, request-build/short-circuit
 * pattern, IPC fetch with cancellation, loading spinner, and rose-tinted
 * fetch-error string. Layer rendering is delegated back to the caller via
 * `renderLayers` so each section keeps its section-specific body — hooks
 * render hook actions, scripts render commands.
 */
export function SourceInfoModal<TEntry, TRequest, TInfo>({
  entry,
  title,
  subtitle,
  titleId,
  missingRequestMessage,
  emptyText,
  buildRequest,
  loadInfo,
  renderLayers,
  onClose,
}: SourceInfoModalProps<TEntry, TRequest, TInfo>): JSX.Element {
  const [info, setInfo] = useState<TInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);

    const request = buildRequest(entry);
    if (!request) {
      setFetchError(missingRequestMessage);
      setLoading(false);
      return;
    }

    void loadInfo(request)
      .then((response) => {
        if (cancelled) return;
        setInfo(response);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFetchError(
          cause instanceof Error ? cause.message : 'Failed to load source info',
        );
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
    };
  }, [entry, buildRequest, loadInfo, missingRequestMessage]);

  return (
    <DialogModal
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      titleId={titleId}
      maxWidth="md"
    >
      <div className="p-5 pt-3">
        {loading && (
          <div className="flex justify-center py-4">
            <LoadingSpinner />
          </div>
        )}
        {fetchError && (
          <div className="text-xs fg-destructive-strong">{fetchError}</div>
        )}
        {info && renderLayers(info, emptyText)}
      </div>
    </DialogModal>
  );
}
