// Runtime injection seeder for an approval that main resolved WITHOUT a click,
// because the user widened the chat's approval mode while the card was on
// screen (CAN-3083).
//
// Sibling of `injectApprovalRequestEvent.mjs`: it injects state into an
// ALREADY-RUNNING app by emitting the same IPC event the main process sends
// after `reevaluatePendingApprovalsForChat` re-runs the policy under the new
// mode and settles a standing request as approved.
//
// Source of truth for the channel + shape:
//   - Channel constant: `packages/desktop-shared/src/types.ts`
//     `approvalAutoResolved: 'approval:auto-resolved'`. Deliberately NOT
//     `approval:cancelled`, which additionally means the tool was denied.
//   - Preload: `apps/desktop-app/src/preload/index.ts` `onAutoResolved`
//     validates the payload before forwarding it as an
//     `ApprovalAutoResolvedEvent`. A payload that fails that validator is
//     dropped silently, so a seeded event with a missing/misspelled field
//     produces a test that fails with "the card never cleared" rather than an
//     error — keep the shape below in sync with `isApprovalAutoResolvedEvent`.
//   - Subscription: `apps/desktop-app/src/renderer/src/hooks/
//     useChatEventSubscriptions.ts` routes it to the chat store's
//     `handleApprovalAutoResolved` (`stores/chat/slices/approvals.ts`), which
//     drops the `pendingApprovals` entry, resumes the `turn_timer` this
//     approval was holding paused, and grafts `resolutionMessage` if present.
//   - Payload type: `ApprovalAutoResolvedEvent` in
//     `packages/desktop-shared/src/types.ts`.
//
// SCOPE, stated plainly: this proves ONLY the renderer half. Exactly as the
// sibling seeder documents, a synthetically-injected `approval:request` has no
// main-process `createPendingApproval` registration behind it, so the real
// main-side path (widen the mode -> re-evaluate the pending check -> resolve
// the bridge promise -> commit the transcript block -> emit this event) can
// never fire for a synthetic prompt. The main half is covered by
// `main/__tests__/approval-service.test.ts` and
// `main/__tests__/approval-session-registry.test.ts`; this seeder covers
// "given main said it happened, the UI does the right thing."
//
// Consequently: `resolutionMessage` here is a fixture the seeder supplies, not
// something main minted. Do not write assertions expecting the message to
// survive a reload — persistence is main-owned and no main-side commit
// occurred.

const APPROVAL_AUTO_RESOLVED_CHANNEL = 'approval:auto-resolved';

/**
 * Inject an `approval:auto-resolved` event into an already-running app.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types').ApprovalAutoResolvedEvent} event
 * @returns {Promise<void>}
 */
export async function injectApprovalAutoResolvedEvent(electronApp, event) {
  if (!electronApp) {
    throw new Error('injectApprovalAutoResolvedEvent requires an electronApp');
  }
  if (!event || typeof event !== 'object') {
    throw new Error(
      'injectApprovalAutoResolvedEvent requires an ApprovalAutoResolvedEvent payload',
    );
  }
  for (const field of [
    'requestId',
    'projectId',
    'worktreeId',
    'chatId',
    'mode',
  ]) {
    if (typeof event[field] !== 'string' || !event[field]) {
      throw new Error(
        `injectApprovalAutoResolvedEvent payload requires ${field}`,
      );
    }
  }
  if (event.reason !== 'mode-change') {
    throw new Error(
      "injectApprovalAutoResolvedEvent payload requires reason: 'mode-change'",
    );
  }

  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error(
          'No BrowserWindow available to receive the approval auto-resolved event',
        );
      }
      windows[0].webContents.send(channel, payload);
    },
    { channel: APPROVAL_AUTO_RESOLVED_CHANNEL, payload: event },
  );
}
