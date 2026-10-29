import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';

/**
 * Thrown by `assertTurnAuthDependencies` when a turn's required dependencies
 * are already known-unauthenticated.
 *
 * Carries the same `AuthDependencyFailure` values `AuthRecoveryCard` renders
 * mid-turn, so a refused send names the dependency and its recovery rather than
 * introducing a second, parallel explanation of the same problem.
 *
 * REACHING THE RENDERER (CAN-1814 PR 7). `ipcRenderer.invoke` rejects with a
 * string, so throwing this across the send IPC would drop {@link failures} and
 * leave the user with a sentence naming the dependency and no way to reconnect
 * it. The send IPC therefore translates this error into the typed
 * `ChatSendMessageResult.refusedAuthDependencies` via
 * `describeTurnAuthRefusal` rather than string-encoding the payload into the
 * message — a second wire encoding for the same failure is exactly what
 * reusing `AuthDependencyFailure` avoids.
 *
 * The error itself stays a throw, because the OTHER callers of
 * `assertTurnAuthDependencies` are not IPC handlers: `sendWorktreeChatMessage`
 * serves Portal, automations, and resume flows, whose contract is a rejected
 * promise. Only the boundary that can carry a result translates.
 *
 * LEAF MODULE ON PURPOSE. `chat-queue-service.ts` needs to tell a refusal apart
 * from every other dispatch failure, but `auth-preflight.ts` reaches the
 * encrypted OAuth token store, the plugin resolver, and the preferences store.
 * Importing it from the queue would pull all of that into a module that owns
 * none of it — the same reason `isChatScopeDeletingError` lives in its own leaf.
 */
export class TurnAuthPreflightBlockedError extends Error {
  public readonly failures: readonly AuthDependencyFailure[];

  public constructor(failures: readonly AuthDependencyFailure[]) {
    super(buildBlockedMessage(failures));
    this.name = 'TurnAuthPreflightBlockedError';
    this.failures = failures;
  }
}

function buildBlockedMessage(
  failures: readonly AuthDependencyFailure[],
): string {
  const names = failures.map((failure) => failure.displayName);
  const subject =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? 'needs' : 'need';
  return `${subject} ${verb} to be reconnected before this message can run.`;
}

/**
 * Did this error come from the send-time auth preflight?
 *
 * Narrow on purpose. The one caller uses it to RESTORE a queued row that the
 * refusal never dispatched, and restoring a row whose provider dispatch may
 * have partially run would re-send it. Only a preflight refusal is provably
 * pre-dispatch: it runs before `ensureChatForTrustedSend`, before the user
 * message is persisted, and before the session is created.
 */
export function isTurnAuthPreflightRefusal(error: unknown): boolean {
  return error instanceof TurnAuthPreflightBlockedError;
}
