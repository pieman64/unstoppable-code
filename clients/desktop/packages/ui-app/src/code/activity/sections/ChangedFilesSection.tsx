'use client';

import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type {
  PortalChangedFile,
  PortalChangedFiles,
  PortalChangedFilesNotice,
  PortalCodeViewerSelection,
} from '@canopy/protocol/portal';
import {
  OverlayScrollArea,
  FileChangeMetadata,
  FileRevertButton,
  Notice,
} from '@canopy/ui-shared/components';
import { toDiffFileStatus } from '../../file/diff-status';

export interface ChangedFileRow extends PortalChangedFile {
  readonly source: 'uncommitted' | 'committed';
}

/**
 * Split a path into its muted directory prefix (with trailing slash) and the
 * emphasized filename, mirroring the desktop `ChangedFilesSection.splitPath`.
 */
function splitPath(filePath: string): { dir: string; name: string } {
  const lastSlash = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\'),
  );
  if (lastSlash === -1) return { dir: '', name: filePath };
  return {
    dir: filePath.slice(0, lastSlash + 1),
    name: filePath.slice(lastSlash + 1),
  };
}

function displayPath(file: ChangedFileRow, showRepoName = false): string {
  const previousPath = file.renamedFrom ?? file.previousPath;
  const currentPath = filePathForDisplay(file, showRepoName);
  const previousDisplayPath =
    showRepoName && file.repoName && previousPath
      ? `${file.repoName}/${previousPath}`
      : previousPath;
  // Both status vocabularies are live on the wire (word statuses and
  // porcelain codes); normalise before the rename check.
  return toDiffFileStatus(file.status) === 'renamed' && previousDisplayPath
    ? `${previousDisplayPath} → ${currentPath}`
    : currentPath;
}

function filePathForDisplay(
  file: ChangedFileRow,
  showRepoName: boolean,
): string {
  return showRepoName && file.repoName
    ? `${file.repoName}/${file.filePath}`
    : file.filePath;
}

const NOTICE_COPY: Record<PortalChangedFilesNotice['kind'], string> = {
  truncated: 'Not every changed file is listed.',
  base_unavailable:
    "The base branch isn't available, so committed changes can't be compared.",
  unavailable: "Changes aren't available right now.",
  sleeping: 'Project is sleeping. Changes load when it wakes.',
};

/**
 * Why the lists are incomplete (REG-3024), one quiet line per notice. A
 * producer that reports none (desktop) renders nothing here.
 */
function ChangedFilesNotices({
  notices,
  showRepoName,
}: {
  readonly notices: readonly PortalChangedFilesNotice[];
  readonly showRepoName: boolean;
}): JSX.Element | null {
  if (notices.length === 0) return null;
  // The shared inline Notice (DESIGN.md): neutral, the glyph carries the
  // meaning; announced politely when a refresh changes the answer.
  return (
    <div className="space-y-2 px-3">
      {notices.map((notice, index) => (
        <Notice
          key={`${notice.kind}:${notice.repoId ?? ''}:${String(index)}`}
          intent="neutral"
          data-testid="activity-changed-files-notice"
          data-notice-kind={notice.kind}
        >
          {showRepoName && notice.repoName
            ? `${notice.repoName}: ${NOTICE_COPY[notice.kind]}`
            : NOTICE_COPY[notice.kind]}
        </Notice>
      ))}
    </div>
  );
}

/**
 * Read-only changed-files list for the activity panel (uncommitted +
 * committed). Each row mirrors the desktop-native row: a `px-3 py-1`,
 * keyboard-operable line with a muted directory / foreground filename split,
 * the shared {@link FileChangeMetadata} status dot, and a hover-revealed
 * {@link FileRevertButton}. Selecting a row calls the injected
 * {@link ChangedFilesSectionProps.onSelectFile} (host opens the diff); the
 * revert affordance renders only when the host can write
 * (`fileSystemAccess === 'read-write'`) and a handler is injected.
 */
export interface ChangedFilesSectionProps {
  readonly changedFiles: PortalChangedFiles | undefined;
  /** True when the host can revert (desktop); hides Revert otherwise. */
  readonly canRevert?: boolean;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  /** Prefix paths with repo names when the selected workspace has >1 repo. */
  readonly showRepoName?: boolean;
  readonly onSelectFile?: (selection: PortalCodeViewerSelection) => void;
  readonly onFileClick?: (file: ChangedFileRow) => void;
  readonly onFileContextMenu?: (
    file: ChangedFileRow,
    point: { clientX: number; clientY: number },
  ) => void;
  readonly onRevertFile?: (file: ChangedFileRow) => void;
  /** Defaults to the portal's existing empty-state copy; pass null for blank. */
  readonly emptyState?: ReactNode;
  /** Applies the native rail's inner scroll cap. */
  readonly scrollable?: boolean;
  readonly openDataTestId?: string;
}

function FileRow({
  file,
  canRevert,
  onSelectFile,
  onFileClick,
  onFileContextMenu,
  onRevertFile,
  workspaceLocalId,
  worktreeLocalId,
  showRepoName,
  openDataTestId,
}: {
  file: ChangedFileRow;
  canRevert: boolean;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  showRepoName: boolean;
  onSelectFile?: (selection: PortalCodeViewerSelection) => void;
  onFileClick?: (file: ChangedFileRow) => void;
  onFileContextMenu?: ChangedFilesSectionProps['onFileContextMenu'];
  onRevertFile?: (file: ChangedFileRow) => void;
  openDataTestId?: string;
}): JSX.Element {
  const renderedPath = filePathForDisplay(file, showRepoName);
  const { dir, name } = splitPath(renderedPath);
  const tooltip = displayPath(file, showRepoName);
  // Only wire selection when the complete diff-selection identity is present:
  // a handler plus both workspace and worktree ids.
  const selectFromPortal =
    onSelectFile && workspaceLocalId && worktreeLocalId
      ? (): void =>
          onSelectFile({
            kind: 'diff',
            title: file.filePath,
            request: {
              workspaceId: workspaceLocalId,
              worktreeId: worktreeLocalId,
              path: file.filePath,
              source: file.source,
              ...(file.repoId ? { repoId: file.repoId } : {}),
            },
          })
      : undefined;
  const select = onFileClick ? (): void => onFileClick(file) : selectFromPortal;
  const revert =
    canRevert && onRevertFile ? (): void => onRevertFile(file) : undefined;

  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1 ${
        select
          ? 'cursor-pointer rounded-md transition-colors hover:bg-fg-primary/[0.06]'
          : ''
      }`}
      data-testid="activity-changed-file"
      title={tooltip}
      role={select ? 'button' : undefined}
      tabIndex={select ? 0 : undefined}
      onClick={select}
      onContextMenu={
        onFileContextMenu
          ? (event: MouseEvent<HTMLDivElement>): void => {
              event.preventDefault();
              event.stopPropagation();
              onFileContextMenu(file, {
                clientX: event.clientX,
                clientY: event.clientY,
              });
            }
          : undefined
      }
      onKeyDown={
        select
          ? (event: KeyboardEvent<HTMLDivElement>): void => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                // Defensive: keep row activation keys out of ancestor
                // keyboard handlers (e.g. a future dnd-kit sensor), matching
                // ExecutionActionButton.
                event.stopPropagation();
                select();
              }
            }
          : undefined
      }
    >
      <div
        className="flex min-w-0 flex-1 items-baseline text-s"
        data-testid={openDataTestId}
      >
        <span className="min-w-0 shrink truncate fg-secondary">{dir}</span>
        <span className="max-w-full shrink-0 truncate fg-primary/80">
          {name}
        </span>
      </div>
      {file.binary === true ? (
        <span
          className={`shrink-0 text-2xs fg-secondary ${
            revert ? 'group-hover:hidden group-focus-within:hidden' : ''
          }`}
        >
          Binary
        </span>
      ) : null}
      <FileChangeMetadata
        insertions={file.insertions}
        deletions={file.deletions}
        status={toDiffFileStatus(file.status)}
        hideOnHover={revert !== undefined}
      />
      {revert ? (
        <FileRevertButton ariaLabel={`Revert ${tooltip}`} onClick={revert} />
      ) : null}
    </div>
  );
}

/**
 * Capped list body. When it scrolls it goes behind the shared
 * OverlayScrollArea like every other surface, so its scrollbar is the same
 * overlay thumb — the native one was a 15px track that also ate 15px of the
 * card's width, which is why it read as thicker and different.
 */
interface ChangedFilesBodyProps {
  readonly scrollable: boolean;
  readonly children: ReactNode;
}

function ChangedFilesBody({
  scrollable,
  children,
}: ChangedFilesBodyProps): JSX.Element {
  if (!scrollable) {
    return (
      <div className="space-y-2" data-testid="activity-changed-files">
        {children}
      </div>
    );
  }
  return (
    <OverlayScrollArea
      className="-mb-3 -mt-3 max-h-70"
      contentClassName="space-y-2 py-3"
      railClassName="-right-1"
      viewportProps={{ 'data-testid': 'activity-changed-files' }}
    >
      {children}
    </OverlayScrollArea>
  );
}

export function ChangedFilesSection({
  changedFiles,
  canRevert = false,
  onSelectFile,
  onFileClick,
  onFileContextMenu,
  onRevertFile,
  workspaceLocalId,
  worktreeLocalId,
  showRepoName = false,
  emptyState = (
    <p
      className="text-xs fg-secondary"
      data-testid="activity-changed-files-empty"
    >
      No changed files.
    </p>
  ),
  scrollable = true,
  openDataTestId,
}: ChangedFilesSectionProps): JSX.Element {
  const uncommitted: ChangedFileRow[] = [...(changedFiles?.uncommitted ?? [])]
    .sort((a, b) => a.filePath.localeCompare(b.filePath))
    .map((file): ChangedFileRow => ({ ...file, source: 'uncommitted' }));
  const committed: ChangedFileRow[] = [...(changedFiles?.committed ?? [])]
    .sort((a, b) => a.filePath.localeCompare(b.filePath))
    .map((file): ChangedFileRow => ({ ...file, source: 'committed' }));

  const notices = changedFiles?.notices ?? [];
  const noticeList = (
    <ChangedFilesNotices notices={notices} showRepoName={showRepoName} />
  );

  if (uncommitted.length === 0 && committed.length === 0) {
    // A notice explains an incomplete answer; "no changed files" would claim
    // a complete one.
    return notices.length > 0 ? (
      <div className="space-y-2" data-testid="activity-changed-files">
        {noticeList}
      </div>
    ) : (
      <>{emptyState}</>
    );
  }

  return (
    <ChangedFilesBody scrollable={scrollable}>
      {noticeList}
      {uncommitted.length > 0 && (
        <div>
          {committed.length > 0 && (
            <h4 className="mb-1 px-3 text-2xs font-medium fg-secondary">
              Uncommitted
            </h4>
          )}
          {uncommitted.map((file) => (
            <FileRow
              key={`u:${file.repoId ?? ''}:${file.filePath}:${file.status}`}
              file={file}
              canRevert={canRevert}
              onSelectFile={onSelectFile}
              onFileClick={onFileClick}
              onFileContextMenu={onFileContextMenu}
              onRevertFile={onRevertFile}
              workspaceLocalId={workspaceLocalId}
              worktreeLocalId={worktreeLocalId}
              showRepoName={showRepoName}
              openDataTestId={openDataTestId}
            />
          ))}
        </div>
      )}
      {committed.length > 0 && (
        <div>
          <h4 className="mb-1 px-3 text-2xs font-medium fg-secondary">
            Committed
          </h4>
          {committed.map((file) => (
            <FileRow
              key={`c:${file.repoId ?? ''}:${file.filePath}:${file.status}`}
              file={file}
              canRevert={false}
              onSelectFile={onSelectFile}
              onFileClick={onFileClick}
              onFileContextMenu={onFileContextMenu}
              workspaceLocalId={workspaceLocalId}
              worktreeLocalId={worktreeLocalId}
              showRepoName={showRepoName}
              openDataTestId={openDataTestId}
            />
          ))}
        </div>
      )}
    </ChangedFilesBody>
  );
}
