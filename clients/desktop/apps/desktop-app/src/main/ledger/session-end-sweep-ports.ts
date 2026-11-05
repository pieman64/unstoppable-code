/*
 * Host-facing, data-only session-end ports. This module intentionally has no
 * imports from delegation, pipelines, or the Ledger service: lifecycle hosts
 * can register here before the Ledger's operation handlers have loaded.
 */

export type LedgerSessionEndActor = {
  readonly kind: 'chat' | 'managed_delegation' | 'pipeline_agent';
  readonly originKey: string;
};

export type LedgerSessionEndTransition = {
  readonly target: { readonly projectId: string; readonly worktreeId: string };
  readonly actor: LedgerSessionEndActor;
  readonly recipient: { readonly kind: 'user' } | LedgerSessionEndActor;
  readonly reason:
    | 'delegate_settled'
    | 'pipeline_step_finished'
    | 'chat_archived';
  readonly transitionKey: string;
  readonly transitionAt: string;
  readonly runGeneration?: number;
};

export type LedgerSessionEndSink = (
  transition: LedgerSessionEndTransition,
) => Promise<'recorded' | 'not_needed' | 'failed'>;

export type LedgerDelegateSweepAdmission = (
  target: { readonly projectId: string; readonly worktreeId: string },
  delegationId: string,
  runGeneration: number,
  apply: (signal: AbortSignal) => Promise<void>,
) => Promise<'applied' | 'superseded' | 'unknown'>;

type LedgerDelegateGenerationSource = (
  target: { readonly projectId: string; readonly worktreeId: string },
  delegationId: string,
) => Promise<number | null | 'gone'>;

let registeredSink: LedgerSessionEndSink | undefined;
let registeredGenerationSource: LedgerDelegateGenerationSource | undefined;
let registeredAdmission: LedgerDelegateSweepAdmission | undefined;

export function registerLedgerSessionEndSink(
  sink: LedgerSessionEndSink | undefined,
): void {
  registeredSink = sink;
}

/** Awaits only the durable intent write; the sink must schedule replay itself. */
export async function notifyLedgerSessionEnded(
  transition: LedgerSessionEndTransition,
): Promise<'recorded' | 'not_needed' | 'failed'> {
  const sink = registeredSink;
  if (sink === undefined) return 'failed';
  try {
    return await sink(transition);
  } catch {
    return 'failed';
  }
}

export function registerLedgerDelegateGenerationSource(
  source: LedgerDelegateGenerationSource | undefined,
): void {
  registeredGenerationSource = source;
}

export async function readLedgerDelegateGeneration(
  target: { readonly projectId: string; readonly worktreeId: string },
  delegationId: string,
): Promise<number | null | 'gone'> {
  const source = registeredGenerationSource;
  if (source === undefined) return null;
  try {
    return await source(target, delegationId);
  } catch {
    return null;
  }
}

export function registerLedgerDelegateSweepAdmission(
  source: LedgerDelegateSweepAdmission | undefined,
): void {
  registeredAdmission = source;
}

export async function withLedgerDelegateSweepAdmission(
  target: { readonly projectId: string; readonly worktreeId: string },
  delegationId: string,
  runGeneration: number,
  apply: (signal: AbortSignal) => Promise<void>,
): Promise<'applied' | 'superseded' | 'unknown'> {
  const source = registeredAdmission;
  if (source === undefined) return 'unknown';
  try {
    return await source(target, delegationId, runGeneration, apply);
  } catch {
    return 'unknown';
  }
}

/** Whether a chat is archived now; `null` when that can't be read. */
type LedgerChatArchivedSource = (
  target: { readonly projectId: string; readonly worktreeId: string },
  chatId: string,
) => Promise<boolean | null>;

let registeredChatArchived: LedgerChatArchivedSource | undefined;

export function registerLedgerChatArchivedSource(
  source: LedgerChatArchivedSource | undefined,
): void {
  registeredChatArchived = source;
}

export async function readLedgerChatArchived(
  target: { readonly projectId: string; readonly worktreeId: string },
  chatId: string,
): Promise<boolean | null> {
  const source = registeredChatArchived;
  if (source === undefined) return null;
  try {
    return await source(target, chatId);
  } catch {
    return null;
  }
}
