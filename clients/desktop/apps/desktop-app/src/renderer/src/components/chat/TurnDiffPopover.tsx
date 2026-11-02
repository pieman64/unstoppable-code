import {
  memo,
  useCallback,
  useEffect,
  useMemo,
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
import {
  DiffTurnUnavailableState,
  HeaderActionButton,
} from '@canopy/ui-shared/components';
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

  const treeRefs = turnDiff.treeRefs;
  const treeRef = useMemo(
    () =>
      treeRefs && treeRefs.length > 0 ? findTreeRef(file, treeRefs) : undefined,
    [file, treeRefs],
  );

  // Only the turn's own trees: without them no other comparison stands in.
  useEffect(() => {
    if (!treeRef) return;
    setLoading(true);
    let cancelled = false;

    void window.api.activity
      .getTurnFileDiff({
        projectId,
        worktreeId,
        filePath: file.path,
        startTree: treeRef.startTree,
        endTree: treeRef.endTree,
        repoId: file.repoId,
      })
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
  }, [file, projectId, worktreeId, treeRef]);

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
  //
  // The menu's floating surface (12px corners, menu shadow). Header actions
  // and the diff well sit 4px in, with 8px corners nested in the card's 12px
  // ones; the path lands on the preview cards' 12px text edge.
  return createPortal(
    <div
      ref={popoverRef}
      data-testid="turn-diff-popover"
      data-canopy-browser-native-overlay="true"
      className="flex flex-col gap-1 overflow-hidden rounded-lg bg-quaternary p-1 fg-primary shadow-xl"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2 pl-2">
        <span className="min-w-0 truncate text-xs font-medium fg-primary">
          {file.path}
        </span>
        <span className="shrink-0 text-2xs font-medium tabular-nums">
          <span className="fg-success">+{file.insertions}</span>
          <span className="ml-1 fg-destructive">-{file.deletions}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <HeaderActionButton
            tone="neutral"
            tooltipLabel="Open full diff view"
            onClick={onOpenModal}
          >
            Expand
          </HeaderActionButton>
          <HeaderActionButton
            tone="neutral"
            tooltipLabel="Open file in editor"
            onClick={onEdit}
          >
            <AppCatalogPencilIcon width="14" height="14" aria-hidden="true" />
            Edit
          </HeaderActionButton>
        </span>
      </div>

      <div className="diff-popover-compact flex min-h-0 flex-1 overflow-hidden rounded-md bg-base">
        {treeRef ? (
          <DiffContentView
            oldValue={oldValue}
            newValue={newValue}
            viewMode="unified"
            loading={loading}
            truncated={truncated}
            binary={binary}
            imagePreview={imagePreview}
            variant="compact"
          />
        ) : (
          <DiffTurnUnavailableState
            action={<p>Expand to see all branch changes for this file.</p>}
          />
        )}
      </div>
    </div>,
    document.body,
  );
});
