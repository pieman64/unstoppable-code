import { Fragment, useRef, type JSX, type ReactNode } from 'react';
import type { TerminalGroup } from '@canopy/desktop-shared/types';
import { type WorktreeTerminalBucket } from '@/stores/terminalStore';
import {
  getTerminalReadOnlyMessage,
  isTerminalRestorableSession,
} from '@/lib/terminal-session-state';
import { TerminalPane } from './TerminalPane';
import { TerminalSplitGutter } from './TerminalSplitGutter';
import { TerminalList } from './TerminalList';
import { Button } from '@canopy/ui-shared/components';

interface TerminalTabProps {
  projectId: string;
  worktreeId: string;
  bucket: WorktreeTerminalBucket | undefined;
  unavailable: boolean;
  spawnError: string | null;
  spawning: boolean;
  activeGroup: TerminalGroup | null;
  /**
   * Right-aligned panel controls (New terminal, launch-profile menu, Split)
   * rendered inline with the session-tab strip in panel mode. Omitted in
   * drawer mode, where the controls live in the drawer's own tab strip.
   */
  actions?: ReactNode;
  onSpawn: (options?: { intoGroupId?: string }) => Promise<void>;
  onSelectGroup: (groupId: string) => void;
  onSelectTerminal: (groupId: string, terminalId: string) => void;
  onSetSplitSizes: (groupId: string, sizes: number[]) => void;
  onCloseGroup: (groupId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}

export function TerminalTab({
  projectId,
  worktreeId,
  bucket,
  unavailable,
  spawnError,
  spawning,
  activeGroup,
  actions,
  onSpawn,
  onSelectGroup,
  onSelectTerminal,
  onSetSplitSizes,
  onCloseGroup,
  onCloseTerminal,
}: TerminalTabProps): JSX.Element {
  if (unavailable) {
    return (
      <div className="flex h-full items-center justify-center text-s fg-secondary">
        Terminal unavailable on this platform
      </div>
    );
  }

  const hasAnyGroups = bucket !== undefined && bucket.groups.length > 0;
  const totalTerminalCount = bucket
    ? bucket.groups.reduce(
        (count, group) => count + group.terminalIds.length,
        0,
      )
    : 0;
  const showTerminalList = hasAnyGroups && totalTerminalCount > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showTerminalList && bucket ? (
        <TerminalList
          projectId={projectId}
          worktreeId={worktreeId}
          bucket={bucket}
          actions={actions}
          onSelectGroup={onSelectGroup}
          onSelectTerminal={onSelectTerminal}
          onCloseGroup={onCloseGroup}
          onCloseTerminal={onCloseTerminal}
        />
      ) : (
        // Empty state (no groups yet): keep a minimal strip so the panel
        // controls — notably New terminal — stay reachable before the first
        // session exists.
        actions !== undefined && (
          <div className="flex h-10 shrink-0 items-end justify-end border-b bg-card/40 px-1 pt-1">
            <div className="mb-1 flex items-center gap-0.5">{actions}</div>
          </div>
        )
      )}
      <div className="flex min-h-0 flex-1">
        {hasAnyGroups && activeGroup ? (
          <GroupSplitView
            projectId={projectId}
            worktreeId={worktreeId}
            group={activeGroup}
            sessions={bucket.sessions}
            onFocusPane={(terminalId): void => {
              onSelectTerminal(activeGroup.id, terminalId);
            }}
            onSetSplitSizes={(sizes): void => {
              onSetSplitSizes(activeGroup.id, sizes);
            }}
          />
        ) : (
          <EmptyState
            onCreate={(): void => {
              void onSpawn();
            }}
            spawnError={spawnError}
            spawning={spawning}
          />
        )}
      </div>
    </div>
  );
}

interface GroupSplitViewProps {
  projectId: string;
  worktreeId: string;
  group: TerminalGroup;
  sessions: WorktreeTerminalBucket['sessions'];
  onFocusPane: (terminalId: string) => void;
  onSetSplitSizes: (sizes: number[]) => void;
}

function GroupSplitView({
  projectId,
  worktreeId,
  group,
  sessions,
  onFocusPane,
  onSetSplitSizes,
}: GroupSplitViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { terminalIds, splitSizes, focusedTerminalId } = group;

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {terminalIds.map((id, index) => {
        const size = splitSizes[index] ?? 1 / terminalIds.length;
        const session = sessions[id];
        const paneContent = (
          <TerminalPane
            terminalId={id}
            projectId={projectId}
            worktreeId={worktreeId}
            live={session?.live ?? false}
            restoreOnMount={
              session ? isTerminalRestorableSession(session) : false
            }
            readOnlyMessage={
              session ? getTerminalReadOnlyMessage(session) : null
            }
            focused={focusedTerminalId === id}
            onFocus={(): void => onFocusPane(id)}
          />
        );
        const pane = (
          <div
            key={id}
            className="flex min-h-0 min-w-0"
            style={{ flexBasis: 0, flexGrow: size }}
          >
            {paneContent}
          </div>
        );
        if (index === terminalIds.length - 1) {
          return pane;
        }
        // Two-pane split: horizontal gutter adjusts left fraction directly.
        // For 3+ panes we implement a uniform rebalance that keeps the
        // pane to the left of the gutter anchored at the dragged fraction.
        const leftCount = index + 1;
        const totalPanes = terminalIds.length;
        return (
          <Fragment key={`${id}-split`}>
            {pane}
            <TerminalSplitGutter
              containerRef={containerRef}
              index={index}
              paneCount={terminalIds.length}
              onDrag={(fraction): void => {
                // Normalize: left panes share `fraction` evenly, right panes
                // share `1 - fraction` evenly. Simple + predictable for v1.
                const leftEach = fraction / leftCount;
                const rightEach = (1 - fraction) / (totalPanes - leftCount);
                const next: number[] = [];
                for (let i = 0; i < totalPanes; i += 1) {
                  next.push(i <= index ? leftEach : rightEach);
                }
                onSetSplitSizes(next);
              }}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

interface EmptyStateProps {
  onCreate: () => void;
  spawnError: string | null;
  spawning: boolean;
}

function EmptyState({
  onCreate,
  spawnError,
  spawning,
}: EmptyStateProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-s fg-secondary">
      <span>No terminals</span>
      {spawnError !== null && (
        <span className="max-w-md px-4 text-center text-xs fg-destructive">
          {spawnError}
        </span>
      )}
      <Button size="compact" onClick={onCreate} disabled={spawning}>
        + Create terminal
      </Button>
    </div>
  );
}
