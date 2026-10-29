import type {
  ChatSendMessageRequest,
  ShowFilesChatOrigin,
  ShowFilesPresentation,
  ShowFilesPresentationReason,
  UsageInitiationSource,
} from '@canopy/desktop-shared/types';

interface TurnOrigin {
  turnId: string;
  source?: UsageInitiationSource;
}

const turns = new Map<string, TurnOrigin>();
// Terminal relaunch tears down an old runtime before the accepted scheduled
// prompt runs. Keep its admission separate so old-runtime cleanup cannot erase it.
const terminalAdmissions = new Map<string, TurnOrigin[]>();

export function stageTerminalPresentationTurn(
  key: string,
  turnId: string,
  source: UsageInitiationSource,
): void {
  const queued = terminalAdmissions.get(key) ?? [];
  if (!queued.some((turn) => turn.turnId === turnId))
    queued.push({ turnId, source });
  terminalAdmissions.set(key, queued);
}

export function cancelTerminalPresentationTurn(
  key: string,
  turnId: string,
): void {
  const remaining =
    terminalAdmissions.get(key)?.filter((turn) => turn.turnId !== turnId) ?? [];
  if (remaining.length) terminalAdmissions.set(key, remaining);
  else terminalAdmissions.delete(key);
}

export function acceptTerminalPresentationTurn(
  key: string,
  turnId: string,
  fallbackSource: UsageInitiationSource = 'user',
): Readonly<TurnOrigin> {
  const queue = terminalAdmissions.get(key);
  const index = queue?.findIndex((turn) => turn.turnId === turnId) ?? -1;
  const turn = (index >= 0 ? queue?.splice(index, 1)[0] : undefined) ?? {
    turnId,
    source: fallbackSource,
  };
  if (!queue?.length) terminalAdmissions.delete(key);
  turns.set(key, turn);
  return turn;
}

export function forgetPresentationChat(key: string): void {
  turns.delete(key);
  terminalAdmissions.delete(key);
}

export function presentationChatKey(origin: ShowFilesChatOrigin): string {
  return `${origin.projectId}/${origin.worktreeId}/${origin.chatTabId}`;
}

/** Called only by trusted send/lifecycle code, never from tool arguments. */
export function recordPresentationTurn(
  key: string,
  turnId: string,
  source: UsageInitiationSource | undefined,
): void {
  turns.set(key, { turnId, source });
}

export function clearPresentationTurn(key: string, turnId?: string): void {
  if (turnId === undefined || turns.get(key)?.turnId === turnId)
    turns.delete(key);
}

export function capturePresentationTurn(
  origin: ShowFilesChatOrigin,
): Readonly<TurnOrigin> | undefined {
  return turns.get(presentationChatKey(origin));
}

/** Host-owned request markers also identify legacy scheduled requests without a source field. */
export function resolvePresentationSource(
  request: Pick<
    ChatSendMessageRequest,
    'initiationSource' | 'automationName' | 'watcherFired'
  >,
  foreground: UsageInitiationSource,
): UsageInitiationSource {
  return (
    request.initiationSource ??
    (request.automationName !== undefined || request.watcherFired !== undefined
      ? 'automation'
      : foreground)
  );
}

export function showFilesPresentationPolicy(input: {
  intent: 'user' | 'agent';
  source?: UsageInitiationSource;
  handoffId?: string;
}): {
  presentation: ShowFilesPresentation;
  reason?: ShowFilesPresentationReason;
  handoffId?: string;
} {
  if (input.intent === 'user') return { presentation: 'foreground' };
  if (input.source === 'automation' || input.source === 'hook')
    return { presentation: 'deferred', reason: 'automation_turn' };
  if (input.source === undefined)
    return { presentation: 'deferred', reason: 'unknown_turn' };
  if (input.handoffId)
    return {
      presentation: 'background',
      reason: 'browser_handoff',
      handoffId: input.handoffId,
    };
  return { presentation: 'foreground' };
}
