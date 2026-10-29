import type {
  AuthDependencyFailure,
  CanopyAuthFailureEventData,
} from '@canopy/protocol/auth-recovery';
import { isValidAuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import type { UsageInitiationSource } from '../types/observability';
import { parseMcpToolName } from './turn-utils';

/**
 * Policy for what a mid-turn authentication failure does to the turn itself
 * (CAN-1814 PR 6).
 *
 * Pure and dependency-free so both the decision to stop and the decision to
 * auto-resume are unit-testable without an Electron session, and so the same
 * rules cannot drift between the stop site and the resume site.
 */

/**
 * A dependency the user can actually act on.
 *
 * Gated on `recovery.kind`, NEVER on `failureClass` alone — that is the
 * load-bearing rule of this whole feature. `quota_exceeded`,
 * `provider_outage`, `network_error`, and `insufficient_scope` all describe a
 * real problem with no button attached; stopping the turn for one of them
 * strands the user in a dead transcript instead of letting the agent route
 * around it.
 *
 * `isValidAuthDependencyFailure` is re-checked here because a non-`none`
 * recovery paired with a non-recoverable class is a wire-invariant violation:
 * the renderer refuses to offer its action, so stopping the turn would leave
 * nothing to click.
 */
export function isRecoverableAuthFailure(
  failure: AuthDependencyFailure,
): boolean {
  return (
    failure.recovery.kind !== 'none' && isValidAuthDependencyFailure(failure)
  );
}

/**
 * Every actionable dependency carried by one `canopy_auth_failure` event,
 * deduplicated by `dependencyId` with first occurrence winning.
 *
 * Reads the `failures` array when present and always includes the singular
 * `failure`, which every reader understands — an event written before the
 * checklist shipped carries only that field.
 */
export function selectRecoverableAuthFailures(
  event: CanopyAuthFailureEventData,
): AuthDependencyFailure[] {
  const candidates: AuthDependencyFailure[] = [
    event.failure,
    ...(event.failures ?? []),
  ];
  const seen = new Set<string>();
  const out: AuthDependencyFailure[] = [];
  for (const candidate of candidates) {
    if (!isRecoverableAuthFailure(candidate)) continue;
    if (seen.has(candidate.dependencyId)) continue;
    seen.add(candidate.dependencyId);
    out.push(candidate);
  }
  return out;
}

/**
 * Should this event stop the turn?
 *
 * Yes exactly when at least one blocked dependency is recoverable. Observed
 * before this existed: an MCP call 401'd, the reconnect card rendered
 * correctly, and the agent then spent thirteen seconds theorising about a
 * resource-indicator mismatch and asked a question — while the fix was a
 * button rendered directly above its own output.
 */
export function shouldStopTurnForAuthFailure(
  event: CanopyAuthFailureEventData,
): boolean {
  return selectRecoverableAuthFailures(event).length > 0;
}

/**
 * Verbs that may OPEN an auto-resumable tool name.
 *
 * An exact match on the FIRST normalized token — not a prefix match, despite
 * what an earlier revision of this comment said. `parseMcpToolName` yields the
 * tool's own segment, `normalizeToolSegment` splits it on non-alphanumerics,
 * and only `tokens[0]` is compared, so `getting_started` does not match `get`
 * (CAN-1814 review).
 *
 * MCP servers name tools `verb_object` almost universally (`list_issues`,
 * `get_message`, `search_threads`), which is what makes the opening token
 * meaningful at all.
 */
export const AUTO_RESUME_READ_ONLY_TOOL_VERBS: readonly string[] = [
  'check',
  'count',
  'describe',
  'explain',
  'fetch',
  'find',
  'get',
  'inspect',
  'list',
  'lookup',
  'preview',
  'query',
  'read',
  // 'resolve' deliberately ABSENT. It reads as a lookup verb but real MCP
  // tools use it for mutations — Linear ships `resolve_diff_thread`, which
  // marks a review thread resolved. An ambiguous verb must fall through to
  // "needs an explicit retry": one extra click costs nothing, a duplicated
  // external write is unrecoverable (CAN-1814 review).
  'retrieve',
  'search',
  'show',
  'summarize',
  'view',
];

/**
 * Tokens that reveal a name describes MORE THAN ONE action, or an action the
 * opening verb alone does not name.
 *
 * THIS IS THE STRUCTURAL GUARD, and the reason this module is no longer just
 * "an allowlist plus a denylist" (CAN-1814 review). Removing `resolve` fixed
 * one instance; the class stayed open because a finite denylist of mutating
 * verbs was being asked to cover an unbounded space — `find_and_purge`,
 * `query_and_charge`, `fetch_and_confirm_order`, `read_and_ack`,
 * `search_then_terminate` and `check_in` all opened with an allowed read verb,
 * contained no denylisted token, and auto-resumed a mutation.
 *
 * The inversion that closes MOST of the class: a compound name usually has to
 * JOIN its actions, and the joiners are a CLOSED vocabulary. English offers a
 * handful of coordinating conjunctions and a handful of verb particles for
 * this, and no amount of new mutating verbs enlarges that set. So instead of
 * trying to enumerate what a tool might DO, this enumerates the few tokens that
 * prove the name is not a single read — and any name carrying one is refused
 * outright.
 *
 * "Most", not all. Two residues are NOT closed by this rule, and
 * {@link AUTO_RESUME_MUTATION_TOKENS} is the (admittedly unbounded) net under
 * both — which is why that denylist still earns its place:
 *
 *   1. JUXTAPOSITION with no joiner at all: `search_replace`, `find_purge`,
 *      `fetch_rotate_key`, `list_expire_tokens`.
 *   2. BARE GENERIC EXECUTORS: a single-token `query` or `preview` reads as a
 *      verb-only name and passes, but `query` is exactly how Postgres,
 *      BigQuery and Supabase MCP servers name their arbitrary-SQL tool, which
 *      can just as easily be an INSERT.
 *
 * Both are low impact here because the gated call is the one that just 401'd,
 * so it did nothing, and the genuinely dangerous vector — a cancelled SIBLING
 * write in the same batch — is covered separately by
 * `batchHasUnresolvedToolCalls`. Recorded so the closed-vocabulary framing is
 * not read as stronger than it is (CAN-1814 review).
 *
 *   - CONJUNCTIONS join two actions: `find_and_purge`, `get_or_create_page`.
 *   - PARTICLES turn a read verb into a different action with no conjunction to
 *     give it away: `check_in`, `check_out`, `read_back`.
 *
 * The cost is false NEGATIVES — `list_issues_and_projects` is a genuine read
 * that will not auto-resume. That is the correct direction: one extra click
 * against an unrecoverable duplicated external write.
 *
 * WHY NOT THE MCP `readOnlyHint` ANNOTATION, which would be authoritative:
 * it is not reachable here. Canopy's tool cache
 * (`McpServerToolsCacheEntry.tools`) stores advertised tool NAMES only, and the
 * pairing path this policy serves carries just the raw provider tool name off a
 * streamed `tool_use` block. Consuming the hint means persisting annotations
 * through `tool-discovery.ts` and versioning that cache, it would still be
 * absent for every server that does not publish it, and the MCP spec itself
 * calls the annotation untrusted advisory metadata. Worth doing as its own
 * change; not something to fake here.
 */
export const AUTO_RESUME_COMPOUND_MARKER_TOKENS: readonly string[] = [
  // Coordinating conjunctions and sequencers.
  'and',
  'or',
  'then',
  'plus',
  // Verb particles.
  'away',
  'back',
  'down',
  'in',
  'off',
  'out',
  'up',
];

/**
 * Tokens that mean the call may have changed something outside Canopy.
 *
 * DEFENCE IN DEPTH, not the primary guard — see
 * {@link AUTO_RESUME_COMPOUND_MARKER_TOKENS} for why an enumeration of mutating
 * verbs cannot be the primary guard. This list still earns its place because
 * two verbs can be juxtaposed with no conjunction at all (`search_replace`,
 * `find_purge`), which the structural rule cannot see.
 *
 * Scanned over the WHOLE normalized segment and the denylist WINS, so
 * `get_and_delete_record` and `search_and_replace` are not auto-resumed even
 * though they open with a read verb.
 */
export const AUTO_RESUME_MUTATION_TOKENS: readonly string[] = [
  'ack',
  'acknowledge',
  'add',
  'apply',
  'approve',
  'archive',
  'assign',
  'cancel',
  'charge',
  'claim',
  'clear',
  'close',
  'commit',
  'confirm',
  'create',
  'delete',
  'deploy',
  'dismiss',
  'draft',
  'duplicate',
  'edit',
  'escalate',
  'execute',
  'export',
  'forward',
  'grant',
  'import',
  'install',
  'invite',
  'label',
  'mark',
  'merge',
  'move',
  'patch',
  'pay',
  'post',
  'promote',
  'provision',
  'publish',
  'purchase',
  'purge',
  'put',
  'react',
  'refund',
  'remove',
  'rename',
  'reply',
  'replace',
  'reset',
  'restore',
  'revert',
  'revoke',
  'run',
  'save',
  'schedule',
  'send',
  'set',
  'share',
  'start',
  'stop',
  'submit',
  'sync',
  'terminate',
  'transfer',
  'trash',
  'trigger',
  'uninstall',
  'unlabel',
  'unlink',
  'unshare',
  'update',
  'upload',
  'write',
];

function normalizeToolSegment(tool: string): string[] {
  return tool
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * May a turn interrupted on this tool call be resumed without asking?
 *
 * Only MCP tool names are considered, because only an MCP tool result can
 * carry a mid-turn `mcp` auth failure (a provider-level failure ends the turn
 * terminally on its own). Anything unrecognized — a provider built-in, a
 * server that names tools in prose, a missing name because the stream was
 * truncated — is NOT safe, and the user gets an explicit retry instead.
 */
export function isAutoResumeSafeToolName(
  rawToolName: string | undefined,
): boolean {
  if (rawToolName === undefined) return false;
  const parsed = parseMcpToolName(rawToolName);
  if (parsed === null) return false;
  const tokens = normalizeToolSegment(parsed.tool);
  const first = tokens[0];
  if (first === undefined) return false;
  // The name must describe exactly ONE action, and that action must be a read.
  // Both halves are required: the opening verb bounds a single-action name to a
  // known-read vocabulary, and the compound markers reject every name that
  // joins a second action onto it (CAN-1814 review).
  if (!AUTO_RESUME_READ_ONLY_TOOL_VERBS.includes(first)) return false;
  if (
    tokens.some((token) => AUTO_RESUME_COMPOUND_MARKER_TOKENS.includes(token))
  ) {
    return false;
  }
  return !tokens.some((token) => AUTO_RESUME_MUTATION_TOKENS.includes(token));
}

/**
 * Is a human sitting in front of this turn right now?
 *
 * Only these sources may auto-resume: the recovery that precedes a resume is
 * an interactive browser login, and it stays user-initiated. `portal` and
 * `unknown` are excluded deliberately — a Portal turn's user is on another
 * device and cannot complete a desktop-local OAuth leg, so treating it as
 * foreground would auto-redrive a turn nobody recovered.
 */
export function isForegroundInitiationSource(
  source: UsageInitiationSource | undefined,
): boolean {
  return source === undefined || source === 'user' || source === 'app_advisor';
}

/**
 * Is this turn being driven by something with no user attached?
 *
 * These get an actionable OS notification instead of a silent stall, and must
 * never trigger an interactive login on their own — CAN-492 is the ticket
 * where setup scripts opened surprise browser logins.
 *
 * Not simply `!isForegroundInitiationSource`: `portal` and `unknown` are
 * neither foreground nor a sensible target for a local desktop notification.
 */
export function isBackgroundInitiationSource(
  source: UsageInitiationSource | undefined,
): boolean {
  return source === 'hook' || source === 'automation';
}
