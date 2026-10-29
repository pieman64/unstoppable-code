import { useId, useState, type JSX, type ReactNode } from 'react';
import type { SubagentNode } from '@canopy/agent-transcript';
import { REPLAY_BLOCK_CLASS } from '../../../../lib/replay-privacy';
import { DelegatedAgentCapabilities } from '../../DelegatedAgentCapabilities';
import {
  delegatedAgentCapabilityCountsLabel,
  hasDelegatedAgentCapabilityEntries,
} from '../../delegated-agent-copy';
import {
  SUBAGENT_FACTS_ERROR_MAX_LENGTH,
  SUBAGENT_PERMISSIONS_APPROVALS_NOTE,
  SUBAGENT_PERMISSIONS_READ_ONLY,
  SUBAGENT_SETUP_ERROR,
  SUBAGENT_SETUP_HARNESS,
  SUBAGENT_SETUP_MODEL,
  SUBAGENT_SETUP_PERMISSIONS,
  SUBAGENT_SETUP_RUNS,
  SUBAGENT_SETUP_SUBAGENTS,
  SUBAGENT_SETUP_THINKING,
  SUBAGENT_SETUP_TYPE,
  SUBAGENT_SETUP_USAGE,
  SUBAGENT_SETUP_WORKSPACE,
  SUBAGENT_SHOW_FEWER_PATHS_LABEL,
  SUBAGENT_SHOW_FULL_ERROR_LABEL,
  SUBAGENT_SHOW_LESS_ERROR_LABEL,
  SUBAGENT_SHOW_LESS_LABEL,
  SUBAGENT_SHOW_MORE_LABEL,
  SUBAGENT_WORKFLOW_AGENT_LABEL,
  subagentFailureText,
  subagentPermissionsEditsLabel,
  subagentRunsLabel,
  subagentShowMorePathsAccessibleLabel,
  subagentShowMorePathsLabel,
  subagentStartedCountLabel,
  subagentWorkspaceLabel,
} from '../subagent-copy';

export interface SubagentSetupDetailsProps {
  readonly node: SubagentNode;
  readonly executionMode?: 'foreground' | 'background';
  readonly showUsage?: boolean;
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <>
      <dt className="fg-tertiary">{label}</dt>
      <dd className="min-w-0 break-words fg-primary">{children}</dd>
    </>
  );
}

function usageLabel(node: SubagentNode): string | undefined {
  const usage = node.snapshot?.usage;
  if (!usage) return undefined;
  const cost =
    usage.costUsd === undefined ? '' : ` · $${usage.costUsd.toFixed(4)}`;
  return `${usage.inputTokens ?? 0} input · ${usage.outputTokens ?? 0} output${cost}`;
}

function capabilityCountLabel(node: SubagentNode): string | undefined {
  const summary = node.snapshot?.capabilities;
  if (!hasDelegatedAgentCapabilityEntries(summary)) return undefined;
  return delegatedAgentCapabilityCountsLabel(summary);
}

/** Write paths listed before Show more; one more is shown rather than hidden. */
const COLLAPSED_WRITE_PATHS = 5;
/** Characters of a long error shown before Show full error. */
const COLLAPSED_ERROR_CHARACTERS = 240;

const TOGGLE_CLASSNAME =
  'self-start fg-secondary underline hover:fg-primary focus-visible:outline focus-visible:ring-1 focus-visible:ring-line-accent';

function PermissionsDetail({
  writePaths,
}: {
  readonly writePaths: readonly string[];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (writePaths.length === 0) return <>{SUBAGENT_PERMISSIONS_READ_ONLY}</>;
  const collapsible = writePaths.length > COLLAPSED_WRITE_PATHS + 1;
  const shown =
    collapsible && !expanded
      ? writePaths.slice(0, COLLAPSED_WRITE_PATHS)
      : writePaths;
  const remaining = writePaths.length - shown.length;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span>{subagentPermissionsEditsLabel(writePaths.length)}</span>
      <ul
        id={listId}
        data-testid="subagent-chat-permissions-paths"
        className="flex min-w-0 list-none flex-col gap-0.5 p-0 font-mono text-2xs fg-secondary"
      >
        {shown.map((path, index) => (
          // A hanging indent keeps a wrapped path apart from the next one.
          <li
            key={`${index}:${path}`}
            className="min-w-0 pl-3 -indent-3 wrap-anywhere"
          >
            <span className={REPLAY_BLOCK_CLASS}>{path}</span>
          </li>
        ))}
      </ul>
      {collapsible ? (
        <button
          type="button"
          data-testid="subagent-chat-permissions-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={
            expanded
              ? SUBAGENT_SHOW_FEWER_PATHS_LABEL
              : subagentShowMorePathsAccessibleLabel(remaining)
          }
          className={TOGGLE_CLASSNAME}
          onClick={(): void => setExpanded((current): boolean => !current)}
        >
          {expanded
            ? SUBAGENT_SHOW_LESS_LABEL
            : subagentShowMorePathsLabel(remaining)}
        </button>
      ) : null}
      <span className="fg-tertiary">{SUBAGENT_PERMISSIONS_APPROVALS_NOTE}</span>
    </div>
  );
}

function ErrorDetail({ error }: { readonly error: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const collapsible = error.length > COLLAPSED_ERROR_CHARACTERS;
  const shown =
    collapsible && !expanded
      ? `${error.slice(0, COLLAPSED_ERROR_CHARACTERS).trimEnd()}…`
      : error;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span
        id={textId}
        data-testid="subagent-chat-setup-error"
        className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap wrap-anywhere fg-destructive`}
      >
        {shown}
      </span>
      {collapsible ? (
        <button
          type="button"
          data-testid="subagent-chat-setup-error-toggle"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={
            expanded
              ? SUBAGENT_SHOW_LESS_ERROR_LABEL
              : SUBAGENT_SHOW_FULL_ERROR_LABEL
          }
          className={TOGGLE_CLASSNAME}
          onClick={(): void => setExpanded((current): boolean => !current)}
        >
          {expanded ? SUBAGENT_SHOW_LESS_LABEL : SUBAGENT_SHOW_MORE_LABEL}
        </button>
      ) : null}
    </div>
  );
}

/** Reports only provider-supplied facts for native subagents. */
export function SubagentSetupDetails({
  node,
  executionMode,
  showUsage = true,
}: SubagentSetupDetailsProps): JSX.Element {
  const route = node.snapshot?.routeSnapshot;
  const model =
    node.modelLabel ??
    route?.runtimeModelLabel ??
    route?.selectedModelLabel ??
    route?.runtimeModelId ??
    route?.selectedModelId ??
    node.snapshot?.requestedModelId;
  const modelId =
    route?.runtimeModelId ??
    route?.selectedModelId ??
    node.snapshot?.requestedModelId;
  const harness = node.harnessId ?? route?.harnessId;
  const thinking =
    node.thinkingLevel ??
    route?.effectiveThinkingLevel ??
    route?.requestedThinkingLevel;
  const writePaths =
    node.kind === 'managed' && node.snapshot
      ? (node.snapshot.permissions?.writePaths ?? [])
      : undefined;
  // The facts line already shows a short error.
  const failure = subagentFailureText(node);
  const longError =
    failure && failure.length > SUBAGENT_FACTS_ERROR_MAX_LENGTH
      ? failure
      : undefined;
  const capabilities = capabilityCountLabel(node);
  const usage = usageLabel(node);
  const shouldShowRuns = node.kind === 'managed' || node.runs.length > 0;
  const subagentType =
    node.kind === 'workflow-agent'
      ? SUBAGENT_WORKFLOW_AGENT_LABEL
      : node.kind !== 'managed'
        ? node.subagentType
        : undefined;

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      {longError ? (
        <DetailRow label={SUBAGENT_SETUP_ERROR}>
          <ErrorDetail error={longError} />
        </DetailRow>
      ) : null}
      {subagentType ? (
        <DetailRow label={SUBAGENT_SETUP_TYPE}>{subagentType}</DetailRow>
      ) : null}
      {model ? (
        <DetailRow label={SUBAGENT_SETUP_MODEL}>
          {model}
          {modelId && modelId !== model ? (
            <span className="font-mono text-2xs fg-tertiary"> ({modelId})</span>
          ) : null}
        </DetailRow>
      ) : null}
      {harness ? (
        <DetailRow label={SUBAGENT_SETUP_HARNESS}>{harness}</DetailRow>
      ) : null}
      {thinking ? (
        <DetailRow label={SUBAGENT_SETUP_THINKING}>{thinking}</DetailRow>
      ) : null}
      {shouldShowRuns ? (
        <DetailRow label={SUBAGENT_SETUP_RUNS}>
          {subagentRunsLabel(executionMode, node.runs.length)}
        </DetailRow>
      ) : null}
      {node.kind === 'managed' && node.workspace ? (
        <DetailRow label={SUBAGENT_SETUP_WORKSPACE}>
          {subagentWorkspaceLabel(node)}
        </DetailRow>
      ) : null}
      {writePaths ? (
        <DetailRow label={SUBAGENT_SETUP_PERMISSIONS}>
          <PermissionsDetail writePaths={writePaths} />
        </DetailRow>
      ) : null}
      {capabilities && node.snapshot?.capabilities ? (
        <DelegatedAgentCapabilities summary={node.snapshot.capabilities} />
      ) : null}
      {node.kind === 'managed' ? (
        <DetailRow label={SUBAGENT_SETUP_SUBAGENTS}>
          {subagentStartedCountLabel(node.childIds.length)}
        </DetailRow>
      ) : null}
      {showUsage && usage ? (
        <DetailRow label={SUBAGENT_SETUP_USAGE}>{usage}</DetailRow>
      ) : null}
    </dl>
  );
}
