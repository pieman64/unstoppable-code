import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '@canopy/ui-shared/components';
import { getDocument, getWindow } from '@canopy/ui-shared/panels';
import type { FilePreviewResponse } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { FileIcon } from '@canopy/ui-shared/icons';
import { getFilenameFromPath } from '@/lib/file-type';
import { useGitHubStore } from '@/stores/githubStore';

// ---------------------------------------------------------------------------
// Position calculation
// ---------------------------------------------------------------------------

interface PopoverPosition {
  /** Set when the popover hangs below the anchor (grows downward). */
  top?: number;
  /**
   * Set when the popover sits above the anchor (grows upward). Anchoring the
   * BOTTOM edge is load-bearing: preview content (notably images) loads
   * asynchronously after the popover mounts, and a top-anchored popover
   * grows downward over the pill it is anchored to.
   */
  bottom?: number;
  left: number;
  maxHeight: number;
}

const POPOVER_WIDTH = 280;
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 8;
const MIN_USEFUL_HEIGHT = 48;

function computePopoverPosition(
  anchorEl: HTMLElement,
  placement: 'auto' | 'above',
): PopoverPosition {
  const rect = anchorEl.getBoundingClientRect();
  const view = getWindow(anchorEl);
  const left = Math.min(
    Math.max(VIEWPORT_PADDING, rect.left + rect.width / 2 - POPOVER_WIDTH / 2),
    view.innerWidth - POPOVER_WIDTH - VIEWPORT_PADDING,
  );
  const availableAbove = rect.top - POPOVER_GAP - VIEWPORT_PADDING;
  const availableBelow =
    view.innerHeight - rect.bottom - POPOVER_GAP - VIEWPORT_PADDING;

  const preferAbove =
    placement === 'above'
      ? availableAbove > MIN_USEFUL_HEIGHT
      : availableAbove >= availableBelow;

  if (preferAbove) {
    return {
      bottom: view.innerHeight - rect.top + POPOVER_GAP,
      left,
      maxHeight: Math.max(MIN_USEFUL_HEIGHT, availableAbove),
    };
  }
  return {
    top: rect.bottom + POPOVER_GAP,
    left,
    maxHeight: Math.max(MIN_USEFUL_HEIGHT, availableBelow),
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ImagePreview({ src }: { src: string }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex items-center justify-center bg-fg-primary/[0.02] p-2">
      {!loaded && (
        <div className="h-30 w-full animate-pulse rounded bg-fg-primary/[0.06]" />
      )}
      <img
        src={src}
        alt=""
        className={`max-h-50 max-w-full rounded object-contain${loaded ? '' : ' hidden'}`}
        onLoad={(): void => setLoaded(true)}
      />
    </div>
  );
}

function TruncatedLabel(): JSX.Element {
  return (
    <div className="px-2 pb-2 pt-1 text-3xs italic fg-secondary">
      Preview truncated
    </div>
  );
}

function TextPreview({
  content,
  truncated,
}: {
  content: string;
  truncated: boolean;
}): JSX.Element {
  return (
    <div className="max-h-50 overflow-y-auto">
      <pre className="whitespace-pre-wrap break-words p-2 font-mono text-2xs leading-relaxed fg-primary/80">
        {content}
      </pre>
      {truncated && <TruncatedLabel />}
    </div>
  );
}

function MarkdownPreview({
  content,
  truncated,
}: {
  content: string;
  truncated: boolean;
}): JSX.Element {
  return (
    <div className="max-h-50 overflow-y-auto">
      <div className="p-2 text-xs fg-primary/80">
        <Markdown>{content}</Markdown>
      </div>
      {truncated && <TruncatedLabel />}
    </div>
  );
}

function UnsupportedPreview(): JSX.Element {
  return (
    <div className="flex h-20 items-center justify-center text-xs fg-secondary">
      Preview not available
    </div>
  );
}

function LoadingSkeleton(): JSX.Element {
  return (
    <div className="space-y-2 p-3">
      <div className="h-3 w-3/4 animate-pulse rounded bg-fg-primary/[0.06]" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-fg-primary/[0.06]" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-fg-primary/[0.06]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main popover
// ---------------------------------------------------------------------------

interface AttachmentPreviewPopoverProps {
  absolutePath: string;
  filename?: string;
  sizeBytes?: number;
  createdAt?: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: 'auto' | 'above';
  onOpen?: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export const AttachmentPreviewPopover = memo(function AttachmentPreviewPopover({
  absolutePath,
  filename,
  sizeBytes,
  createdAt,
  anchorRef,
  placement = 'auto',
  onOpen,
  onMouseEnter,
  onMouseLeave,
}: AttachmentPreviewPopoverProps): JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<FilePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const addToast = useGitHubStore((state) => state.addToast);

  const displayName = filename ?? getFilenameFromPath(absolutePath);
  const displaySizeBytes = sizeBytes ?? preview?.sizeBytes;

  // Fetch preview content
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);

    void window.api
      .readFilePreview({ absolutePath })
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Unable to load preview');
          setLoading(false);
        }
      });

    return (): void => {
      cancelled = true;
    };
  }, [absolutePath]);

  // Position calculation. Edge-anchored (top XOR bottom), so async preview
  // growth extends away from the anchor and never needs re-measuring.
  const updatePosition = useCallback((): void => {
    const anchorEl = anchorRef.current;
    if (!anchorEl) return;
    const next = computePopoverPosition(anchorEl, placement);
    setPosition((prev) => {
      if (
        prev &&
        prev.top === next.top &&
        prev.bottom === next.bottom &&
        prev.left === next.left &&
        prev.maxHeight === next.maxHeight
      ) {
        return prev;
      }
      return next;
    });
  }, [anchorRef, placement]);

  useEffect(() => {
    updatePosition();
  }, [updatePosition, preview, loading, error]);

  useEffect(() => {
    const view = getWindow(anchorRef.current);
    const onScroll = (): void => updatePosition();
    const onResize = (): void => updatePosition();
    view.addEventListener('scroll', onScroll, true);
    view.addEventListener('resize', onResize);
    return (): void => {
      view.removeEventListener('scroll', onScroll, true);
      view.removeEventListener('resize', onResize);
    };
  }, [updatePosition, anchorRef]);

  // CAN-2707: `Open` used to route through `chatStore.openFileTab`, which
  // no-ops whenever there is no selected worktree — the New Task screen's
  // normal state — leaving a clickable, inert control. Handing the path to the
  // system default application works from every surface the popover renders
  // on, and a rejected open surfaces instead of disappearing.
  //
  // `shell.openExternal` on a `file://`
  // URL can resolve even when nothing opens, so the error path is best-effort
  // rather than deterministic. Both desktop window roots mount the shared
  // toast surface, so failures remain visible in the App Advisor popout too.
  const handleOpen = useCallback((): void => {
    if (onOpen) {
      onOpen();
      return;
    }
    void window.api.openExternalFile({ absolutePath }).catch(() => {
      addToast(`Couldn't open ${displayName}.`, 'error', undefined, {
        forceInApp: true,
      });
    });
  }, [absolutePath, addToast, displayName, onOpen]);

  if (!position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-canopy-browser-native-overlay="true"
      className="z-dropdown flex w-70 flex-col overflow-hidden rounded-lg bg-popover shadow-lg"
      style={{
        position: 'fixed',
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
      }}
    >
      {/* Header */}
      <div className="shrink-0 border-b px-3 py-2">
        <div className="truncate text-xs font-medium fg-primary">
          {displayName}
        </div>
        {displaySizeBytes !== undefined && (
          <div className="text-3xs fg-secondary">
            {formatFileSize(displaySizeBytes)}
          </div>
        )}
        {createdAt !== undefined && (
          <div className="text-3xs fg-secondary">
            Created {new Date(createdAt).toLocaleString()}
          </div>
        )}
      </div>

      {/* Preview body. Portaled to the body, out of the composer's and
          transcript's replay blocks, so it carries its own: the attachment's
          contents. The header (name, size) and footer stay recorded. */}
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-auto`}
        data-selectable
        data-testid="attachment-preview-body"
      >
        {loading && <LoadingSkeleton />}
        {error && (
          <div className="flex h-20 items-center justify-center text-xs fg-secondary">
            {error}
          </div>
        )}
        {preview && !loading && !error && (
          <>
            {preview.kind === 'image' && <ImagePreview src={preview.content} />}
            {preview.kind === 'text' && (
              <TextPreview
                content={preview.content}
                truncated={preview.truncated}
              />
            )}
            {preview.kind === 'markdown' && (
              <MarkdownPreview
                content={preview.content}
                truncated={preview.truncated}
              />
            )}
            {preview.kind === 'unsupported' && <UnsupportedPreview />}
          </>
        )}
      </div>

      {/* Footer */}
      <button
        type="button"
        onClick={handleOpen}
        className="flex w-full shrink-0 items-center gap-1.5 border-t px-3 py-2 text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.04] hover:fg-primary"
      >
        <FileIcon width={12} height={12} />
        Open
      </button>
    </div>,
    getDocument(anchorRef.current).body,
  );
});

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
