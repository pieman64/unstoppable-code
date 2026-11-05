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
import {
  Button,
  GroupedDiffStats,
  ITEM_PREVIEW_OPEN_DELAY_MS,
  TURN_FILE_ROW_CLASS_NAME,
  formatTurnFilesHeading,
  TurnFilesSummaryView,
  useCleanChatLook,
  useToolApprovalWait,
} from '@canopy/ui-shared/components';
import {
  CloseIcon as AppCatalogCloseIcon,
  ForwardIcon as AppCatalogForwardIcon,
  PencilIcon as AppCatalogPencilIcon,
  RevertIcon as AppCatalogRevertIcon,
} from '@canopy/ui-shared/icons/AppIcons';

interface TurnDiffSummaryProps {
  /** Git changes captured for the turn; absent while it runs or when none. */
  turnDiff?: TurnDiffData;
  /**
   * Files the turn created, updated or presented that exist; diffed paths are
   * not repeated.
   */
  files?: readonly TurnFileLocation[];
  /** Creations and updates still in flight while the turn runs. */
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

/** The added and removed line counts, the only colors the clean look keeps. */
function LineCounts({
  insertions,
  deletions,
}: {
  insertions: number;
  deletions: number;
}): JSX.Element | null {
  if (insertions === 0 && deletions === 0) return null;
  return (
    <span
      data-line-counts=""
      className="shrink-0 whitespace-nowrap tabular-nums"
    >
      <GroupedDiffStats insertions={insertions} deletions={deletions} />
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

const SINGLE_FILE_VERBS: Partial<Record<ChangedFileInfo['status'], string>> = {
  added: 'Created',
  untracked: 'Created',
  deleted: 'Deleted',
};

function SingleDiffFile({
  file,
  disabled,
  onOpen,
}: {
  file: ChangedFileInfo;
  disabled: boolean;
  onOpen: () => void;
}): JSX.Element {
  const filename = getBaseName(file.path);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 text-s">
      <button
        type="button"
        disabled={disabled}
        aria-label={`${SINGLE_FILE_VERBS[file.status] ?? 'Edited'} ${filename}`}
        data-turn-files-title=""
        className="focus-ring min-w-0 truncate rounded-sm text-left fg-primary"
        onClick={onOpen}
      >
        {filename}
      </button>
      <LineCounts insertions={file.insertions} deletions={file.deletions} />
    </span>
  );
}

function FileCard({
  file,
  onClick,
  onMouseEnter,
  onMouseMove,
  onMouseLeave,
}: {
  file: ChangedFileInfo;
  onClick: () => void;
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseMove: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave: () => void;
}): JSX.Element {
  const baseName = getBaseName(file.path);
  // Clean chat look: one row per file in the changes card, the folder in a
  // lighter ink (cut first when the row is short) before the file name, and
  // the line counts at the far edge. The hover sits inside the list's 4px
  // inset, with corners nested in the card's 16px ones; 8px of padding
  // keeps the text on the header's 12px edge.
  const clean = useCleanChatLook();
  if (clean) {
    const folder = file.path.slice(0, file.path.length - baseName.length);
    return (
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        className={`focus-ring text-left ${TURN_FILE_ROW_CLASS_NAME}`}
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
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className="min-w-0 cursor-default rounded-md border bg-fg-primary/[0.02] px-2 py-1.5 text-left text-xs transition-colors hover:bg-fg-primary/[0.04]"
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
      fileTarget
        ? turnFilesOutsideDiff(
            files,
            turnDiff,
            turnDiff?.treeRefs?.[0]?.repoId ?? fileTarget?.projectId,
          )
        : [],
    [files, turnDiff, fileTarget],
  );
  const visiblePending = useMemo(() => {
    if (!fileTarget) return [];
    const primaryRepoId =
      turnDiff?.treeRefs?.[0]?.repoId ?? fileTarget.projectId;
    return turnFilesOutsideDiff(
      pendingFiles.map((file) => ({
        ...file,
        absolutePath: file.path,
        relativePath: file.path,
        repoId: file.target?.projectId ?? primaryRepoId,
      })),
      turnDiff,
      primaryRepoId,
    ).filter(
      (file) =>
        !files.some(
          (located) =>
            (located.path === file.path ||
              located.absolutePath === file.path) &&
            located.target?.projectId === file.target?.projectId &&
            located.target?.worktreeId === file.target?.worktreeId,
        ),
    );
  }, [pendingFiles, fileTarget, turnDiff, files]);
  const approvalWait = useToolApprovalWait();
  const waitingPending = useMemo(
    () =>
      new Set(
        visiblePending
          .filter((file) => approvalWait.isFileWaiting(file.path))
          .map((file) => file.path),
      ),
    [visiblePending, approvalWait],
  );
  const diffCount = turnDiff?.files.length ?? 0;
  const extraCount = extraFiles.length + visiblePending.length;
  // Headings count the chips actually shown, after diff suppression.
  const extraEntries = useMemo(
    () => [
      ...extraFiles,
      ...visiblePending.map((file) => ({
        ...(file.change ? { change: file.change } : {}),
        pending: true,
        waiting: waitingPending.has(file.path),
      })),
    ],
    [extraFiles, visiblePending, waitingPending],
  );
  const totalCount = diffCount + extraCount;
  // The summary can mount while the turn runs (a pending chip) and gain its
  // diff later, so the default is re-applied as the entries change until the
  // user has toggled the disclosure themselves.
  const defaultExpanded =
    !clean && isLastTurnGroup && filesSettled && totalCount <= 10;
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const userToggledRef = useRef(false);
  const [hoveredFile, setHoveredFile] = useState<ChangedFileInfo | null>(null);
  const [previewSide, setPreviewSide] = useState<'left' | 'right'>('right');
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

  const updatePreviewSide = useCallback(
    (el: HTMLElement, clientX: number): void => {
      const rect = el.getBoundingClientRect();
      setPreviewSide(clientX < rect.left + rect.width / 2 ? 'left' : 'right');
    },
    [],
  );

  const handleCardMouseEnter = useCallback(
    (file: ChangedFileInfo, el: HTMLElement, clientX: number): void => {
      if (!selectedWorktree) return;
      updatePreviewSide(el, clientX);
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
        }, ITEM_PREVIEW_OPEN_DELAY_MS);
      }
    },
    [selectedWorktree, updatePreviewSide],
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
  const extraHeading = formatTurnFilesHeading(extraEntries);
  const otherHeading = formatTurnFilesHeading(extraEntries, { other: true });

  const firstFile = turnDiff?.files[0];
  // Clean chat look: a card after the Codex app's, "Edited 2 files" with the
  // line counts under it, Undo and View changes, then one row per file. A
  // turn that changed exactly one file is the header alone, named for that
  // file: a row repeating it would add nothing. A created file git does not
  // list takes the same header slot, preserving its preview and reveal actions.
  const singleFile =
    clean && diffCount === 1 && extraCount === 0 ? firstFile : undefined;
  const cleanTitle = singleFile
    ? getBaseName(singleFile.path)
    : turnDiff && diffCount > 0
      ? `Edited ${diffCount} ${diffCount === 1 ? 'file' : 'files'}${
          otherHeading ? `, ${otherHeading}` : ''
        }`
      : extraHeading;
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
  const outputFiles = fileTarget
    ? [
        ...extraFiles.map((file) => (
          <TurnFileChip
            key={`file:${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`}
            path={file.path}
            absolutePath={file.absolutePath}
            target={file.target}
            change={file.change}
            presentation={clean && totalCount === 1 ? 'summary' : 'row'}
            projectId={fileTarget.projectId}
            worktreeId={fileTarget.worktreeId}
            chatId={fileTarget.chatId}
          />
        )),
        ...visiblePending.map((file) => (
          <TurnFileChip
            key={`pending:${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`}
            path={file.path}
            target={file.target}
            change={file.change}
            pending
            waiting={waitingPending.has(file.path)}
            presentation={clean && totalCount === 1 ? 'summary' : 'row'}
            projectId={fileTarget.projectId}
            worktreeId={fileTarget.worktreeId}
            chatId={fileTarget.chatId}
          />
        )),
      ]
    : [];
  const singleContent = singleFile ? (
    <SingleDiffFile
      file={singleFile}
      disabled={!selectedWorktree}
      onOpen={openChanges}
    />
  ) : undefined;
  const showFiles = !singleContent && isExpanded;

  return (
    <>
      <TurnFilesSummaryView
        heading={cleanTitle}
        singleFile={singleContent}
        changedFileCount={diffCount}
        turnId={turnId}
        expanded={isExpanded}
        showFiles={showFiles}
        onToggle={(): void => {
          userToggledRef.current = true;
          setIsExpanded((value) => !value);
        }}
        detail={
          turnDiff &&
          diffCount > 0 &&
          (turnDiff.totalInsertions > 0 || turnDiff.totalDeletions > 0) ? (
            <LineCounts
              insertions={turnDiff.totalInsertions}
              deletions={turnDiff.totalDeletions}
            />
          ) : undefined
        }
        actions={
          onUndo || (firstFile && selectedWorktree) ? (
            <span
              data-turn-files-actions=""
              className="ml-auto flex shrink-0 items-center gap-2"
            >
              {onUndo && (
                <Button variant="ghost-overlay" size="sm" onClick={onUndo}>
                  Undo
                  <AppCatalogRevertIcon aria-hidden="true" />
                </Button>
              )}
              {firstFile && selectedWorktree && (
                <Button variant="secondary" size="sm" onClick={openChanges}>
                  View changes
                </Button>
              )}
            </span>
          ) : undefined
        }
        classicHeading={
          turnDiff && diffCount > 0 ? (
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
              {otherHeading && (
                <span className="fg-secondary">· {otherHeading}</span>
              )}
            </>
          ) : (
            <span className="font-medium fg-primary">{extraHeading}</span>
          )
        }
        changedFiles={
          showFiles
            ? turnDiff?.files.map((file) => (
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
                  onMouseEnter={(event): void =>
                    handleCardMouseEnter(
                      file,
                      event.currentTarget,
                      event.clientX,
                    )
                  }
                  onMouseMove={(event): void =>
                    updatePreviewSide(event.currentTarget, event.clientX)
                  }
                  onMouseLeave={handleCardMouseLeave}
                />
              ))
            : undefined
        }
      >
        {outputFiles}
      </TurnFilesSummaryView>

      {/* Hover popover */}
      {hoveredFile && selectedWorktree && turnDiff && (
        <TurnDiffPopover
          file={hoveredFile}
          turnDiff={turnDiff}
          projectId={selectedWorktree.projectId}
          worktreeId={selectedWorktree.worktreeId}
          anchorRef={anchorElRef}
          placement={previewSide}
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handlePopoverMouseLeave}
          onOpenModal={handleOpenModalFromPopover}
          onEdit={handleEditFromPopover}
        />
      )}
    </>
  );
});
