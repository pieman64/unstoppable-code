/**
 * The Cowork page's top bar — the git-free sibling of {@link WorktreeTopBar},
 * mounted by StandaloneChatPage above the panel grid. Mirrors the worktree
 * header's frame exactly (46px bar, 9px edge padding, sidebar-matched
 * breadcrumb typography): left to right,
 *
 * - the collapsed-titlebar spacer (same corner-reservation rationale as
 *   WorktreeTopBar's list view);
 * - the breadcrumb: a clickable [workspace icon + name] hover-pill (same
 *   28px pill spec as the worktree breadcrumb) that opens the cowork
 *   workspace settings modal; cowork has no branches, so it is the single
 *   segment;
 * - the "Open in" dropdown (resolves the cowork root, honoring an attached
 *   external folder — cwd resolution is entry-agnostic, so passing the entry
 *   id as worktreeId is fine) and the layout dropdown (saves the
 *   Cowork-surface default) pinned right.
 *
 * New Chat and the archived-chats control moved to the chat tab strip (the
 * panel add-tab menu and the per-group archived accessory), matching the
 * worktree header. No PrStatusBar / WorktreeLaunchButton: cowork workspaces
 * have no git branches, PRs, or worktree scripts.
 */
import { memo, useState, type JSX, type ReactNode } from 'react';
import { useProjectsStore } from '@/stores/projectsStore';
import { useShallow } from 'zustand/shallow';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { CollapsedTitlebarToggle } from '@/components/sidebar/CollapsedTitlebarToggle';
import { OpenDropdown } from '@/components/worktree/OpenDropdown';
import { WorkspaceLayoutControls } from '@/components/panels/WorkspaceLayoutControls';
import { ProjectIcon } from '@/components/shared/ProjectIcon';
import { ChatProjectSettingsModal } from '@/components/standalone-chat/ChatProjectSettingsModal';
import { useTopBarLeadingInsetClassName } from '@/components/panels/useTopBarLeadingInsetClassName';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export interface CoworkTopBarProps {
  workspaceId: string;
  /** Read-only shared-container slots; omitting this keeps normal Cowork behavior. */
  readOnlyContent?: {
    leadingAccessory?: ReactNode;
    statusContent: ReactNode;
    launchControl?: ReactNode;
    trailingAccessory?: ReactNode;
  };
}

export const CoworkTopBar = memo(function CoworkTopBar({
  workspaceId,
  readOnlyContent,
}: CoworkTopBarProps): JSX.Element | null {
  const activeWorkEntryId = useStandaloneChatStore((s) => s.activeWorkEntryId);
  // `useShallow`: both stores rebuild their arrays immutably, so the found
  // record's reference can change while its fields have not — shallow
  // comparison keeps unrelated store updates from re-rendering the bar.
  const workspace = useProjectsStore(
    useShallow((s) => s.projects.find((project) => project.id === workspaceId)),
  );
  // The settings modal edits the standalone store's ChatProjectData record
  // (same modal + actions the sidebar cowork row uses).
  const chatProject = useStandaloneChatStore(
    useShallow((s) => s.chatProjects.find((p) => p.id === workspaceId) ?? null),
  );
  const updateChatProject = useStandaloneChatStore((s) => s.updateChatProject);
  const deleteChatProject = useStandaloneChatStore((s) => s.deleteChatProject);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const leadingInsetClassName = useTopBarLeadingInsetClassName();
  const workspaceName = workspace?.name ?? '';
  const workspaceColor = workspace?.color;
  const externalPath =
    workspace?.type === 'cowork' ? workspace.externalPath : undefined;

  // StandaloneChatPage only mounts this bar once an entry is active; this is
  // a defensive guard for the transition frames around entry switches.
  if (readOnlyContent !== undefined) {
    return (
      <div
        data-testid="cowork-top-bar"
        className="@container/prbar flex min-h-11.5 shrink-0 items-stretch border-b bg-secondary"
      >
        {readOnlyContent.leadingAccessory}
        <div
          className={`electron-drag flex min-w-0 flex-1 items-center py-2.25 pr-4 ${leadingInsetClassName}`}
        >
          {readOnlyContent.statusContent}
        </div>
        {readOnlyContent.launchControl}
        {readOnlyContent.trailingAccessory}
      </div>
    );
  }

  if (activeWorkEntryId === null) {
    return null;
  }

  return (
    <div
      data-testid="cowork-top-bar"
      // `min-h-[46px]` matches the worktree top bar's height (9px breathing
      // room around the 28px titlebar icon buttons, control centers level
      // with the titlebar corner controls); `items-stretch` grows each
      // section to fill it.
      // `@container/prbar` lives on the ROOT so OpenDropdown's compact-mode
      // query (`@[560px]/prbar:`) resolves — container queries only see
      // ancestor containers, and the dropdown sits outside the breadcrumb
      // section.
      // The surface lives on the ROOT so the background and bottom border run
      // the full width, including the leading spacer that reserves the
      // collapsed titlebar corner (mirrors the worktree top bar).
      className="@container/prbar flex min-h-11.5 shrink-0 items-stretch border-b bg-secondary"
    >
      <CollapsedTitlebarToggle />
      <div
        className={`electron-drag flex min-w-0 flex-1 items-center py-2.25 pr-4 ${leadingInsetClassName}`}
      >
        {/* Clickable breadcrumb pill (worktree-header parity: same 28px
            frame, typography, 9px icon→name gap, hover surface); opens the
            cowork workspace settings modal. */}
        <button
          type="button"
          data-testid="cowork-top-workspace-button"
          onClick={(): void => setSettingsOpen(true)}
          aria-label="Project settings"
          className="electron-no-drag focus-ring flex h-7 min-w-0 items-center gap-2.25 rounded-md pl-1 pr-2 text-s font-normal fg-primary transition-colors hover:bg-subtle"
        >
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
            <ProjectIcon kind="cowork" color={workspaceColor} />
          </span>
          <span
            data-testid="cowork-top-workspace-name"
            className={`${POSTHOG_REPLAY_MASK_CLASS} min-w-0 truncate`}
            title={workspaceName}
          >
            {workspaceName}
          </span>
        </button>
      </div>
      <div className="electron-drag flex shrink-0 items-center gap-2 pr-2.25">
        <OpenDropdown projectId={workspaceId} worktreeId={activeWorkEntryId} />
        <WorkspaceLayoutControls
          projectId={workspaceId}
          worktreeId={activeWorkEntryId}
        />
      </div>
      <ChatProjectSettingsModal
        isOpen={settingsOpen}
        project={chatProject}
        externalPath={externalPath}
        onClose={(): void => setSettingsOpen(false)}
        onSave={updateChatProject}
        onDelete={deleteChatProject}
      />
    </div>
  );
});
