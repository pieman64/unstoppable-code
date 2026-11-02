/**
 * The terminal outcome recorded for one Codex turn.
 *
 * This is intentionally local to the main-process provider/session boundary;
 * it is a short-lived handoff signal, not a persisted transcript contract.
 */
export interface CodexTurnTerminalEvidence {
  turnUserMessageId?: string;
  outcome: 'completed' | 'failed' | 'interrupted';
  endedAtMs: number;
}

export interface CodexTurnEvidence {
  holdsTurn: boolean;
  terminal?: CodexTurnTerminalEvidence;
}

interface SessionTurnEvidence extends CodexTurnEvidence {
  activeTurnUserMessageId?: string;
  terminalObserved?: boolean;
}

const evidenceBySessionKey = new Map<string, SessionTurnEvidence>();

/** Mark that Codex has taken the message and is holding its session turn. */
export function beginCodexSessionTurn(
  key: string,
  turnUserMessageId?: string,
): void {
  // Replacing the entry clears a previous terminal while preserving the new
  // turn's hold. A late observer for the old turn cannot release this hold.
  evidenceBySessionKey.set(key, {
    holdsTurn: true,
    ...(turnUserMessageId !== undefined
      ? { activeTurnUserMessageId: turnUserMessageId }
      : {}),
  });
}

/** Release Codex's hold after its terminal has been handed to the event route. */
export function finishCodexSessionTurn(
  key: string,
  turnUserMessageId?: string,
): void {
  const evidence = evidenceBySessionKey.get(key);
  if (!evidence?.holdsTurn) return;
  if (
    turnUserMessageId !== undefined &&
    evidence.activeTurnUserMessageId !== turnUserMessageId
  ) {
    return;
  }

  evidence.holdsTurn = false;
  if (!evidence.terminal && !evidence.terminalObserved) {
    evidenceBySessionKey.delete(key);
  }
}

/** Record an authoritative end without tying it to a client/session lifetime. */
export function recordCodexTurnEnd(
  key: string,
  terminal: CodexTurnTerminalEvidence,
): void {
  const evidence = evidenceBySessionKey.get(key) ?? { holdsTurn: false };
  // Once the queue has acknowledged this turn's end, later synthetic results
  // from the same handoff must not resurrect evidence that was consumed.
  if (evidence.terminalObserved) return;
  if (
    evidence.holdsTurn &&
    evidence.activeTurnUserMessageId !== undefined &&
    terminal.turnUserMessageId !== undefined &&
    evidence.activeTurnUserMessageId !== terminal.turnUserMessageId
  ) {
    return;
  }

  if (evidence.terminal) {
    // The first terminal for a turn is authoritative. In particular, a route
    // ingestion/admission failure must not rewrite a confirmed completion as
    // a synthetic failure while the handoff is unwinding.
    return;
  }

  evidence.terminal = { ...terminal };
  evidenceBySessionKey.set(key, evidence);
}

/** Read a snapshot; callers cannot mutate the retained handoff evidence. */
export function getCodexTurnEvidence(key: string): CodexTurnEvidence {
  const evidence = evidenceBySessionKey.get(key);
  if (!evidence) return { holdsTurn: false };
  return {
    holdsTurn: evidence.holdsTurn,
    ...(evidence.terminal ? { terminal: { ...evidence.terminal } } : {}),
  };
}

/** Clear only the terminal observed by the queue, never a newer turn's hold. */
export function observeCodexTurnTerminal(
  key: string,
  turnUserMessageId?: string,
): void {
  const evidence = evidenceBySessionKey.get(key);
  if (
    !evidence?.terminal ||
    evidence.terminal.turnUserMessageId !== turnUserMessageId
  ) {
    return;
  }

  delete evidence.terminal;
  // Retain one small consumed-end tombstone per chat until its next turn
  // starts. A failed terminal admission can unwind after finish and attempt
  // to record a synthetic failure; this guard prevents it restoring an end
  // the queue already observed.
  evidence.terminalObserved = true;
}
