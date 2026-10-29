import { memo, type JSX, type ReactNode } from 'react';
import type {
  AutomationArtifactReceiptV1,
  PipelineArtifactReceiptV1,
  SkillArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import type {
  AgentDefinitionArtifactReceiptV1,
  AutomationRunArtifactReceiptV1,
  CapabilityReferenceArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import {
  capabilityTileModel,
  type CapabilityTileReceipt,
} from '@canopy/ui-shared/components';
import {
  AgentIcon,
  AppAdvisorIcon,
  AutomationsIcon,
  BuildingIcon,
  ChatIcon,
  CommandIcon,
  PersonIcon,
  PipelineIcon,
  ScheduleIcon,
  SkillIcon,
} from '@canopy/ui-shared/icons';
import {
  PIPELINE_EXECUTION_SCOPE_BADGE_CLASS,
  PIPELINE_EXECUTION_SCOPE_META,
} from '@/components/pipeline/pipeline-execution-scope-meta';
import { PIPELINE_SOURCE_META } from '@/components/pipeline/pipeline-source-meta';
import {
  PIPELINE_SCOPE_META,
  normalizePipelineShareScope,
} from '@/components/pipeline/pipeline-scope-badge-helpers';
import { PipelineTriggerTypeIcon } from '@/components/pipeline/PipelineTriggerBadge';
import { TRIGGER_META } from '@/components/pipeline/pipeline-trigger-meta';

const SKILL_SOURCE_META: Record<
  SkillArtifactReceiptV1['source'],
  { label: string; badgeClass: string }
> = {
  installed: { label: 'Installed', badgeClass: 'bg-success-subtle fg-success' },
  shared: { label: 'Shared', badgeClass: 'bg-accent-subtle fg-accent' },
};

interface BadgeProps {
  className?: string;
  icon?: ReactNode;
  children: ReactNode;
}

interface StatusDotBadgeProps {
  tone: 'success' | 'info' | 'muted';
  children: ReactNode;
}

interface HeaderProps {
  icon: ReactNode;
  name: string;
  description?: string;
}

interface BadgesProps {
  children: ReactNode;
}

interface FactsProps {
  children: ReactNode;
}

interface FactProps {
  label: string;
  children: ReactNode;
}

interface PipelineTooltipProps {
  receipt: PipelineArtifactReceiptV1;
}

interface SkillTooltipProps {
  receipt: SkillArtifactReceiptV1;
}

interface AutomationTooltipProps {
  receipt: AutomationArtifactReceiptV1;
}

interface CapabilityTooltipProps {
  receipt:
    | AutomationRunArtifactReceiptV1
    | AgentDefinitionArtifactReceiptV1
    | CapabilityReferenceArtifactReceiptV1;
}

interface AgentArtifactTooltipProps {
  receipt: CapabilityTileReceipt;
}

/** Local wall-clock rendering for the ISO timestamps carried on receipts. */
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function Badge({
  className = 'bg-fg-primary/[0.08] fg-secondary',
  icon,
  children,
}: BadgeProps): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-3xs font-medium ${className}`}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

function StatusDotBadge({ tone, children }: StatusDotBadgeProps): JSX.Element {
  const chrome =
    tone === 'info'
      ? {
          badge: 'border-fg-info/40 bg-info-subtle fg-primary',
          dot: 'bg-info',
        }
      : tone === 'success'
        ? {
            badge: 'border-line-positive/40 bg-success-subtle fg-primary',
            dot: 'bg-success',
          }
        : {
            badge: 'bg-fg-primary/[0.04] fg-secondary',
            dot: 'bg-fg-secondary/70',
          };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-3xs font-medium ${chrome.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${chrome.dot}`} />
      {children}
    </span>
  );
}

function Header({ icon, name, description }: HeaderProps): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-px shrink-0 fg-secondary" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-medium break-words fg-primary">{name}</div>
        {description ? (
          <div className="mt-0.5 leading-snug break-words fg-secondary">
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Badges({ children }: BadgesProps): JSX.Element {
  return <div className="flex flex-wrap items-center gap-1">{children}</div>;
}

function Facts({ children }: FactsProps): JSX.Element {
  return <dl className="space-y-1 border-t pt-1.5">{children}</dl>;
}

function Fact({ label, children }: FactProps): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-14 shrink-0 fg-secondary">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1 break-words fg-primary">
        {children}
      </dd>
    </div>
  );
}

function PipelineTooltip({ receipt }: PipelineTooltipProps): JSX.Element {
  const sourceMeta = PIPELINE_SOURCE_META[receipt.source];
  const id = receipt.localId ?? receipt.sharedRemoteId;
  return (
    <>
      <Header
        icon={<PipelineIcon width={14} height={14} />}
        name={receipt.name}
        {...(receipt.description ? { description: receipt.description } : {})}
      />
      <Badges>
        <Badge className={sourceMeta.badgeClass}>{sourceMeta.label}</Badge>
        {receipt.enabled ? null : <Badge>Disabled</Badge>}
      </Badges>
      <Facts>
        <Fact label="Scope">
          {receipt.scopes.length > 0
            ? receipt.scopes.map((scope) => (
                <span
                  key={scope}
                  className={PIPELINE_EXECUTION_SCOPE_BADGE_CLASS}
                >
                  {PIPELINE_EXECUTION_SCOPE_META[scope].label}
                </span>
              ))
            : '—'}
        </Fact>
        <Fact label="Triggers">
          {receipt.runModes.length > 0
            ? receipt.runModes.map((mode) => (
                <span
                  key={mode}
                  role="img"
                  aria-label={TRIGGER_META[mode].label}
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded ${TRIGGER_META[mode].badgeClass}`}
                >
                  <PipelineTriggerTypeIcon type={mode} />
                </span>
              ))
            : '—'}
        </Fact>
        <Fact label="Steps">
          {receipt.jobCount} jobs · {receipt.stepCount} steps
        </Fact>
        {id ? (
          <Fact label="ID">
            <span className="truncate font-mono text-3xs fg-secondary">
              {id}
            </span>
          </Fact>
        ) : null}
      </Facts>
    </>
  );
}

function skillOwnerLabel(receipt: SkillArtifactReceiptV1): string | null {
  if (receipt.source === 'installed') return null;
  if (!receipt.owner) return 'Unknown';
  return receipt.owner.name ?? `${receipt.owner.type} ${receipt.owner.id}`;
}

function SkillTooltip({ receipt }: SkillTooltipProps): JSX.Element {
  const sourceMeta = SKILL_SOURCE_META[receipt.source];
  const shareScope = normalizePipelineShareScope(receipt.shareScope);
  const scopeMeta = PIPELINE_SCOPE_META[shareScope];
  const owner = skillOwnerLabel(receipt);
  return (
    <>
      <Header
        icon={<SkillIcon width={14} height={14} />}
        name={receipt.name}
        {...(receipt.description ? { description: receipt.description } : {})}
      />
      <Badges>
        <Badge className={sourceMeta.badgeClass}>{sourceMeta.label}</Badge>
        <Badge className={scopeMeta.badgeClass}>{scopeMeta.label}</Badge>
        {receipt.canUpdate ? null : <Badge>Read only</Badge>}
      </Badges>
      {owner ? (
        <Facts>
          <Fact label="Owner">
            <span aria-hidden="true" className="fg-secondary">
              {receipt.owner?.type === 'organization' ? (
                <BuildingIcon width={12} height={12} />
              ) : (
                <PersonIcon width={12} height={12} />
              )}
            </span>
            <span className="min-w-0 break-words">{owner}</span>
          </Fact>
        </Facts>
      ) : null}
    </>
  );
}

function automationActionIcon(actionKind: string): JSX.Element {
  if (actionKind.includes('pipeline'))
    return <PipelineIcon width={12} height={12} />;
  if (actionKind === 'app_advisor_prompt')
    return <AppAdvisorIcon width={12} height={12} />;
  return <ChatIcon width={12} height={12} />;
}

function AutomationTooltip({ receipt }: AutomationTooltipProps): JSX.Element {
  return (
    <>
      <Header
        icon={<AutomationsIcon width={14} height={14} />}
        name={receipt.name}
      />
      <Badges>
        {receipt.running ? (
          <StatusDotBadge tone="info">Running</StatusDotBadge>
        ) : (
          <StatusDotBadge tone={receipt.enabled ? 'success' : 'muted'}>
            {receipt.enabled ? 'Enabled' : 'Disabled'}
          </StatusDotBadge>
        )}
        {receipt.ifCommandConfigured ? (
          <Badge icon={<CommandIcon width={10} height={10} />}>
            If command
          </Badge>
        ) : null}
      </Badges>
      <Facts>
        <Fact label="Schedule">
          <span aria-hidden="true" className="fg-secondary">
            <ScheduleIcon width={12} height={12} />
          </span>
          <span className="min-w-0 break-words">{receipt.schedule}</span>
        </Fact>
        {receipt.nextRunAt ? (
          <Fact label="Next run">{formatTimestamp(receipt.nextRunAt)}</Fact>
        ) : null}
        <Fact label="Runs">
          <span aria-hidden="true" className="fg-secondary">
            {automationActionIcon(receipt.actionKind)}
          </span>
          <span className="min-w-0 break-words">{receipt.targetSummary}</span>
        </Fact>
      </Facts>
    </>
  );
}

const RUN_TRIGGER_LABELS: Record<
  AutomationRunArtifactReceiptV1['trigger'],
  string
> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  catch_up: 'Catch-up',
};

/** Runs, agents and capability references reuse the tile's own wording. */
function CapabilityTooltip({ receipt }: CapabilityTooltipProps): JSX.Element {
  const model = capabilityTileModel(receipt);
  const description =
    receipt.kind === 'automation_run' ? undefined : receipt.description;
  return (
    <>
      <Header
        icon={
          receipt.kind === 'agent' ? (
            <AgentIcon width={14} height={14} />
          ) : (
            <AutomationsIcon width={14} height={14} />
          )
        }
        name={receipt.name}
        {...(description ? { description } : {})}
      />
      <Badges>
        <Badge>{model.kindLabel}</Badge>
        {model.state ? <Badge>{model.state.label}</Badge> : null}
        {model.external ? <Badge>External</Badge> : null}
      </Badges>
      <Facts>
        {receipt.kind === 'automation_run' ? (
          <>
            <Fact label="Trigger">{RUN_TRIGGER_LABELS[receipt.trigger]}</Fact>
            <Fact label="Started">{formatTimestamp(receipt.startedAt)}</Fact>
            {receipt.completedAt ? (
              <Fact label="Ended">{formatTimestamp(receipt.completedAt)}</Fact>
            ) : null}
          </>
        ) : null}
        {receipt.kind === 'agent' && receipt.model ? (
          <Fact label="Model">{receipt.model}</Fact>
        ) : null}
        {model.sourceLabel ? (
          <Fact label="Source">{model.sourceLabel}</Fact>
        ) : null}
        {model.reason ? <Fact label="Why">{model.reason}</Fact> : null}
      </Facts>
    </>
  );
}

/**
 * Hover detail for an agent-activity artifact card. The card itself is the
 * affordance for opening the artifact, so this surface stays purely
 * informational — badges and glyphs mirror the pipelines / automations
 * surfaces the artifact links to.
 */
export const AgentArtifactTooltip = memo(function AgentArtifactTooltip({
  receipt,
}: AgentArtifactTooltipProps): JSX.Element {
  return (
    <div className="space-y-2 text-xs">
      {receipt.kind === 'pipeline' ? (
        <PipelineTooltip receipt={receipt} />
      ) : receipt.kind === 'skill' ? (
        <SkillTooltip receipt={receipt} />
      ) : receipt.kind === 'automation' ? (
        <AutomationTooltip receipt={receipt} />
      ) : (
        <CapabilityTooltip receipt={receipt} />
      )}
    </div>
  );
});
