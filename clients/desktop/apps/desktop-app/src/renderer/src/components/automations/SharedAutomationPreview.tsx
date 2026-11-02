import type { JSX } from 'react';
import { CHAT_LABEL, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type {
  SharedAutomationAction,
  SharedAutomationDetail,
  SharedAutomationTrigger,
} from '@canopy/protocol/automations';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import { buildShareablePluginDisplay } from '@canopy/desktop-shared/plugin-refs';
import { DescriptionMarkdown } from '@canopy/ui-shared/components/DescriptionMarkdown';
import { hasMarkdownDescriptionText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import { AutomationPublicShareRow } from './AutomationPublicShareRow';
import { canManagePublicLink } from '@/components/shared/share/canManagePublicLink';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * Local relationship between a shared Automation and this machine's
 * activities, derived by the caller from `remote` / `installedFrom` metadata:
 *  - `shared-by-you`: a local activity is the source of this share.
 *  - `installed`: a local copy was installed from this share and is current.
 *  - `update-available`: a local copy was installed from this share and the
 *    server document has changed since (contentHash mismatch).
 */
export type SharedAutomationLocalBadge =
  | 'shared-by-you'
  | 'installed'
  | 'update-available';

interface SharedAutomationPreviewProps {
  detail: SharedAutomationDetail;
  localBadge?: SharedAutomationLocalBadge | null;
}

const BADGE_COPY: Record<SharedAutomationLocalBadge, string> = {
  'shared-by-you': 'Shared by you',
  installed: 'Installed',
  'update-available': 'Update available',
};

const BADGE_CLASSES: Record<SharedAutomationLocalBadge, string> = {
  'shared-by-you': 'border-line-accent/40 bg-accent-subtle fg-accent',
  installed: 'border-line-positive/40 bg-success-subtle fg-primary',
  'update-available': 'border-fg-info/40 bg-info-subtle fg-primary',
};

/**
 * Render the trigger in the recipient-local timezone. Shared documents pin
 * `timezone: 'local'` by design: a cron fires on the recipient's clock, and a
 * one-time run shows as the local wall-clock instant.
 */
function describeTrigger(trigger: SharedAutomationTrigger): string {
  if (trigger.kind === 'cron') {
    return `${getAutomationTriggerLabel(trigger)} · ${trigger.expression}`;
  }
  return `${getAutomationTriggerLabel(trigger)} · ${new Date(
    trigger.runAt,
  ).toLocaleString()}`;
}

function describeSharedAction(action: SharedAutomationAction): string {
  switch (action.type) {
    case 'app_advisor_prompt':
      return `${ORCHESTRATOR_LABEL} prompt`;
    case 'standalone_prompt':
      return `${CHAT_LABEL} prompt (recipient picks the project)`;
    case 'worktree_prompt':
      return 'Worktree prompt (recipient picks the project)';
    case 'worktree_pipeline':
      switch (action.pipeline.source) {
        case 'bundled':
          return `Workflow · ${action.pipeline.name ?? action.pipeline.pipelineId} (bundled)`;
        case 'curated':
          return `Workflow · ${action.pipeline.name ?? action.pipeline.curatedKey} (curated)`;
        case 'unresolved':
          return `Workflow · ${action.pipeline.name ?? 'a workflow you choose'} (recipient picks the workflow)`;
        // The definition travels with the share, so an absent name must not
        // fall through to the `shared` wording (or render as empty).
        case 'inline':
        case 'packaged':
          return `Workflow · ${action.pipeline.name ?? 'included workflow'} (included in this share)`;
        default:
          return `Workflow · ${action.pipeline.name ?? 'shared workflow'} (shared)`;
      }
  }
}

function promptPreview(action: SharedAutomationAction): string | null {
  if (action.type === 'worktree_pipeline') return null;
  return action.prompt;
}

/**
 * Read-only detail pane for one shared Automation: the portable document
 * rendered field-by-field (trigger in recipient-local time, action summary,
 * portable plugins, input keys) plus ownership, lineage, and the local
 * install/share relationship badge. Pure display — installing is the PR9
 * wizard's job.
 */
export function SharedAutomationPreview({
  detail,
  localBadge,
}: SharedAutomationPreviewProps): JSX.Element {
  const { automation } = detail;
  const plugins =
    automation.action.type === 'worktree_pipeline'
      ? []
      : automation.action.plugins;
  const inputKeys =
    automation.action.type === 'worktree_pipeline'
      ? automation.action.inputKeys
      : [];
  const preview = promptPreview(automation.action);

  return (
    <div
      className="space-y-4 rounded-lg border bg-base p-4"
      data-testid="shared-automation-preview"
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="min-w-0"
          data-testid="shared-automation-preview-heading"
        >
          <h3 className="truncate text-base font-semibold fg-primary">
            {automation.name}
          </h3>
          {hasMarkdownDescriptionText(automation.description) && (
            <DescriptionMarkdown
              className="mt-1"
              dataTestId="share-description"
            >
              {automation.description}
            </DescriptionMarkdown>
          )}
        </div>
        {localBadge && (
          <span
            className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-3xs font-medium ${BADGE_CLASSES[localBadge]}`}
            data-testid={`shared-automation-badge-${localBadge}`}
          >
            {BADGE_COPY[localBadge]}
          </span>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-s sm:grid-cols-2">
        <div>
          <dt className="text-xs fg-secondary">Trigger</dt>
          <dd
            className="fg-primary"
            data-testid="shared-automation-preview-trigger"
          >
            {describeTrigger(automation.trigger)}
          </dd>
        </div>
        <div>
          <dt className="text-xs fg-secondary">Action</dt>
          <dd
            className="fg-primary"
            data-testid="shared-automation-preview-action"
          >
            {describeSharedAction(automation.action)}
          </dd>
        </div>
        <div>
          <dt className="text-xs fg-secondary">Owner</dt>
          <dd className="fg-primary">
            {/* A person owner's name is blocked from replay; a team's or
                organization's is recorded. */}
            {'name' in detail.owner && detail.owner.name !== null ? (
              <span
                className={
                  detail.owner.type === 'user'
                    ? POSTHOG_REPLAY_BLOCK_CLASS
                    : undefined
                }
              >
                {detail.owner.name}
              </span>
            ) : (
              detail.owner.type
            )}{' '}
            · {capitalizeFirstLetter(detail.shareScope)}
          </dd>
        </div>
        <div>
          <dt className="text-xs fg-secondary">Shared by</dt>
          <dd className="fg-primary">
            {/* The sharer is a person: replay records a box for the name. */}
            {detail.createdBy.name === null &&
            detail.createdBy.email === null ? (
              'Unknown'
            ) : (
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {detail.createdBy.name ?? detail.createdBy.email}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {/* The public link belongs to the share, not to the local automation,
          so it is managed from the shared-resource preview — the same
          placement `PipelinePublicShareRow` uses. Both inputs are already on
          the fetched detail, so this costs no extra request. */}
      <AutomationPublicShareRow
        remoteId={detail.id}
        initialShare={detail.publicShare ?? null}
        // The author can manage it, and so can an organization admin who
        // may delete a departed creator's share, as in the share dialog.
        canManage={canManagePublicLink(detail)}
      />

      {automation.hasRunCondition && (
        <p
          className="text-xs fg-secondary"
          data-testid="shared-automation-preview-run-condition"
        >
          {automation.runCondition
            ? 'The author included a run-condition command. You review it when installing.'
            : 'The author gated this automation with a run-condition command; the command itself stays on their machine.'}
        </p>
      )}

      {preview && (
        <div>
          <p className="mb-1 text-xs fg-secondary">Prompt</p>
          <pre
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-fg-primary/[0.03] px-3 py-2 text-xs fg-primary`}
            data-testid="shared-automation-preview-prompt"
          >
            {preview}
          </pre>
        </div>
      )}

      {inputKeys.length > 0 && (
        <div data-testid="shared-automation-preview-input-keys">
          <p className="mb-1 text-xs fg-secondary">
            Inputs you provide at install
          </p>
          <div className="flex flex-wrap gap-1.5">
            {inputKeys.map((key) => (
              <span
                key={key}
                className="rounded-full border bg-fg-primary/[0.04] px-2 py-0.5 text-3xs fg-primary"
              >
                {key}
              </span>
            ))}
          </div>
        </div>
      )}

      {plugins.length > 0 && (
        <div data-testid="shared-automation-preview-plugins">
          <p className="mb-1 text-xs fg-secondary">Plugins</p>
          <ul className="space-y-1">
            {plugins.map((ref, index) => {
              const display = buildShareablePluginDisplay(ref);
              return (
                <li
                  key={`${display.title}-${index}`}
                  className="text-xs fg-primary"
                >
                  {display.title}
                  <span className="fg-secondary"> · {display.subtitle}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {detail.savedFrom && (
        <p
          className="text-xs fg-secondary"
          data-testid="shared-automation-preview-lineage"
        >
          Forked from another shared automation.
        </p>
      )}
    </div>
  );
}
