'use client';

import type { JSX, ReactNode } from 'react';
import { Button, LoadingSpinner } from '@canopy/ui-shared/components';
import { CircleCheckIcon, Plus } from '@canopy/ui-shared/icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { GitHubConnectionLink } from './team-projects-create-dialog';
import type { OrgProjectLocalStatus } from './organization-settings-slots';

/** `active` means work is running, never "current". */
type SetupStepStatus = 'completed' | 'active' | 'pending';

interface SetupStep {
  key: string;
  label: string;
  status: SetupStepStatus;
  description?: ReactNode;
  /** The step's one button, on the row's trailing edge. */
  action?: ReactNode;
  testId: string;
}

const STATUS_TEXT: Record<SetupStepStatus, string> = {
  completed: 'Done',
  active: 'In progress',
  pending: 'Not done',
};

/** A check once done, a spinner while running, an empty circle until then. */
function SetupStepIcon({ status }: { status: SetupStepStatus }): JSX.Element {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
      {status === 'completed' ? (
        <CircleCheckIcon
          size={20}
          aria-hidden
          className={OPERATIONAL_STATUS_COLORS.success.foreground}
        />
      ) : status === 'active' ? (
        <LoadingSpinner tone="active" sizePx={16} decorative />
      ) : (
        <span className="h-4 w-4 rounded-full ring-2 ring-fg-quaternary ring-inset" />
      )}
      <span className="sr-only">{STATUS_TEXT[status]}</span>
    </span>
  );
}

interface ProjectsSetupChecklistProps {
  detail: OrganizationDetail;
  replayBlock: string;
  /**
   * This desktop's statuses for this list's projects (the host's progress
   * can span organizations); null when the host can't set projects up.
   */
  localStatuses: readonly OrgProjectLocalStatus[] | null;
  onAdd: () => void;
}

/**
 * The first-run steps, one row per task: its state, what it is, and its
 * button. Only the first pending step carries a button.
 */
export function ProjectsSetupChecklist({
  detail,
  replayBlock,
  localStatuses,
  onAdd,
}: ProjectsSetupChecklistProps): JSX.Element {
  const { connected, accountLogin } = detail.githubConnection;
  const steps: SetupStep[] = [
    connected
      ? {
          key: 'connect',
          label: 'Connect GitHub',
          status: 'completed',
          testId: 'team-projects-setup-connect',
          ...(accountLogin
            ? {
                description: (
                  <>
                    Connected to{' '}
                    <span className={replayBlock}>{accountLogin}</span>.
                  </>
                ),
              }
            : {}),
        }
      : {
          key: 'connect',
          label: 'Connect GitHub',
          status: 'pending',
          testId: 'team-projects-setup-connect',
          description:
            'Each repository the GitHub App can access can become a project.',
          action: <GitHubConnectionLink orgId={detail.id} />,
        },
    {
      key: 'add',
      label: 'Add projects',
      status: 'pending',
      testId: 'team-projects-setup-add',
      description: 'Choose the repositories your organization works in.',
      ...(connected
        ? {
            action: (
              <Button
                variant="primary"
                data-testid="team-projects-create"
                onClick={onAdd}
              >
                <Plus size={14} />
                Add projects
              </Button>
            ),
          }
        : {}),
    },
  ];
  if (localStatuses !== null) {
    const status: SetupStepStatus = localStatuses.some(
      (entry): boolean => entry.state === 'setting-up',
    )
      ? 'active'
      : localStatuses.some((entry): boolean => entry.state === 'ready')
        ? 'completed'
        : 'pending';
    steps.push({
      key: 'local',
      label: 'Set up on this computer',
      status,
      testId: 'team-projects-setup-local',
      ...(status === 'pending'
        ? { description: 'Clone a project here so you can start chats in it.' }
        : {}),
    });
  }
  return (
    <ol className="divide-y rounded-lg border">
      {steps.map(
        (step): JSX.Element => (
          <li
            key={step.key}
            data-testid={step.testId}
            data-step-status={step.status}
            className="flex items-center gap-3 px-4 py-3"
          >
            <SetupStepIcon status={step.status} />
            <div className="min-w-0 flex-1">
              <p
                className={
                  step.status === 'completed'
                    ? 'text-s fg-secondary'
                    : 'text-s font-medium fg-primary'
                }
              >
                {step.label}
              </p>
              {step.description && (
                <p className="text-xs fg-secondary">{step.description}</p>
              )}
            </div>
            {step.action && <div className="shrink-0">{step.action}</div>}
          </li>
        ),
      )}
    </ol>
  );
}
