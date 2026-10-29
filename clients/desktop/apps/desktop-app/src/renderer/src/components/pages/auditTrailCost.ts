import type { AgentAuditEntry } from '@canopy/desktop-shared/types';

/**
 * The reason an observed-cost computation produced a non-priced result.
 * Derived from the shared transport type so this module never redefines it.
 */
type ObservedCostReason = NonNullable<
  AgentAuditEntry['observedCost']
>['reason'];

/**
 * User-facing speed names for the Codex service tiers a turn can request.
 * Regular (`default`/`standard`) requests are omitted from speed displays.
 * A `Map` so inherited `Object.prototype` keys never resolve to a label.
 */
const REQUESTED_SPEED_LABELS: ReadonlyMap<string, string> = new Map([
  ['priority', 'Fast'],
  ['fast', 'Fast'],
  ['ultrafast', 'Ultra fast'],
]);

const REGULAR_SERVICE_TIERS: ReadonlySet<string> = new Set([
  'default',
  'standard',
]);

/**
 * Human-readable copy for an unpriced Codex turn. Every reason maps to a
 * concise "Cost unavailable" message so no Codex entry renders a misleading
 * `$0`, while the most actionable reasons get a tailored sentence.
 * `serviceTier` is the requested tier, used to name a recognized speed whose
 * exact rates are missing.
 */
export function observedCostUnavailableMessage(
  reason: ObservedCostReason,
  serviceTier?: string,
): string {
  switch (reason) {
    case 'model_not_priced':
      return 'Cost unavailable: no published API pricing basis for this Codex model.';
    case 'pricing_unavailable':
      return 'Cost unavailable: pricing data could not be loaded.';
    case 'billable_tool_pricing_unavailable':
      return 'Cost partially unavailable: billable tool pricing could not be loaded.';
    case 'unsupported_fast_pricing':
      return 'Cost unavailable: Fast mode pricing is not published for this model.';
    case 'unsupported_service_tier': {
      const speed =
        serviceTier === undefined
          ? undefined
          : REQUESTED_SPEED_LABELS.get(serviceTier);
      return `Cost unavailable: pricing data has no rates for ${speed ?? 'the requested speed'}.`;
    }
    default:
      // model_missing / unsupported_usage_shape / invalid_pricing_payload and
      // any future reason fall back to a generic, non-misleading message.
      return 'Cost unavailable: cost could not be determined for this Codex turn.';
  }
}

function observedCostPartiallyUnavailableMessage(
  reason: ObservedCostReason,
  serviceTier?: string,
): string {
  switch (reason) {
    case 'model_not_priced':
      return 'Cost partially unavailable: no published API pricing basis for this Codex model.';
    default:
      return observedCostUnavailableMessage(reason, serviceTier);
  }
}

export interface RequestedSpeedDisplay {
  /** For example `Requested Ultra fast`. */
  requested: string;
  /** What the provider reported about the tier it actually served. */
  actual: string;
}

/**
 * The speed a turn requested, or `null` for Regular requests and entries
 * without a tier. `serviceTier` is request evidence only: the bundled Codex
 * runtime reports no served tier, so the actual tier is always unreported.
 * An unrecognized tier keeps its exact identifier.
 */
export function formatRequestedSpeed(
  entry: AgentAuditEntry,
): RequestedSpeedDisplay | null {
  const serviceTier = entry.serviceTier;
  if (!serviceTier || REGULAR_SERVICE_TIERS.has(serviceTier)) {
    return null;
  }
  return {
    requested: `Requested ${REQUESTED_SPEED_LABELS.get(serviceTier) ?? serviceTier}`,
    actual: 'Actual tier unreported',
  };
}

/**
 * The cost label to render in an audit row, or `null` when no cost cell should
 * appear. Backward-compatible: entries without `observedCost` (older entries,
 * Claude, Ollama) keep their previous behavior.
 *
 * - Partially priced turns show a partial-unavailable message before any
 *   incomplete positive total.
 * - Unpriced Codex turns (`observedCost.status === 'unpriced'`) show a
 *   `Cost unavailable` message with a concise reason, even beside a stale
 *   positive `totalCostUsd`.
 * - Other turns with `totalCostUsd > 0` (priced or provider-reported) show
 *   `$X.XXXX` (unchanged).
 * - Codex/Ollama turns without a priced cost show `Cost N/A` (unchanged).
 * - Everything else renders no cost cell.
 */
export function formatAuditCostLabel(entry: AgentAuditEntry): string | null {
  if (entry.modelGatewayRouted === true) {
    return null;
  }
  const requestedTier = entry.observedCost?.serviceTier ?? entry.serviceTier;
  if (entry.observedCost?.status === 'partially_priced') {
    return observedCostPartiallyUnavailableMessage(
      entry.observedCost.reason,
      requestedTier,
    );
  }
  // The explicit unpriced outcome is authoritative. `totalCostUsd` mirrors
  // `observedCost.totalUsd`, which an unpriced outcome never has, and
  // finalization deletes the total for one, so a positive total here is a
  // stale estimate (for example Standard or Fast rates for Ultra fast).
  if (entry.observedCost?.status === 'unpriced') {
    return observedCostUnavailableMessage(
      entry.observedCost.reason,
      requestedTier,
    );
  }
  if (typeof entry.totalCostUsd === 'number' && entry.totalCostUsd > 0) {
    return `$${entry.totalCostUsd.toFixed(4)}`;
  }
  if (entry.provider === 'codex' || entry.provider === 'ollama') {
    return 'Cost N/A';
  }
  return null;
}

export function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function entriesToCsv(entries: AgentAuditEntry[]): string {
  const headers = [
    'Started At',
    'Completed At',
    'Duration (ms)',
    'Event Type',
    'Label',
    'Status',
    'Provider',
    'Chat Mode',
    'Model',
    'Input Tokens',
    'Output Tokens',
    'Cache Read Tokens',
    'Cache Creation Tokens',
    'Total Cost (USD)',
    // Observed-cost disclosure columns. Appended after `Total Cost (USD)` so
    // existing consumers that read columns by leading position keep working;
    // these are blank for entries without an `observedCost` (older entries,
    // Claude, Ollama).
    'Observed Cost Status',
    'Observed Cost Reason',
    'Token Cost (USD)',
    'Non-Token Cost (USD)',
    'Pricing Basis',
    // AI Credits routing disclosure. Appended after the observed-cost columns
    // so existing position-based consumers keep working; blank for older
    // entries and natively-authenticated runs.
    'AI Credits Routed',
    'Messages',
    'Assistant Messages',
    'Tool Uses',
    'Sub-Agents',
    'Error',
    'Project ID',
    'Worktree ID',
    'Chat ID',
    'Session ID',
    'Repo ID',
    'Repo Label',
    'Pipeline Execution ID',
    'Job ID',
    'Step ID',
    'Attempt',
  ];

  const rows = entries.map((entry) =>
    [
      entry.startedAt,
      entry.completedAt ?? '',
      entry.durationMs !== undefined ? String(entry.durationMs) : '',
      entry.eventType,
      entry.label,
      entry.status,
      entry.provider,
      entry.chatMode ?? '',
      entry.model ?? '',
      String(entry.tokens.input),
      String(entry.tokens.output),
      String(entry.tokens.cacheReadInputTokens),
      String(entry.tokens.cacheCreationInputTokens),
      // An explicit unpriced outcome exports no stale flat total, matching
      // the audit row.
      entry.modelGatewayRouted !== true &&
      entry.observedCost?.status !== 'unpriced' &&
      entry.totalCostUsd !== undefined
        ? entry.totalCostUsd.toFixed(6)
        : '',
      entry.modelGatewayRouted !== true
        ? (entry.observedCost?.status ?? '')
        : '',
      entry.modelGatewayRouted !== true
        ? (entry.observedCost?.reason ?? '')
        : '',
      entry.modelGatewayRouted !== true &&
      entry.observedCost?.tokenUsd !== undefined
        ? entry.observedCost.tokenUsd.toFixed(6)
        : '',
      entry.modelGatewayRouted !== true &&
      entry.observedCost?.nonTokenUsd !== undefined
        ? entry.observedCost.nonTokenUsd.toFixed(6)
        : '',
      entry.modelGatewayRouted !== true
        ? (entry.observedCost?.pricingBasis ?? '')
        : '',
      entry.aiCreditsRouted && !entry.modelGatewayRouted ? 'Yes' : '',
      String(entry.messageCount),
      String(entry.assistantMessageCount),
      String(entry.toolUseCount),
      String(entry.subAgentCount),
      entry.error ?? '',
      entry.projectId ?? '',
      entry.worktreeId ?? '',
      entry.chatId ?? '',
      entry.sdkSessionId ?? '',
      entry.repoId ?? '',
      entry.repoLabel ?? '',
      entry.pipelineExecutionId ?? '',
      entry.jobId ?? '',
      entry.stepId ?? '',
      entry.attempt !== undefined ? String(entry.attempt) : '',
    ]
      .map(escapeCsvField)
      .join(','),
  );

  return [headers.join(','), ...rows].join('\n');
}
