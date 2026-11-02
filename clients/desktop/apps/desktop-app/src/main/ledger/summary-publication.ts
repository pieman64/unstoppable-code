import {
  LEDGER_GRANTS,
  LEDGER_LIMITS,
  type CanopyCallerDescriptor,
  type LedgerAuthorDetails,
  type LedgerContainer,
  type LedgerPublishSummaryParams,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { CanopyOperationError } from '@canopy/core-runtime';
import { LEDGER_COMMAND_OPERATIONS } from '@canopy/desktop-shared/node/ledger';
import type {
  WorktreeSummaryProvenance,
  WorktreeSummarySnapshot,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { WorktreeSummaryWriteAbortReason } from '../lib/worktree-summary-persistence';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { DESKTOP_LEDGER_TOOLS_HOST } from '../canopy-tools/ledger-tools-runtime';
import { getFeatureFlagService } from '../feature-flags';
import { getObservabilityService } from '../observability';
import {
  getLedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistration,
} from './caller-bindings';
import { resolveDesktopLedgerScope } from './core-ledger-adapter';
import { resolveLedgerContainerCreatedAt } from './scope-bindings';
import { getLedgerStoreClient } from './storage-client';
import { ledgerContainerForViewScope } from './view-scope';

/*
 * Summary publication (phase 09, LD06). Each meaningful Summary-panel
 * snapshot generated while the Ledger is on becomes one SUMMARY/INFO entry,
 * authored and owned by the helper invocation that generated it. The summary
 * file is the journal: a snapshot records its provenance and whether it is
 * publishable, publishing is keyed by `summary:<ledgerId>:<snapshotId>`, and
 * startup reconciliation replays any publication a crash or a lost response
 * left unfinished. Publishing never blocks the Summary panel; the Summary
 * helper itself never gets Ledger tools.
 */

/** The display name of the helper actor that authors Summary entries. */
const SUMMARY_HELPER_DISPLAY_NAME = 'Summary';
/** A publication's caller binding outlives its command by at most this. */
const PUBLICATION_BINDING_TTL_MS = 60_000;
const ELLIPSIS = '…';

/** What publication needs from the app; tests substitute their own. */
export interface SummaryPublicationHost {
  /** `canopy-ledger-enabled`. */
  readonly isEnabled: () => boolean;
  /** The already-running desktop dispatcher, or null at shutdown. */
  readonly dispatcher: () => Pick<
    DesktopCanopyDispatcher,
    'instruction'
  > | null;
  readonly registry: () => {
    register(registration: LedgerCallerBindingRegistration): string;
    revoke(bindingId: string): boolean;
  };
  /** The Ledger container of a Summary scope, or null when it has none. */
  readonly container: (
    projectId: string,
    worktreeId: string,
  ) => LedgerContainer | null;
  /** Null when the container no longer exists. */
  readonly containerCreatedAt: (
    container: LedgerContainer,
  ) => Promise<string | null>;
  /** The ledger of a container incarnation, minted on first use. */
  readonly ledgerId: (
    container: LedgerContainer,
    containerCreatedAt: string,
  ) => Promise<string>;
  /** Which of the publication keys already hold a receipt. */
  readonly publishedKeys: (
    ledgerId: string,
    keys: readonly string[],
  ) => Promise<string[]>;
  /** Records a content-free diagnostic: counts only, never IDs or text. */
  readonly recordGap: (reason: string) => void;
}

function isLedgerFlagEnabled(): boolean {
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
    );
  } catch {
    return false;
  }
}

/**
 * A Summary scope's Ledger container: a code worktree, or a Cowork or App
 * Advisor Work Entry, as for the chats in it.
 */
export function summaryLedgerContainer(
  projectId: string,
  worktreeId: string,
): LedgerContainer | null {
  return ledgerContainerForViewScope({ projectId, worktreeId });
}

export const DESKTOP_SUMMARY_PUBLICATION_HOST: SummaryPublicationHost = {
  isEnabled: isLedgerFlagEnabled,
  dispatcher: () => DESKTOP_LEDGER_TOOLS_HOST.dispatcher(),
  registry: getLedgerCallerBindingRegistry,
  container: summaryLedgerContainer,
  containerCreatedAt: (container): Promise<string | null> =>
    resolveLedgerContainerCreatedAt(container),
  ledgerId: async (container, containerCreatedAt): Promise<string> =>
    (await resolveDesktopLedgerScope(container, containerCreatedAt)).ledgerId,
  publishedKeys: (ledgerId, keys): Promise<string[]> =>
    getLedgerStoreClient().listReceiptKeys({
      ledgerId,
      operation: LEDGER_COMMAND_OPERATIONS.publishSummary,
      idempotencyKeys: keys,
    }),
  recordGap: (reason): void =>
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'ledger_summary_publication_gap',
      reason,
    }),
};

/** The idempotency key of a snapshot's publication. */
export function summaryPublicationKey(
  ledgerId: string,
  snapshotId: string,
): string {
  return `summary:${ledgerId}:${snapshotId}`;
}

/** A snapshot that is to be published, with the provenance that says so. */
export type PublishableSummarySnapshot = WorktreeSummarySnapshot & {
  readonly provenance: WorktreeSummaryProvenance & {
    readonly ledgerPublishable: true;
  };
};

export function isPublishableSummarySnapshot(
  snapshot: WorktreeSummarySnapshot,
): snapshot is PublishableSummarySnapshot {
  return snapshot.provenance?.ledgerPublishable === true;
}

/** Control characters a Ledger field rejects become spaces. */
function withoutControlCharacters(
  value: string,
  allowLineBreaks: boolean,
): string {
  let text = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isLineBreak =
      codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
    text += isControl && !(allowLineBreaks && isLineBreak) ? ' ' : character;
  }
  return text;
}

/**
 * A field at most `limit` code points long, cut with an ellipsis when it was
 * longer. Code points are kept whole, so no surrogate pair is split.
 */
function boundedField(
  value: string,
  limit: number,
  allowLineBreaks: boolean,
): { readonly text: string; readonly truncated: boolean } {
  const text = withoutControlCharacters(value, allowLineBreaks).trim();
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) return { text, truncated: false };
  return {
    text: `${codePoints
      .slice(0, limit - ELLIPSIS.length)
      .join('')
      .trimEnd()}${ELLIPSIS}`,
    truncated: true,
  };
}

/**
 * The publish params of a snapshot: its title, description and first five
 * highlights within the Ledger's limits. `sourceTruncated` records that text
 * was cut or highlights dropped; the entry's origin links the snapshot, which
 * keeps the full summary.
 */
export function projectSummaryForLedger(
  snapshot: PublishableSummarySnapshot,
): LedgerPublishSummaryParams {
  const { summary, provenance } = snapshot;
  const title = boundedField(
    summary.title,
    LEDGER_LIMITS.titleMaxCodePoints,
    false,
  );
  const content = boundedField(
    summary.description,
    LEDGER_LIMITS.contentMaxCodePoints,
    true,
  );
  const highlights = summary.highlights
    .map((highlight) =>
      boundedField(highlight, LEDGER_LIMITS.highlightMaxCodePoints, false),
    )
    .filter((highlight) => highlight.text.length > 0);
  const kept = highlights.slice(0, LEDGER_LIMITS.highlightsMax);
  const sourceTruncated =
    title.truncated ||
    content.truncated ||
    highlights.length > kept.length ||
    kept.some((highlight) => highlight.truncated);
  return {
    snapshotId: snapshot.snapshotId,
    generationId: provenance.generationId,
    title: title.text,
    content: content.text,
    ...(kept.length > 0
      ? { highlights: kept.map((highlight) => highlight.text) }
      : {}),
    sourceTruncated,
    // The Audit Trail task, when it fits the Ledger's opaque ID limit.
    ...(provenance.observedTaskKey !== null &&
    Array.from(provenance.observedTaskKey).length <=
      LEDGER_LIMITS.opaqueIdMaxCodePoints
      ? { observedTaskId: provenance.observedTaskKey }
      : {}),
  };
}

/** A captured setting within the Ledger's bounds, or null. */
function boundedSetting(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return Array.from(trimmed)
    .slice(0, LEDGER_LIMITS.settingMaxCodePoints)
    .join('');
}

/** The helper's details as captured before the provider was invoked. */
function helperAuthorDetails(
  provenance: WorktreeSummaryProvenance,
): LedgerAuthorDetails {
  return {
    harness: boundedSetting(provenance.harness),
    model: boundedSetting(provenance.model),
    thinkingEffort: boundedSetting(provenance.thinkingEffort),
    mode: null,
    pipelineExecutionId: null,
    settingsRevision: null,
    unavailableReason: null,
  };
}

function publisherCaller(bindingId: string): CanopyCallerDescriptor {
  return {
    principalId: bindingId,
    clientInstanceId: 'desktop-main',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    // A trusted in-process host call, like the chats' Ledger tools.
    interfaceKind: 'daemon',
    grants: [LEDGER_GRANTS.publishSummary],
  };
}

/**
 * Whether a snapshot generated now in the scope is to be published: the
 * Ledger is on and the scope has a Ledger container. Recorded on the
 * snapshot's provenance before the helper runs.
 */
export function isSummaryScopePublishable(
  scope: SummaryScope,
  host: Pick<
    SummaryPublicationHost,
    'isEnabled' | 'container'
  > = DESKTOP_SUMMARY_PUBLICATION_HOST,
): boolean {
  return (
    host.isEnabled() &&
    host.container(scope.projectId, scope.worktreeId) !== null
  );
}

/** How a publication attempt ended. */
export type SummaryPublicationOutcome =
  | 'published'
  /** The Ledger is off or the runtime is not running; a later pass retries. */
  | 'unavailable'
  /** The command failed; a later pass retries it. */
  | 'failed'
  /** The Ledger rejected the projection; retrying the same one cannot help. */
  | 'rejected';

/** An error no retry of the same request can get past. */
function isPermanentRejection(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.kind === 'invalid_argument'
  );
}

/** Summary scopes are a project and a worktree or Work Entry. */
export interface SummaryScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** One scope's resolved Ledger: its container incarnation and ledger. */
export interface SummaryScopeLedger {
  readonly container: LedgerContainer;
  readonly containerCreatedAt: string;
  readonly ledgerId: string;
}

/**
 * The scope's Ledger, minted on first use; null when the Ledger is off or the
 * scope has no container.
 */
export async function resolveSummaryScopeLedger(
  scope: SummaryScope,
  host: SummaryPublicationHost = DESKTOP_SUMMARY_PUBLICATION_HOST,
): Promise<SummaryScopeLedger | null> {
  if (!host.isEnabled()) return null;
  const container = host.container(scope.projectId, scope.worktreeId);
  if (container === null) return null;
  const containerCreatedAt = await host.containerCreatedAt(container);
  if (containerCreatedAt === null) return null;
  const ledgerId = await host.ledgerId(container, containerCreatedAt);
  return { container, containerCreatedAt, ledgerId };
}

const inFlight = new Map<string, Promise<SummaryPublicationOutcome>>();

/**
 * Publishes one snapshot of an already-resolved scope. A concurrent
 * publication of the same snapshot (the scheduler and reconciliation) shares
 * one attempt. Never rejects.
 */
export function publishResolvedSummarySnapshot(
  scopeLedger: SummaryScopeLedger,
  snapshot: PublishableSummarySnapshot,
  host: SummaryPublicationHost = DESKTOP_SUMMARY_PUBLICATION_HOST,
): Promise<SummaryPublicationOutcome> {
  const key = summaryPublicationKey(scopeLedger.ledgerId, snapshot.snapshotId);
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const attempt = publishOnce(scopeLedger, snapshot, key, host).finally(
    (): void => {
      if (inFlight.get(key) === attempt) inFlight.delete(key);
    },
  );
  inFlight.set(key, attempt);
  return attempt;
}

async function publishOnce(
  scopeLedger: SummaryScopeLedger,
  snapshot: PublishableSummarySnapshot,
  idempotencyKey: string,
  host: SummaryPublicationHost,
): Promise<SummaryPublicationOutcome> {
  const dispatcher = host.dispatcher();
  if (dispatcher === null || !host.isEnabled()) return 'unavailable';
  const registry = host.registry();
  let bindingId: string;
  try {
    bindingId = registry.register({
      container: scopeLedger.container,
      containerCreatedAt: scopeLedger.containerCreatedAt,
      actor: {
        kind: 'background',
        originKey: `summary:${snapshot.provenance.generationId}`,
        displayName: SUMMARY_HELPER_DISPLAY_NAME,
      },
      role: 'summary_publisher',
      authorDetails: helperAuthorDetails(snapshot.provenance),
      runtimeGeneration: 0,
      ttlMs: PUBLICATION_BINDING_TTL_MS,
    });
  } catch {
    return 'failed';
  }
  try {
    await dispatcher.instruction(
      'core.ledger.summary.publish',
      { ...projectSummaryForLedger(snapshot), _meta: { idempotencyKey } },
      {
        caller: publisherCaller(bindingId),
        metadata: { idempotencyKey },
      },
    );
    return 'published';
  } catch (error) {
    return isPermanentRejection(error) ? 'rejected' : 'failed';
  } finally {
    registry.revoke(bindingId);
  }
}

/**
 * Reports a summary file that did not parse and was replaced, since any
 * snapshot it held can no longer publish. Content free, and only while the
 * scope's snapshots are publishable.
 */
export function reportReplacedSummaryFile(
  scope: SummaryScope,
  host: SummaryPublicationHost = DESKTOP_SUMMARY_PUBLICATION_HOST,
): void {
  if (isSummaryScopePublishable(scope, host)) {
    host.recordGap('journal_replaced: 1');
  }
}

/**
 * Reports a summary write that was aborted to keep the file it could not
 * read or that a newer app wrote: the new snapshot was never journaled.
 * Content free, and only while the scope's snapshots are publishable.
 */
export function reportAbortedSummaryWrite(
  scope: SummaryScope,
  reason: WorktreeSummaryWriteAbortReason,
  host: SummaryPublicationHost = DESKTOP_SUMMARY_PUBLICATION_HOST,
): void {
  if (isSummaryScopePublishable(scope, host)) {
    host.recordGap(`journal_${reason}: 1`);
  }
}

/**
 * Reports history entries that did not validate and a summary write dropped.
 * What they held is unknown, so only their count is reported, and only while
 * the scope's snapshots are publishable.
 */
export function reportInvalidSummarySnapshots(
  scope: SummaryScope,
  count: number,
  host: SummaryPublicationHost = DESKTOP_SUMMARY_PUBLICATION_HOST,
): void {
  if (count > 0 && isSummaryScopePublishable(scope, host)) {
    host.recordGap(`journal_entries_dropped: ${String(count)}`);
  }
}

/**
 * Records `<reason>: <count>` for the snapshots without a publication
 * receipt, or `<reason>_unverified: <count>` for all of them when receipts
 * cannot be read. Never rejects.
 */
async function reportUnpublishedSnapshots(
  scope: SummaryScope,
  snapshotIds: readonly string[],
  reason: 'aged_out' | 'provenance_stripped',
  host: SummaryPublicationHost,
): Promise<void> {
  if (snapshotIds.length === 0) return;
  try {
    const scopeLedger = await resolveSummaryScopeLedger(scope, host);
    if (scopeLedger === null) {
      if (host.container(scope.projectId, scope.worktreeId) !== null) {
        host.recordGap(`${reason}_unverified: ${String(snapshotIds.length)}`);
      }
      return;
    }
    const keys = snapshotIds.map((snapshotId) =>
      summaryPublicationKey(scopeLedger.ledgerId, snapshotId),
    );
    const published = new Set(
      await host.publishedKeys(scopeLedger.ledgerId, keys),
    );
    const missing = keys.filter((key) => !published.has(key)).length;
    if (missing > 0) host.recordGap(`${reason}: ${String(missing)}`);
  } catch {
    host.recordGap(`${reason}_unverified: ${String(snapshotIds.length)}`);
  }
}

/**
 * Reports publishable snapshots a summary write dropped from the capped
 * history before they published: they can no longer be reconciled. Content
 * free: only a count reaches the diagnostic. Never rejects.
 */
export async function reportDroppedSummarySnapshots(
  scope: SummaryScope,
  snapshotIds: readonly string[],
  host: SummaryPublicationHost = DESKTOP_SUMMARY_PUBLICATION_HOST,
): Promise<void> {
  await reportUnpublishedSnapshots(scope, snapshotIds, 'aged_out', host);
}

/**
 * Reports publishable snapshots whose provenance did not validate, which a
 * summary write kept unpublishable before they published. Content free: only
 * a count reaches the diagnostic. Never rejects.
 */
export async function reportStrippedSummaryProvenance(
  scope: SummaryScope,
  snapshotIds: readonly string[],
  host: SummaryPublicationHost = DESKTOP_SUMMARY_PUBLICATION_HOST,
): Promise<void> {
  await reportUnpublishedSnapshots(
    scope,
    snapshotIds,
    'provenance_stripped',
    host,
  );
}
