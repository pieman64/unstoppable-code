// Compile-time + runtime exhaustiveness guard: the telemetry protocol unions
// (in @canopy/protocol, which cannot import desktop-shared) must stay in sync
// with their desktop-shared sources. This test lives desktop-side because
// only desktop-shared may import the protocol package, not vice versa.
//
// Each `Equals<...>` line fails to COMPILE if a union drifts; each runtime
// assertion fails if a protocol const array drifts from the desktop union. The
// `Record<Union, true>` sample literals additionally force the desktop unions
// to be enumerated exhaustively (omit a key -> tsc error, add a stray key ->
// tsc error), which is what catches the tool-count count risk.
//
// `AgentAuditEventType` is intentionally NOT a bijection with
// `TelemetryEventType`: desktop can grow audit-only event types (see
// `pr_split_planning`) that are never uploaded to cloud telemetry. That
// relationship is modeled by `AUDIT_EVENT_TELEMETRY_MAPPING`
// (`packages/desktop-shared/src/lib/telemetry-mapping.ts`), which is typed
// `Record<AgentAuditEventType, TelemetryEventType | null>` so tsc forces a
// decision at every new `AgentAuditEventType`. The runtime assertions below
// verify: every `TelemetryEventType` appears as a mapped (non-null) value,
// every non-null mapped value is a valid `TelemetryEventType`, and the set of
// audit-only (null-mapped) types is exactly the explicit expected list — so
// the next unmapped addition fails loudly here even under ts-jest's
// `isolatedModules: true` (which skips type-checking, and thus skips the
// `Equals<...>` assertions below).

import {
  PR_CHECK_STATUSES,
  PR_REVIEW_STATUSES,
  PR_STATES,
  TELEMETRY_CHAT_MODES,
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_PROVIDERS,
  TELEMETRY_TOOL_CATEGORIES,
  TELEMETRY_TURN_STATUSES,
  type PrCheckStatusValue,
  type PrReviewStatusValue,
  type PrStateValue,
  type TelemetryChatMode,
  type TelemetryEventType,
  type TelemetryProhibitedScopeKey,
  type TelemetryProvider,
  type TelemetryToolCategory,
  type TelemetryTurnStatus,
} from '@canopy/protocol';
import { AUDIT_EVENT_TELEMETRY_MAPPING } from '../lib/telemetry-mapping';
import { TELEMETRY_SHARING_SCOPES, type TelemetryScopeKey } from '../types';
import type { AgentProviderType } from '../types';
import type { CheckStatus, PrState, ReviewStatus } from '../types/github';
import type {
  AgentAuditChatMode,
  AgentAuditEventType,
  AgentAuditStatus,
  AgentAuditToolCounts,
} from '../types/observability';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

// --- Compile-time bijection assertions (errors here are tsc errors) ---------
//
// `AgentAuditEventType` is deliberately excluded here — see the file header
// comment and the "audit-only event types" runtime assertions below.

type _ToolCategories = Equals<
  keyof AgentAuditToolCounts,
  TelemetryToolCategory
>;
type _Statuses = Equals<AgentAuditStatus, TelemetryTurnStatus>;
type _ChatModes = Equals<AgentAuditChatMode, TelemetryChatMode>;
type _Providers = Equals<AgentProviderType, TelemetryProvider>;
type _PrStates = Equals<PrState, PrStateValue>;
type _CheckStatuses = Equals<CheckStatus, PrCheckStatusValue>;
type _ReviewStatuses = Equals<ReviewStatus, PrReviewStatusValue>;
// The 403 `telemetry_scope_prohibited` body names a scope key. It must be the
// same closed set the desktop sharing preferences are keyed by; a `string`
// there (or a drifted union) lets a client silently ignore a scope it cannot
// handle.
type _ProhibitedScopes = Equals<TelemetryScopeKey, TelemetryProhibitedScopeKey>;

const assertTrue = <T extends true>(value: T): T => value;
assertTrue<_ToolCategories>(true);
assertTrue<_Statuses>(true);
assertTrue<_ChatModes>(true);
assertTrue<_Providers>(true);
assertTrue<_PrStates>(true);
assertTrue<_CheckStatuses>(true);
assertTrue<_ReviewStatuses>(true);
assertTrue<_ProhibitedScopes>(true);

// --- Exhaustive sample literals (omitting/adding a key is a tsc error) -------

const TOOL_COUNT_KEYS: Record<keyof AgentAuditToolCounts, true> = {
  thinking: true,
  bash: true,
  read: true,
  readLines: true,
  writeEdit: true,
  plan: true,
  fileEdit: true,
  fileAdd: true,
  fileDelete: true,
  search: true,
  grep: true,
  web: true,
  agent: true,
  workflow: true,
  tasks: true,
  taskStop: true,
  skills: true,
  monitor: true,
  claude: true,
  scheduleWakeup: true,
  askUser: true,
  scriptOutput: true,
  watcher: true,
  canopy: true,
  graph: true,
  appAdvisor: true,
  pipelineEditor: true,
  mcp: true,
  other: true,
};

const STATUS_KEYS: Record<AgentAuditStatus, true> = {
  running: true,
  success: true,
  failure: true,
  cancelled: true,
  interrupted: true,
};

const CHAT_MODE_KEYS: Record<AgentAuditChatMode, true> = {
  canopy: true,
  terminal: true,
};

const PROVIDER_KEYS: Record<AgentProviderType, true> = {
  claude: true,
  codex: true,
  ollama: true,
};

const PR_STATE_KEYS: Record<PrState, true> = {
  open: true,
  merged: true,
  closed: true,
  draft: true,
};

const CHECK_STATUS_KEYS: Record<CheckStatus, true> = {
  passing: true,
  failing: true,
  pending: true,
  neutral: true,
  none: true,
};

const REVIEW_STATUS_KEYS: Record<ReviewStatus, true> = {
  approved: true,
  changes_requested: true,
  pending: true,
  none: true,
};

const PROHIBITED_SCOPE_KEYS: Record<TelemetryProhibitedScopeKey, true> = {
  transcripts: true,
  plans: true,
  metadata: true,
  summaries: true,
};

// Explicit, reviewed list of audit event types that are deliberately
// audit-only (never uploaded to cloud telemetry). Adding a new audit-only
// type requires touching this list, which is the point: it forces a reviewer
// to see the decision instead of it silently happening inside the mapping.
const EXPECTED_AUDIT_ONLY_EVENT_TYPES: readonly AgentAuditEventType[] = [
  'pr_split_planning',
  'chat_handoff_summary',
  'code_review_annotations',
  'code_review_diagram',
  'local_memory_consolidation',
  'local_memory_chat_profile',
  'skill_suggestion_scan',
  // Local cost attribution for a delegation run; not a chat turn.
  'managed_delegation',
];

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function isTelemetryEventType(
  value: TelemetryEventType | null,
): value is TelemetryEventType {
  return value !== null;
}

describe('telemetry protocol fidelity', () => {
  it('tool categories match AgentAuditToolCounts keys exactly', () => {
    expect(sorted(TELEMETRY_TOOL_CATEGORIES)).toEqual(
      sorted(Object.keys(TOOL_COUNT_KEYS)),
    );
  });

  it('every TelemetryEventType is reachable via a non-null AUDIT_EVENT_TELEMETRY_MAPPING value', () => {
    const mappedValues = Object.values(AUDIT_EVENT_TELEMETRY_MAPPING).filter(
      isTelemetryEventType,
    );
    expect(sorted(TELEMETRY_EVENT_TYPES)).toEqual(sorted(mappedValues));
  });

  it('audit-only (null-mapped) event types are exactly the explicit expected list', () => {
    const auditOnlyTypes = Object.entries(AUDIT_EVENT_TELEMETRY_MAPPING)
      .filter(([, telemetryType]) => telemetryType === null)
      .map(([auditType]) => auditType);
    expect(sorted(auditOnlyTypes)).toEqual(
      sorted(EXPECTED_AUDIT_ONLY_EVENT_TYPES),
    );
  });

  it('turn statuses match AgentAuditStatus exactly', () => {
    expect(sorted(TELEMETRY_TURN_STATUSES)).toEqual(
      sorted(Object.keys(STATUS_KEYS)),
    );
  });

  it('chat modes match AgentAuditChatMode exactly', () => {
    expect(sorted(TELEMETRY_CHAT_MODES)).toEqual(
      sorted(Object.keys(CHAT_MODE_KEYS)),
    );
  });

  it('providers match AgentProviderType exactly', () => {
    expect(sorted(TELEMETRY_PROVIDERS)).toEqual(
      sorted(Object.keys(PROVIDER_KEYS)),
    );
  });

  it('PR unions match types/github exactly', () => {
    expect(sorted(PR_STATES)).toEqual(sorted(Object.keys(PR_STATE_KEYS)));
    expect(sorted(PR_CHECK_STATUSES)).toEqual(
      sorted(Object.keys(CHECK_STATUS_KEYS)),
    );
    expect(sorted(PR_REVIEW_STATUSES)).toEqual(
      sorted(Object.keys(REVIEW_STATUS_KEYS)),
    );
  });

  it('prohibited-scope keys match TELEMETRY_SHARING_SCOPES exactly', () => {
    expect(sorted(TELEMETRY_SHARING_SCOPES)).toEqual(
      sorted(Object.keys(PROHIBITED_SCOPE_KEYS)),
    );
  });
});
