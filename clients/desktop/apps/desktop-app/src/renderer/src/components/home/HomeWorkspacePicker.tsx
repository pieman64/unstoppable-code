import { useEffect, useMemo, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { isDefaultCoworkWorkspaceId } from '@canopy/desktop-shared/types';
import { isDefaultCoworkWorkspaceName } from '@/lib/defaultCoworkWorkspaceName';
import { useProjectsStore } from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import {
  isComposerHomeScope,
  OPEN_WORKSPACE_PICKER_EVENT,
} from '@/lib/composerShortcutRequests';
import { WorkspaceDropdown } from '../shared/WorkspaceDropdown';
import { shouldShowHomeWorkspacePicker, useHomeScope } from './homeScope';
import { useHomeLinkProjectPreview } from './homeLinkProjectPreview';

/**
 * Home composer's project picker. Unlike the old Create Task modal's
 * dropdown, this surfaces every sidebar workspace — code and cowork alike,
 * with no `isEligibleWorkspace`-style filter — plus a trailing "Add
 * workspace…" row that reuses the existing `openAddWorkspaceModal`
 * navigation-store flag so Home doesn't need a parallel request/consume
 * pair.
 *
 * Only projects in the selected Personal/organization context are offered,
 * by the sidebar's rule (`homeScope`).
 *
 * The one exception is the default cowork workspace. It is where a chat with
 * no project context lands, and the trigger still says so, but the sidebar
 * renders it as the top-level Chats section rather than a project — so
 * listing it as a pickable project made it look like somewhere you file a
 * chat, and its stale sidebar `order` dropped it in the middle of the real
 * projects for no visible reason (CAN-2363 follow-up).
 */
interface HomeWorkspacePickerProps {
  commandOpenSignal?: number;
  /** True only for the standalone Home page that owns global shortcuts. */
  shortcutEnabled: boolean;
  /** Returns the caret to the Home composer once the picker closes. */
  onRestoreFocus?: () => void;
}

export function HomeWorkspacePicker({
  commandOpenSignal = 0,
  shortcutEnabled,
  onRestoreFocus,
}: HomeWorkspacePickerProps): JSX.Element | null {
  const allProjects = useProjectsStore((s) => s.projects);
  const scope = useHomeScope();
  const { projects, defaultCoworkId, onlyDefaultChats } = scope;
  const { workspaceId, mode, selectWorkspace } = useHomeComposerStore(
    useShallow((s) => ({
      workspaceId: s.workspaceId,
      mode: s.mode,
      selectWorkspace: s.selectWorkspace,
    })),
  );
  // A pasted link's proposed project, shown in place of the selection.
  const linkPreview = useHomeLinkProjectPreview();
  const openAddWorkspaceModal = useNavigationStore(
    (s) => s.openAddWorkspaceModal,
  );
  // Every catch-all (Personal's and each organization's) stays unlisted; a
  // memo keeps the dropdown's own memos from invalidating per render.
  const unlistedWorkspaceIds = useMemo(
    (): readonly string[] =>
      allProjects
        .filter((project) => isDefaultCoworkWorkspaceId(project.id))
        .map((project) => project.id),
    [allProjects],
  );

  // Shared predicate, so this cannot disagree with the sidebar section about
  // what counts as a name the user chose.
  const defaultCoworkRenamed = useMemo(() => {
    const entry = projects.find((project) => project.id === defaultCoworkId);
    return entry !== undefined && !isDefaultCoworkWorkspaceName(entry.name);
  }, [projects, defaultCoworkId]);

  const sortedWorkspaces = useMemo(
    () => [...projects].sort((a, b) => a.order - b.order),
    [projects],
  );

  // ⌥W opens the picker (ECW-7984 follow-up). The standalone and embedded
  // Home surfaces can coexist, so only the standalone page subscribes.
  const [openSignal, setOpenSignal] = useState(0);
  useEffect(() => {
    if (!shortcutEnabled) {
      return undefined;
    }

    function handleOpenRequest(event: Event): void {
      // `CustomEvent.detail` is `any`; the scope guard below narrows it.
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : null;
      if (mode !== 'chat' || !isComposerHomeScope(detail)) {
        return;
      }
      event.preventDefault();
      setOpenSignal((signal) => signal + 1);
    }

    document.addEventListener(OPEN_WORKSPACE_PICKER_EVENT, handleOpenRequest);
    return (): void => {
      document.removeEventListener(
        OPEN_WORKSPACE_PICKER_EVENT,
        handleOpenRequest,
      );
    };
  }, [mode, shortcutEnabled]);

  if (!shouldShowHomeWorkspacePicker(scope, workspaceId) && !linkPreview) {
    return null;
  }

  return (
    <div data-testid="home-workspace-picker">
      <WorkspaceDropdown
        workspaces={sortedWorkspaces}
        unlistedWorkspaceIds={unlistedWorkspaceIds}
        // The draft still points at the default cowork project — it is an
        // ordinary project with a fixed id, and nothing internal changes. The
        // trigger just declines to name it, because presenting the catch-all
        // as a chosen project is what made people think their chat had been
        // filed somewhere they could not find it.
        //
        // Unless the user renamed it: a name they chose is a deliberate
        // signal, and withholding it puts this trigger back out of step with
        // the sidebar section, which does render the stored name.
        //
        // With no project in scope the catch-all is the only destination, so
        // the chip names it rather than reading as an empty picker.
        selectedWorkspaceId={
          linkPreview?.kind === 'existing-project'
            ? linkPreview.workspaceId
            : linkPreview?.kind === 'create-project' ||
                workspaceId === null ||
                (workspaceId === defaultCoworkId &&
                  !defaultCoworkRenamed &&
                  !onlyDefaultChats)
              ? ''
              : workspaceId
        }
        allowUnset
        pendingWorkspace={
          linkPreview?.kind === 'create-project'
            ? { title: `New project for ${linkPreview.repositoryLabel}` }
            : undefined
        }
        placeholder="Choose project"
        onSelect={(id): void => {
          const current = useHomeComposerStore.getState();
          const target = current.linkTarget;
          if (
            target.status !== 'idle' &&
            target.status !== 'inactive' &&
            current.workspaceId !== id &&
            current.fileReferences.some(
              (reference) =>
                reference.kind === undefined ||
                reference.kind === 'file' ||
                reference.kind === 'folder' ||
                reference.kind === 'prompt',
            )
          ) {
            current.setSendError(
              current.fileReferences.some(
                (reference) => reference.kind === 'prompt',
              )
                ? 'Remove the saved prompt mentions before switching projects, or dismiss the link.'
                : 'Remove the file mentions before switching projects, or dismiss the link.',
            );
            return;
          }
          selectWorkspace(id, {
            explicit: true,
            ...(target.status !== 'idle' && target.status !== 'inactive'
              ? { preserveDraft: true }
              : {}),
          });
        }}
        onClear={
          // Clearing the project means "this is just a chat" — which is the
          // default cowork workspace, not an absent one. It stays a real
          // project with its fixed id; only the presentation differs.
          workspaceId === defaultCoworkId || linkPreview
            ? undefined
            : (): void => selectWorkspace(defaultCoworkId, { explicit: true })
        }
        onAddWorkspace={openAddWorkspaceModal}
        testIdPrefix="home-workspace"
        capsule
        openSignal={openSignal + commandOpenSignal}
        onRestoreFocus={onRestoreFocus}
      />
    </div>
  );
}
