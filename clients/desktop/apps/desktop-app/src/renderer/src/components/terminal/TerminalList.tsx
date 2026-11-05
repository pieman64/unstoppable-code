import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  type TerminalGroup,
} from '@canopy/desktop-shared/types';
import {
  formatGroupLabel,
  useTerminalStore,
  type WorktreeTerminalBucket,
} from '@/stores/terminalStore';
import { getTerminalListStateLabel } from '@/lib/terminal-session-state';
import { Tooltip } from '@canopy/ui-shared';
import {
  OPERATIONAL_STATUS_COLORS,
  useHorizontalOverflowScroll,
} from '@canopy/ui-shared/lib';
import {
  useTerminalStatuses,
  type TerminalStatus,
} from '@/hooks/useTerminalStatuses';
import {
  TerminalIcon as AppCatalogTerminalIcon,
  SplitIcon as AppCatalogSplitIcon,
  PencilIcon as AppCatalogPencilIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Button, InlineTextInput } from '@canopy/ui-shared/components';

interface TerminalListProps {
  projectId: string;
  worktreeId: string;
  bucket: WorktreeTerminalBucket;
  /**
   * Right-aligned controls rendered after a spacer on the same row as the
   * session tabs (New terminal, launch-profile menu, Split). The tab list
   * scrolls horizontally on its own; the actions stay pinned right.
   */
  actions?: ReactNode;
  onSelectGroup: (groupId: string) => void;
  onSelectTerminal: (groupId: string, terminalId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}

// Edit-mode keys use a prefix so group and terminal ids never collide.
const groupEditKey = (id: string): string => `group:${id}`;
const termEditKey = (id: string): string => `term:${id}`;

export function TerminalList({
  projectId,
  worktreeId,
  bucket,
  actions,
  onSelectGroup,
  onSelectTerminal,
  onCloseGroup,
  onCloseTerminal,
}: TerminalListProps): JSX.Element {
  const statuses = useTerminalStatuses(projectId, worktreeId);
  const terminalCustomNames = useTerminalStore((s) => s.terminalCustomNames);
  const groupCustomNames = useTerminalStore((s) => s.groupCustomNames);
  const setTerminalName = useTerminalStore((s) => s.setTerminalName);
  const setGroupName = useTerminalStore((s) => s.setGroupName);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const {
    ref: tabScrollRef,
    showStartFade,
    showEndFade,
    thumbRef,
    hasOverflow,
    isScrollbarRevealed,
  } = useHorizontalOverflowScroll<HTMLDivElement>();

  const startEditGroup = useCallback((groupId: string): void => {
    setEditingKey(groupEditKey(groupId));
  }, []);
  const startEditTerminal = useCallback((terminalId: string): void => {
    setEditingKey(termEditKey(terminalId));
  }, []);
  const cancelEdit = useCallback((): void => {
    setEditingKey(null);
  }, []);

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b bg-card/40 text-xs">
      <div className="canopy-panel-tab-strip-wrap min-w-0 flex-1">
        <div
          className="canopy-scroll-fade canopy-scroll-fade-start"
          data-visible={showStartFade}
          aria-hidden="true"
        />
        <div
          className="canopy-scroll-fade canopy-scroll-fade-end"
          data-visible={showEndFade}
          aria-hidden="true"
        />
        <div
          ref={thumbRef}
          className="canopy-scroll-thumb"
          data-overflow={hasOverflow}
          data-revealed={isScrollbarRevealed}
          aria-hidden="true"
        />
        <div
          ref={tabScrollRef}
          className="canopy-hide-scrollbar flex min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden px-1 pt-1"
        >
          {bucket.groups.length === 0 ? (
            <div className="px-3 py-2 fg-secondary">No terminals</div>
          ) : (
            bucket.groups.map((group) => {
              const ordinal = bucket.groupOrdinals[group.id] ?? 0;
              const ariaLabel = formatGroupLabel(group, ordinal);
              const isActive = bucket.activeGroupId === group.id;
              return (
                <GroupRow
                  key={group.id}
                  group={group}
                  ariaLabel={ariaLabel}
                  isActive={isActive}
                  statuses={statuses}
                  sessions={bucket.sessions}
                  terminalCustomNames={terminalCustomNames}
                  groupCustomNames={groupCustomNames}
                  editingKey={editingKey}
                  onStartEditGroup={startEditGroup}
                  onStartEditTerminal={startEditTerminal}
                  onCancelEdit={cancelEdit}
                  onCommitGroupName={(id, name): void => {
                    setGroupName(projectId, worktreeId, id, name);
                    setEditingKey(null);
                  }}
                  onCommitTerminalName={(id, name): void => {
                    setTerminalName(projectId, worktreeId, id, name);
                    setEditingKey(null);
                  }}
                  onSelectGroup={onSelectGroup}
                  onSelectTerminal={onSelectTerminal}
                  onCloseGroup={onCloseGroup}
                  onCloseTerminal={onCloseTerminal}
                />
              );
            })
          )}
        </div>
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-end pb-1 pl-2 pr-1">
          <div className="flex items-center gap-0.5">{actions}</div>
        </div>
      )}
    </div>
  );
}

interface GroupRowProps {
  group: TerminalGroup;
  ariaLabel: string;
  isActive: boolean;
  statuses: Map<string, TerminalStatus>;
  sessions: WorktreeTerminalBucket['sessions'];
  terminalCustomNames: Record<string, string>;
  groupCustomNames: Record<string, string>;
  editingKey: string | null;
  onStartEditGroup: (groupId: string) => void;
  onStartEditTerminal: (terminalId: string) => void;
  onCancelEdit: () => void;
  onCommitGroupName: (groupId: string, name: string | null) => void;
  onCommitTerminalName: (terminalId: string, name: string | null) => void;
  onSelectGroup: (groupId: string) => void;
  onSelectTerminal: (groupId: string, terminalId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}

function GroupRow({
  group,
  ariaLabel,
  isActive,
  statuses,
  sessions,
  terminalCustomNames,
  groupCustomNames,
  editingKey,
  onStartEditGroup,
  onStartEditTerminal,
  onCancelEdit,
  onCommitGroupName,
  onCommitTerminalName,
  onSelectGroup,
  onSelectTerminal,
  onCloseGroup,
  onCloseTerminal,
}: GroupRowProps): JSX.Element {
  const isSplit = group.terminalIds.length >= 2;
  // Single-pane groups fold the pane's status into the header row. Multi-pane
  // groups keep the header neutral and render per-pane status in the nested
  // list below.
  const headerStatus = isSplit
    ? null
    : (statuses.get(group.terminalIds[0]) ?? null);
  const headerSession = isSplit
    ? null
    : (sessions[group.terminalIds[0]] ?? null);
  const headerStateLabel =
    headerSession !== null ? getTerminalListStateLabel(headerSession) : null;

  // For single-pane groups, the "group header" name aliases the sole
  // terminal's custom name so the label survives renderer reload (the group
  // id is regenerated on hydration; the terminal id is stable).
  const singleTerminalId = isSplit ? null : group.terminalIds[0];
  const headerCustomName = isSplit
    ? (groupCustomNames[group.id] ?? null)
    : singleTerminalId !== null
      ? (terminalCustomNames[singleTerminalId] ?? null)
      : null;
  const headerDisplayName = headerCustomName ?? headerSession?.title ?? null;

  const headerEditKey = groupEditKey(group.id);
  const isHeaderEditing = editingKey === headerEditKey;

  const commitHeaderName = useCallback(
    (name: string | null): void => {
      if (isSplit) {
        onCommitGroupName(group.id, name);
      } else if (singleTerminalId !== null) {
        onCommitTerminalName(singleTerminalId, name);
      }
    },
    [
      isSplit,
      singleTerminalId,
      group.id,
      onCommitGroupName,
      onCommitTerminalName,
    ],
  );

  const headerContent = (
    <>
      {isSplit ? (
        <AppCatalogSplitIcon size={14} className="shrink-0" />
      ) : (
        <AppCatalogTerminalIcon size={14} className="shrink-0" />
      )}
      {headerDisplayName !== null ? (
        <span className="min-w-0 truncate">{headerDisplayName}</span>
      ) : (
        <span className="min-w-0 truncate">{ariaLabel}</span>
      )}
      {headerStatus !== null && <RowStatus status={headerStatus} />}
      {headerStateLabel !== null && <RowState label={headerStateLabel} />}
    </>
  );

  if (!isSplit) {
    return (
      <div
        data-testid={`terminal-group-tab-${group.id}`}
        className={`group mr-1 flex h-9 min-w-32 max-w-56 shrink-0 items-center gap-1 rounded-t-md border px-2 ${
          isActive
            ? 'border-b-base bg-base fg-primary'
            : 'border-transparent bg-muted/25 fg-secondary hover:bg-muted/40 hover:fg-primary'
        }`}
      >
        {isHeaderEditing ? (
          <InlineRename
            className="text-2xs"
            icon={<AppCatalogTerminalIcon size={14} className="shrink-0" />}
            initialValue={headerCustomName ?? ''}
            ariaLabel={`Rename ${ariaLabel}`}
            onCommit={commitHeaderName}
            onCancel={onCancelEdit}
          />
        ) : (
          <button
            type="button"
            onClick={(): void => onSelectGroup(group.id)}
            aria-label={ariaLabel}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-2xs"
          >
            {headerContent}
          </button>
        )}
        {!isHeaderEditing && (
          <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip label="Rename">
              <Button
                variant="ghost-quiet"
                size="sm"
                iconOnly
                aria-label={`Rename ${ariaLabel}`}
                onClick={(): void => onStartEditGroup(group.id)}
              >
                <AppCatalogPencilIcon size={14} />
              </Button>
            </Tooltip>
          </span>
        )}
        {!isHeaderEditing && (
          <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip label="Close group">
              <Button
                variant="ghost-quiet"
                size="sm"
                iconOnly
                aria-label={`Close ${ariaLabel}`}
                onClick={(): void => onCloseGroup(group.id)}
              >
                <AppCatalogCloseIcon size={14} />
              </Button>
            </Tooltip>
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={`terminal-group-tab-${group.id}`}
      className={`mr-1 flex h-9 shrink-0 items-center gap-1 rounded-t-md border px-1 ${
        isActive
          ? 'border-sky-500/50 border-b-base bg-sky-500/10'
          : 'border-sky-500/25 bg-sky-500/5'
      }`}
    >
      <div className="group flex h-7 min-w-24 max-w-40 items-center gap-1 rounded px-1.5 fg-info">
        {isHeaderEditing ? (
          <InlineRename
            className="text-2xs"
            icon={<AppCatalogSplitIcon size={14} className="shrink-0" />}
            initialValue={headerCustomName ?? ''}
            ariaLabel={`Rename ${ariaLabel}`}
            onCommit={commitHeaderName}
            onCancel={onCancelEdit}
          />
        ) : (
          <button
            type="button"
            onClick={(): void => onSelectGroup(group.id)}
            aria-label={ariaLabel}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-2xs"
          >
            {headerContent}
          </button>
        )}
        {!isHeaderEditing && (
          <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip label="Rename">
              <Button
                variant="ghost-quiet"
                size="sm"
                iconOnly
                aria-label={`Rename ${ariaLabel}`}
                onClick={(): void => onStartEditGroup(group.id)}
              >
                <AppCatalogPencilIcon size={14} />
              </Button>
            </Tooltip>
          </span>
        )}
        {!isHeaderEditing && (
          <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip label="Close group">
              <Button
                variant="ghost-quiet"
                size="sm"
                iconOnly
                aria-label={`Close ${ariaLabel}`}
                onClick={(): void => onCloseGroup(group.id)}
              >
                <AppCatalogCloseIcon size={14} />
              </Button>
            </Tooltip>
          </span>
        )}
      </div>
      <ul className="flex h-full items-end gap-0.5">
        {group.terminalIds.map((id, index) => {
          const isFocused = group.focusedTerminalId === id;
          const paneStatus = statuses.get(id) ?? null;
          const paneSession = sessions[id] ?? null;
          const paneStateLabel =
            paneSession !== null
              ? getTerminalListStateLabel(paneSession)
              : null;
          const paneNumber = index + 1;
          const paneCustomName = terminalCustomNames[id] ?? null;
          const paneDisplayName = paneCustomName ?? paneSession?.title ?? null;
          const paneKey = termEditKey(id);
          const isPaneEditing = editingKey === paneKey;
          return (
            <li
              key={id}
              className={`group/pane flex h-8 min-w-24 max-w-44 items-center gap-1 rounded-t border px-2 ${
                isFocused
                  ? 'border-b-base bg-base fg-primary'
                  : 'border-transparent bg-muted/25 fg-secondary hover:bg-muted/40 hover:fg-primary'
              }`}
            >
              {isPaneEditing ? (
                <InlineRename
                  className="text-3xs"
                  icon={
                    <AppCatalogTerminalIcon size={14} className="shrink-0" />
                  }
                  initialValue={paneCustomName ?? ''}
                  ariaLabel={`Rename terminal ${paneNumber}`}
                  onCommit={(name): void => onCommitTerminalName(id, name)}
                  onCancel={onCancelEdit}
                />
              ) : (
                <button
                  type="button"
                  onClick={(): void => onSelectTerminal(group.id, id)}
                  aria-label={`Terminal ${paneNumber}`}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-3xs"
                >
                  <AppCatalogTerminalIcon size={14} className="shrink-0" />
                  {paneDisplayName !== null ? (
                    <span className="min-w-0 truncate">{paneDisplayName}</span>
                  ) : (
                    <span className="shrink-0 tabular-nums">{paneNumber}</span>
                  )}
                  {paneStatus !== null && <RowStatus status={paneStatus} />}
                  {paneStateLabel !== null && (
                    <RowState label={paneStateLabel} />
                  )}
                </button>
              )}
              {!isPaneEditing && (
                <span className="shrink-0 opacity-0 transition-opacity group-hover/pane:opacity-100">
                  <Tooltip label="Rename">
                    <Button
                      variant="ghost-quiet"
                      size="sm"
                      iconOnly
                      aria-label={`Rename terminal ${paneNumber}`}
                      onClick={(): void => onStartEditTerminal(id)}
                    >
                      <AppCatalogPencilIcon size={14} />
                    </Button>
                  </Tooltip>
                </span>
              )}
              {!isPaneEditing && (
                <span className="shrink-0 opacity-0 transition-opacity group-hover/pane:opacity-100">
                  <Tooltip label="Close terminal">
                    <Button
                      variant="ghost-quiet"
                      size="sm"
                      iconOnly
                      aria-label={`Close terminal ${paneNumber}`}
                      onClick={(): void => onCloseTerminal(id)}
                    >
                      <AppCatalogCloseIcon size={14} />
                    </Button>
                  </Tooltip>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface InlineRenameProps {
  className: string;
  icon: JSX.Element;
  initialValue: string;
  ariaLabel: string;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}

// Inline edit input for a row label. Enter commits (empty → clears the custom
// name), Escape cancels, and leaving the field commits a change or cancels an
// unchanged one. Mounted via a render swap, so it auto-focuses and selects on
// mount.
function InlineRename({
  className,
  icon,
  initialValue,
  ariaLabel,
  onCommit,
  onCancel,
}: InlineRenameProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Guards the exit so the blur after a commit or Escape is a no-op.
  const settledRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = useCallback(
    (next: string): void => {
      if (settledRef.current) return;
      settledRef.current = true;
      const trimmed = next.trim();
      onCommit(trimmed.length === 0 ? null : trimmed);
    },
    [onCommit],
  );

  const cancel = useCallback((): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }, [onCancel]);

  return (
    <div
      className={`flex min-w-0 flex-1 items-center gap-1.5 font-mono ${className}`}
    >
      {icon}
      <InlineTextInput
        ref={inputRef}
        aria-label={ariaLabel}
        value={initialValue}
        maxLength={TERMINAL_CUSTOM_NAME_MAX_LENGTH}
        onCommit={commit}
        onCancel={cancel}
        onBlur={cancel}
        className="min-w-0 flex-1"
      />
    </div>
  );
}

interface RowStatusProps {
  status: TerminalStatus;
}

function RowStatus({ status }: RowStatusProps): JSX.Element | null {
  if (!status.running || status.processName === null) {
    return null;
  }
  return (
    <span
      className={`flex min-w-0 items-center gap-1 ${OPERATIONAL_STATUS_COLORS.active.foreground}`}
    >
      <RunningDot />
      <span className="min-w-0 truncate lowercase">{status.processName}</span>
    </span>
  );
}

interface RowStateProps {
  label: string;
}

function RowState({ label }: RowStateProps): JSX.Element {
  return (
    <span className="shrink-0 rounded border px-1 py-px text-3xs fg-secondary">
      {label}
    </span>
  );
}

function RunningDot(): JSX.Element {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-1.5 w-1.5 shrink-0 items-center justify-center"
    >
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full ${OPERATIONAL_STATUS_COLORS.active.backgroundPing}`}
      />
      <span
        className={`relative inline-flex h-1 w-1 rounded-full ${OPERATIONAL_STATUS_COLORS.active.background}`}
      />
    </span>
  );
}
