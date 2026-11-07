import type { JSX } from 'react';
import { WORKTREE_LABEL, CHAT_LABEL, CHAT_UNIT_LABEL } from '@canopy/protocol';
import { Button } from '@canopy/ui-shared';
import { brandText } from '@/lib/brand';
import {
  BranchIcon as AppCatalogBranchIcon,
  PlusIcon as AppCatalogPlusIcon,
  MessageIcon as AppCatalogMessageIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Heading, Surface } from '@canopy/ui-shared/components';

interface OverviewEmptyStateProps {
  onCreateWorkspace: () => void;
  onStartChat: () => void;
}

/**
 * First-run "getting started" hero for the Overview page. The Overview is an
 * attention dashboard meant for returning users; for a brand-new user with no
 * workspaces it is just a wall of "No X" panels, which reads as broken. When
 * there are no workspaces yet we replace the panel grid with this hero and a
 * couple of clear CTAs.
 *
 * Gated on having no workspaces (not on "all panels empty") — a returning user
 * with a quiet moment should still see the real dashboard. See the gate in
 * `OverviewPage`. Mirrors the Code tab's zero-workspace Home surface and the
 * Cowork tab's (`StandaloneColdStartEmptyState`) cold-start surfaces.
 */
export function OverviewEmptyState({
  onCreateWorkspace,
  onStartChat,
}: OverviewEmptyStateProps): JSX.Element {
  return (
    <div
      data-testid="overview-empty-state"
      className="flex flex-1 flex-col items-center justify-center p-8"
    >
      <div className="w-full max-w-2xl text-center">
        <Heading level={1} variant="page">
          Welcome to {brandText.appName}
        </Heading>
        <p className="mt-2 text-s fg-secondary">
          Create a project to put agents to work on your code, or start a chat
          to think something through. Your activity across every project will
          show up here.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-4 text-left sm:grid-cols-2">
          {/* Code / workspace on-ramp */}
          <Surface as="section" variant="card">
            <div className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-2 fg-primary">
                <AppCatalogBranchIcon size="sm" aria-hidden="true" />
                <Heading level={2} variant="title">
                  {WORKTREE_LABEL}
                </Heading>
              </div>
              <p className="flex-1 text-xs fg-secondary">
                Create an isolated worktree and put agents to work on your
                repository.
              </p>
              <Button
                variant="primary"
                onClick={onCreateWorkspace}
                data-testid="overview-empty-create-workspace"
              >
                <AppCatalogPlusIcon size="sm" aria-hidden="true" />
                Create a project
              </Button>
            </div>
          </Surface>

          {/* Cowork / chat on-ramp */}
          <Surface as="section" variant="card">
            <div className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-2 fg-primary">
                <AppCatalogMessageIcon size="sm" aria-hidden="true" />
                <Heading level={2} variant="title">
                  {CHAT_LABEL}
                </Heading>
              </div>
              <p className="flex-1 text-xs fg-secondary">
                Chat with an agent without a repo — brainstorm, plan, or ask a
                question.
              </p>
              <Button
                variant="secondary"
                onClick={onStartChat}
                data-testid="overview-empty-start-chat"
              >
                <AppCatalogPlusIcon size="sm" aria-hidden="true" />
                New {CHAT_UNIT_LABEL}
              </Button>
            </div>
          </Surface>
        </div>
      </div>
    </div>
  );
}
