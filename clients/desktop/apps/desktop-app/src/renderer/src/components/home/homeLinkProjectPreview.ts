import { useShallow } from 'zustand/shallow';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import type { HomeLinkTargetState } from './homeLinkTarget';

/**
 * What the Home project picker shows while a pasted link proposes a
 * destination other than the current selection (CAN-3606). Display only:
 * the composer's real selection is untouched, so dismissing the link brings
 * the picker straight back.
 */
export type HomeLinkProjectPreview =
  | { kind: 'existing-project'; workspaceId: string }
  | { kind: 'create-project'; repositoryLabel: string };

export interface HomeLinkProjectPreviewInput {
  mode: string;
  linkTarget: HomeLinkTargetState;
  workspaceId: string | null;
  workspaceSelectionExplicit: boolean;
  projects: readonly SidebarItem[];
}

export function homeLinkProjectPreview({
  mode,
  linkTarget,
  workspaceId,
  workspaceSelectionExplicit,
  projects,
}: HomeLinkProjectPreviewInput): HomeLinkProjectPreview | null {
  if (mode !== 'chat') return null;
  // A code project the user picked always wins over the link; the chip asks
  // them to resolve any mismatch instead.
  const selected = projects.find((project) => project.id === workspaceId);
  if (
    workspaceSelectionExplicit &&
    selected !== undefined &&
    selected.type !== 'cowork'
  ) {
    return null;
  }
  const plan =
    linkTarget.status === 'ready' || linkTarget.status === 'submitting'
      ? linkTarget.plan
      : linkTarget.status === 'resolving'
        ? linkTarget.previousPlan
        : undefined;
  if (!plan) return null;
  if (plan.kind === 'create-project') {
    return {
      kind: 'create-project',
      repositoryLabel: `${plan.repository.owner}/${plan.repository.repo}`,
    };
  }
  return plan.workspaceId === workspaceId
    ? null
    : { kind: 'existing-project', workspaceId: plan.workspaceId };
}

export function useHomeLinkProjectPreview(): HomeLinkProjectPreview | null {
  const projects = useProjectsStore((s) => s.projects);
  return useHomeComposerStore(
    useShallow((s) =>
      homeLinkProjectPreview({
        mode: s.mode,
        linkTarget: s.linkTarget,
        workspaceId: s.workspaceId,
        workspaceSelectionExplicit: s.workspaceSelectionExplicit,
        projects,
      }),
    ),
  );
}
