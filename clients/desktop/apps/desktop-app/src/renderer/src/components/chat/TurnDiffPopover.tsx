import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ChangedFileInfo,
  FileDiffImagePreview,
  TurnDiffData,
  TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';
import { DiffContentView } from '../activity/DiffContentView';
import { Tooltip } from '@canopy/ui-shared';
import { PencilIcon as AppCatalogPencilIcon } from '@canopy/ui-shared/icons/AppIcons';

interface PopoverPosition {
  top: number;
  left: number;
}

const POPOVER_WIDTH = 560;
const POPOVER_HEIGHT = 360;
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 8;

function findTreeRef(
  file: ChangedFileInfo,
  treeRefs: TurnDiffTreeRef[],
): TurnDiffTreeRef | undefined {
  if (treeRefs.length === 1) return treeRefs[0];
  return treeRefs.find((ref) => ref.repoId === file.repoId);
}

function computePopoverPosition(anchorEl: HTMLElement): PopoverPosition {
  const rect = anchorEl.getBoundingClientRect();

  // Place above the pill unless too close to the top of the viewport
  const fitsAbove = rect.top > POPOVER_HEIGHT + POPOVER_GAP;
  const rawTop = fitsAbove
    ? rect.top - POPOVER_GAP - POPOVER_HEIGHT
    : rect.bottom + POPOVER_GAP;
  const top = Math.max(
    VIEWPORT_PADDING,
    Math.min(rawTop, window.innerHeight - POPOVER_HEIGHT - VIEWPORT_PADDING),
  );

  const left = Math.min(
    Math.max(VIEWPORT_PADDING, rect.left + rect.width / 2 - POPOVER_WIDTH / 2),
    window.innerWidth - POPOVER_WIDTH - VIEWPORT_PADDING,
  );

  return { top, left };
}

interface TurnDiffPopoverProps {
  file: ChangedFileInfo;
  turnDiff: TurnDiffData;
  projectId: string;
  worktreeId: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpenModal: () => void;
  onEdit: () => void;
}

export const TurnDiffPopover = memo(function TurnDiffPopover({
  file,
  turnDiff,
  projectId,
  worktreeId,
  anchorRef,
  onMouseEnter,
  onMouseLeave,
  onOpenModal,
  onEdit,
}: TurnDiffPopoverProps): JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const [oldValue, setOldValue] = useState('');
  const [newValue, setNewValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [binary, setBinary] = useState(false);
  const [imagePreview, setImagePreview] = useState<
    FileDiffImagePreview | undefined
  >(undefined);

  // Fetch diff on mount
  useEffect(() => {
    setLoading(true);
    let cancelled = false;

    const treeRefs = turnDiff.treeRefs ?? [];
    const treeRef =
      treeRefs.length > 0 ? findTreeRef(file, treeRefs) : undefined;

    const diffPromise = treeRef
      ? window.api.activity.getTurnFileDiff({
          projectId,
          worktreeId,
          filePath: file.path,
          startTree: treeRef.startTree,
          endTree: treeRef.endTree,
          repoId: file.repoId,
        })
      : window.api.activity.getFileDiff({
          projectId,
          worktreeId,
          filePath: file.path,
          source: 'combined',
          repoId: file.repoId,
        });

    void diffPromise
      .then((response) => {
        if (cancelled) return;
        setOldValue(response.oldValue);
        setNewValue(response.newValue);
        setTruncated(response.truncated);
        setBinary(response.binary);
        setImagePreview(response.imagePreview);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setOldValue('');
        setNewValue('');
        setTruncated(false);
        setBinary(false);
        setImagePreview(undefined);
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
    };
  }, [file, projectId, worktreeId, turnDiff.treeRefs]);

  // Position calculation — uses fixed POPOVER_HEIGHT so position is stable
  const updatePosition = useCallback((): void => {
    const anchorEl = anchorRef.current;
    if (!anchorEl) return;
    const next = computePopoverPosition(anchorEl);
    setPosition((prev) => {
      if (prev && prev.top === next.top && prev.left === next.left) return prev;
      return next;
    });
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return (): void => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  // Re-anchor when the hovered file changes (instant switch updates anchorRef)
  useEffect(() => {
    updatePosition();
  }, [file, updatePosition]);

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 'var(--z-index-dropdown)',
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    visibility: position ? 'visible' : 'hidden',
    ...(position ? { top: position.top, left: position.left } : {}),
  };

  // Portaled to `document.body`, out of the transcript's replay block. The
  // header (file path, counts, actions) is recorded; `DiffContentView` blocks
  // the diff itself.
  return createPortal(
    <div
      ref={popoverRef}
      data-canopy-browser-native-overlay="true"
      className="flex flex-col overflow-hidden rounded-lg bg-popover shadow-xl"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-xs font-medium fg-primary">
            {file.path}
          </span>
          <span className="shrink-0 text-2xs font-medium tabular-nums">
            <span className="fg-success">+{file.insertions}</span>
            <span className="ml-1 fg-destructive">-{file.deletions}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label="Open full diff view">
            <button
              type="button"
              onClick={onOpenModal}
              className="rounded px-2 py-0.5 text-2xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
            >
              Expand
            </button>
          </Tooltip>
          <Tooltip label="Open file in editor">
            <button
              type="button"
              onClick={onEdit}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-2xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
            >
              <AppCatalogPencilIcon width="11" height="11" />
              Edit
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Diff content */}
      <div className="diff-popover-compact flex min-h-0 flex-1">
        <DiffContentView
          oldValue={oldValue}
          newValue={newValue}
          viewMode="unified"
          loading={loading}
          truncated={truncated}
          binary={binary}
          imagePreview={imagePreview}
        />
      </div>
    </div>,
    document.body,
  );
});
