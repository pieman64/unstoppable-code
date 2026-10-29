import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { TranscriptTurnFile } from '@canopy/agent-transcript/transcript-storage';
import type {
  ChangedFileInfo,
  TurnDiffData,
} from '@canopy/desktop-shared/types';
import {
  turnFilesOutsideDiff,
  type TurnFileLocation,
} from '@canopy/desktop-shared/lib/turn-files';
import { getBaseName } from '@/lib/format';
import { useChatStore } from '@/stores/chatStore';
import { requestFilePanelPlacementBesideChat } from '@/lib/panels/chat-panel-sync';
import { TurnDiffPopover } from './TurnDiffPopover';
import { TurnFileChip } from './TurnFiles';
import { openFileInDiff } from '@/lib/panels/open-file-diff';
import { ChevronDownIcon, ChevronRightIcon } from '@canopy/ui-shared/icons';
import { Button, useCleanChatLook } from '@canopy/ui-shared/components';
import {
  CloseIcon as AppCatalogCloseIcon,
  FileDiff as AppCatalogFileDiffIcon,
  ForwardIcon as AppCatalogForwardIcon,
  PencilIcon as AppCatalogPencilIcon,
  RevertIcon as AppCatalogRevertIcon,
} from '@canopy/ui-shared/icons/AppIcons';

interface TurnDiffSummaryProps {
  /** Git changes captured for the turn; absent while it runs or when none. */
  turnDiff?: TurnDiffData;
  /** Files the turn created or presented that exist; diffed paths are not repeated. */
  files?: readonly TurnFileLocation[];
  /** Creations still in flight while the turn runs. */
  pendingFiles?: readonly TranscriptTurnFile[];
  /** Chat whose viewer opens created files. */
  fileTarget?: { projectId: string; worktreeId: string; chatId: string };
  /**
   * False while a turn that mounted already complete awaits its first file
   * check, so the expand default is applied once to the final entry count
   * instead of expanding on the diff and collapsing when the chips arrive.
   */
  filesSettled?: boolean;
  turnId?: string;
  isLastTurnGroup: boolean;
  originChatTabId?: string;
  /**
   * Clean chat look: rolls the worktree back to before this turn, offered as
   * the card's "Undo" when the turn can be reset.
   */
  onUndo?: () => void;
}

/** Rows a clean changes card lists before "Show N more". */
const CLEAN_VISIBLE_FILES = 10;

/** The added and removed line counts, the only colors the clean look keeps. */
function LineCounts({
  insertions,
  deletions,
}: {
  insertions: number;
  deletions: number;
}): JSX.Element {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="fg-success">+{insertions}</span>
      <span className="ml-1 fg-destructive">-{deletions}</span>
    </span>
  );
}

const NO_FILES: readonly TurnFileLocation[] = [];
const NO_PENDING: readonly TranscriptTurnFile[] = [];

function renderStatusIcon(status: ChangedFileInfo['status']): JSX.Element {
  if (status === 'added') {
    return (
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-success" />
    );
  }

  if (status === 'deleted') {
    return (
      <AppCatalogCloseIcon
        aria-hidden="true"
        width="12"
        height="12"
        className="fg-destructive"
      />
    );
  }

  if (status === 'renamed') {
    return (
      <AppCatalogForwardIcon
        aria-hidden="true"
        width="12"
        height="12"
        className="fg-info"
      />
    );
  }

  return (
    <AppCatalogPencilIcon
      aria-hidden="true"
      width="12"
      height="12"
      className="fg-info"
    />
  );
}

function FileCard({
  file,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  file: ChangedFileInfo;
  onClick: () => void;
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave: () => void;
}): JSX.Element {
  const baseName = getBaseName(file.path);
  // Clean chat look: one row per file in the changes card, the folder in a
  // lighter ink (cut first when the row is short) before the file name, and
  // the line counts at the far edge.
  const clean = useCleanChatLook();
  if (clean) {
    const folder = file.path.slice(0, file.path.length - baseName.length);
    return (
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className="focus-ring flex w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left text-s transition-colors hover:bg-fg-primary/[0.04]"
        aria-label={file.path}
      >
        <span className="flex min-w-0 flex-1 items-baseline">
          {(folder !== '' || file.repoName) && (
            <span className="min-w-0 truncate fg-tertiary">
              {file.repoName ? `${file.repoName}: ` : ''}
              {folder}
            </span>
          )}
          <span className="shrink-0 fg-primary">{baseName}</span>
        </span>
        <LineCounts insertions={file.insertions} deletions={file.deletions} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="min-w-0 cursor-pointer rounded-md border bg-fg-primary/[0.02] px-2 py-1.5 text-left text-xs transition hover:bg-fg-primary/[0.04]"
      // The hover diff popover already surfaces the full path; the native
      // title only doubled it (CAN-2799).
      aria-label={file.path}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex h-3 w-3 shrink-0 items-center justify-center">
          {renderStatusIcon(file.status)}
        </span>
        <span className="min-w-0 flex-1 truncate fg-primary">{baseName}</span>
        <span className="shrink-0 font-medium tabular-nums">
          <span className="fg-success">+{file.insertions}</span>
          <span className="ml-1 fg-destructive">-{file.deletions}</span>
        </span>
      </div>
      {file.repoName && (
        <div className="mt-1 truncate text-3xs fg-secondary">
          {file.repoName}
        </div>
      )}
    </button>
  );
}

const HOVER_OPEN_DELAY = 300;
const HOVER_CLOSE_DELAY = 150;

/**
 * One collapsible summary per turn: the git changes it made and, beside them,
 * the files it created or presented that git does not list (ignored paths,
 * Cowork and App Advisor outputs). A file the diff already shows has that
 * card as its only home.
 */
export const TurnDiffSummary = memo(function TurnDiffSummary({
  turnDiff,
  files = NO_FILES,
  pendingFiles = NO_PENDING,
  fileTarget,
  filesSettled = true,
  turnId,
  isLastTurnGroup,
  originChatTabId,
  onUndo,
}: TurnDiffSummaryProps): JSX.Element | null {
  const clean = useCleanChatLook();
  const extraFiles = useMemo(
    () =>
      turnFilesOutsideDiff(
        files,
        turnDiff,
        turnDiff?.treeRefs?.[0]?.repoId ?? fileTarget?.projectId,
      ),
    [files, turnDiff, fileTarget?.projectId],
  );
  const diffCount = turnDiff?.files.length ?? 0;
  const extraCount = extraFiles.length + pendingFiles.length;
  const totalCount = diffCount + extraCount;
  // The summary can mount while the turn runs (a pending chip) and gain its
  // diff later, so the default is re-applied as the entries change until the
  // user has toggled the disclosure themselves.
  const defaultExpanded = isLastTurnGroup && filesSettled && totalCount <= 10;
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const userToggledRef = useRef(false);
  const [hoveredFile, setHoveredFile] = useState<ChangedFileInfo | null>(null);
  const wasLastRef = useRef(isLastTurnGroup);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoveredFileRef = useRef<ChangedFileInfo | null>(null);
  const anchorElRef = useRef<HTMLElement | null>(null);

  const selectedWorktree = useChatStore((s) => s.selectedWorktree);
  const openFileTab = useChatStore((s) => s.openFileTab);

  // Auto-collapse when a new turn starts (this group is no longer the last)
  useEffect(() => {
    if (wasLastRef.current && !isLastTurnGroup) {
      setIsExpanded(false);
    }
    wasLastRef.current = isLastTurnGroup;
  }, [isLastTurnGroup]);

  useEffect(() => {
    if (!userToggledRef.current) setIsExpanded(defaultExpanded);
  }, [defaultExpanded]);

  // Clean up hover timer on unmount
  useEffect(() => {
    return (): void => {
      clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const closePopover = useCallback((): void => {
    clearTimeout(hoverTimerRef.current);
    hoveredFileRef.current = null;
    anchorElRef.current = null;
    setHoveredFile(null);
  }, []);

  // Close popover when section collapses
  useEffect(() => {
    if (!isExpanded) {
      closePopover();
    }
  }, [isExpanded, closePopover]);

  const handleCardMouseEnter = useCallback(
    (file: ChangedFileInfo, el: HTMLElement): void => {
      if (!selectedWorktree) return;
      clearTimeout(hoverTimerRef.current);
      if (hoveredFileRef.current !== null) {
        // Already showing a popover — switch immediately
        anchorElRef.current = el;
        hoveredFileRef.current = file;
        setHoveredFile(file);
      } else {
        hoverTimerRef.current = setTimeout(() => {
          anchorElRef.current = el;
          hoveredFileRef.current = file;
          setHoveredFile(file);
        }, HOVER_OPEN_DELAY);
      }
    },
    [selectedWorktree],
  );

  const handleCardMouseLeave = useCallback((): void => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(closePopover, HOVER_CLOSE_DELAY);
  }, [closePopover]);

  const handlePopoverMouseEnter = useCallback((): void => {
    clearTimeout(hoverTimerRef.current);
  }, []);

  const handlePopoverMouseLeave = useCallback((): void => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(closePopover, HOVER_CLOSE_DELAY);
  }, [closePopover]);

  const handleOpenModalFromPopover = useCallback((): void => {
    const file = hoveredFileRef.current;
    if (file && selectedWorktree && turnDiff) {
      void openFileInDiff(
        selectedWorktree,
        file,
        'combined',
        { chatTabId: originChatTabId },
        turnDiff,
      );
      closePopover();
    }
  }, [closePopover, selectedWorktree, originChatTabId, turnDiff]);

  const handleEditFromPopover = useCallback((): void => {
    const file = hoveredFileRef.current;
    if (!file || !selectedWorktree) return;
    closePopover();
    void (async (): Promise<void> => {
      const repoBase = await window.api.getWorktreePath({
        projectId: selectedWorktree.projectId,
        worktreeId: selectedWorktree.worktreeId,
        repoId: file.repoId,
      });
      const trimmed = repoBase.replace(/\/+$/, '');
      const fileTabId = openFileTab({
        absolutePath: `${trimmed}/${file.path}`,
        filename: getBaseName(file.path),
      });
      if (fileTabId !== null && originChatTabId !== undefined) {
        requestFilePanelPlacementBesideChat(fileTabId, originChatTabId);
      }
    })();
  }, [closePopover, openFileTab, originChatTabId, selectedWorktree]);

  if (totalCount === 0) return null;

  const diffLabel = diffCount === 1 ? 'file changed' : 'files changed';
  const extraLabel = extraCount === 1 ? 'file' : 'files';

  // Clean chat look: a card after the Codex app's, "Edited 2 files" with the
  // line counts under it, Undo and View changes, then one row per file.
  const cleanTitle =
    turnDiff && diffCount > 0
      ? `Edited ${diffCount} ${diffCount === 1 ? 'file' : 'files'}${
          extraCount > 0 ? `, ${extraCount} other ${extraLabel}` : ''
        }`
      : `${extraCount} ${extraLabel}`;
  const firstFile = turnDiff?.files[0];
  const openChanges = (): void => {
    if (!selectedWorktree || !turnDiff || !firstFile) return;
    closePopover();
    void openFileInDiff(
      selectedWorktree,
      firstFile,
      'combined',
      { chatTabId: originChatTabId },
      turnDiff,
    );
  };
  const hiddenFileCount =
    clean && !isExpanded ? Math.max(0, diffCount - CLEAN_VISIBLE_FILES) : 0;
  const visibleDiffFiles =
    clean && !isExpanded
      ? (turnDiff?.files.slice(0, CLEAN_VISIBLE_FILES) ?? [])
      : (turnDiff?.files ?? []);
  const showFiles = clean || isExpanded;

  return (
    <>
      <div
        data-testid="turn-files"
        {...(turnId !== undefined ? { 'data-turn-id': turnId } : {})}
        className={
          clean
            ? 'overflow-hidden rounded-lg border bg-fg-primary/[0.03]'
            : 'rounded-md border bg-fg-primary/[0.02] px-3 py-2'
        }
      >
        {clean ? (
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fg-primary/[0.06] fg-secondary [&_svg]:size-4"
            >
              <AppCatalogFileDiffIcon />
            </span>
            <span className="flex min-w-0 flex-1 flex-col text-s">
              <span className="truncate fg-primary" data-turn-files-title="">
                {cleanTitle}
              </span>
              {turnDiff && diffCount > 0 && (
                <LineCounts
                  insertions={turnDiff.totalInsertions}
                  deletions={turnDiff.totalDeletions}
                />
              )}
            </span>
            {onUndo && (
              <Button variant="ghost" size="sm" onClick={onUndo}>
                Undo
                <AppCatalogRevertIcon aria-hidden="true" />
              </Button>
            )}
            {firstFile && selectedWorktree && (
              <Button variant="secondary" size="sm" onClick={openChanges}>
                View changes
              </Button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={(): void => {
              userToggledRef.current = true;
              setIsExpanded((e) => !e);
            }}
            aria-expanded={isExpanded}
            className="flex w-full items-center gap-x-2 text-xs"
          >
            <span className="flex-shrink-0 fg-secondary">
              {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </span>
            {turnDiff && diffCount > 0 ? (
              <>
                <span className="font-medium fg-primary">
                  {diffCount} {diffLabel}
                </span>
                <span className="font-medium tabular-nums fg-success">
                  +{turnDiff.totalInsertions}
                </span>
                <span className="font-medium tabular-nums fg-destructive">
                  -{turnDiff.totalDeletions}
                </span>
                {extraCount > 0 && (
                  <span className="fg-secondary">
                    · {extraCount} other {extraLabel}
                  </span>
                )}
              </>
            ) : (
              <span className="font-medium fg-primary">
                {extraCount} {extraLabel}
              </span>
            )}
          </button>
        )}
        <div
          className={
            !showFiles
              ? 'hidden'
              : clean
                ? 'flex flex-col border-t py-1'
                : 'mt-2 flex flex-wrap gap-2'
          }
        >
          {showFiles &&
            visibleDiffFiles.map((file) => (
              <FileCard
                key={`${file.repoId ?? ''}:${file.path}`}
                file={file}
                onClick={(): void => {
                  if (selectedWorktree) {
                    closePopover();
                    void openFileInDiff(
                      selectedWorktree,
                      file,
                      'combined',
                      { chatTabId: originChatTabId },
                      turnDiff,
                    );
                  }
                }}
                onMouseEnter={(e): void => {
                  handleCardMouseEnter(file, e.currentTarget);
                }}
                onMouseLeave={handleCardMouseLeave}
              />
            ))}
          {fileTarget &&
            extraFiles.map((file) => (
              <TurnFileChip
                key={`file:${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`}
                path={file.path}
                target={file.target}
                projectId={fileTarget.projectId}
                worktreeId={fileTarget.worktreeId}
                chatId={fileTarget.chatId}
              />
            ))}
          {fileTarget &&
            pendingFiles.map((file) => (
              <TurnFileChip
                key={`pending:${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`}
                path={file.path}
                target={file.target}
                pending
                projectId={fileTarget.projectId}
                worktreeId={fileTarget.worktreeId}
                chatId={fileTarget.chatId}
              />
            ))}
          {hiddenFileCount > 0 && (
            <button
              type="button"
              onClick={(): void => {
                userToggledRef.current = true;
                setIsExpanded(true);
              }}
              className="focus-ring px-3 py-1 text-left text-s fg-tertiary transition-colors hover:fg-secondary"
            >
              Show {hiddenFileCount} more
            </button>
          )}
        </div>
      </div>

      {/* Hover popover */}
      {hoveredFile && selectedWorktree && turnDiff && (
        <TurnDiffPopover
          file={hoveredFile}
          turnDiff={turnDiff}
          projectId={selectedWorktree.projectId}
          worktreeId={selectedWorktree.worktreeId}
          anchorRef={anchorElRef}
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handlePopoverMouseLeave}
          onOpenModal={handleOpenModalFromPopover}
          onEdit={handleEditFromPopover}
        />
      )}
    </>
  );
});
