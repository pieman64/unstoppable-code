// Runtime injection seeder for a live tool-approval prompt arriving mid-chat.
//
// Like `injectChatEvent` / `injectCodeGraphBuildStatusEvent`, this injects
// state into an ALREADY-RUNNING app by emitting the same IPC event the main
// process sends when a real approval-service session needs a decision
// (`apps/desktop-app/src/main/approvals/prompt-bridge.ts`
// `requestApprovalFromRenderer`), so the renderer's pending-approval handling
// (card render + `pauseOpenTurnTimer`) is exercised without a real agent
// turn/tool-call in flight.
//
// Source of truth for the channel + shape:
//   - Channel constant: `packages/desktop-shared/src/types.ts`
//     `approvalRequest: 'approval:request'`.
//   - Preload: `apps/desktop-app/src/preload/index.ts` `onRequest` forwards
//     the raw payload as an `ApprovalRequestEvent`.
//   - Subscription: `apps/desktop-app/src/renderer/src/hooks/
//     useChatEventSubscriptions.ts` routes it to the chat store's
//     `handleApprovalRequest` (`stores/chat/slices/approvals.ts`), which
//     pauses any open `turn_timer` block for the chat and adds the event to
//     `state.pendingApprovals`.
//   - Payload type: `ApprovalRequestEvent` in
//     `packages/desktop-shared/src/types.ts`.
//
// IMPORTANT precondition proven empirically while building this seeder: the
// renderer's restore path (`restoreStreamingTabs` in
// `stores/chat/session-restore.ts`) stamps a synthetic 'Cancelled'
// `tool_result` onto any `tool_use` block left open in seeded persisted state
// UNLESS the chat also has an unanswered `pendingQuestions` or
// `pendingApprovals` entry at launch (the two "preserve on restore" branches).
// A test that wants to inject a LIVE approval alongside a still-open
// `tool_use` block / running turn timer (rather than pre-seeding
// `pendingApprovals` directly) must seed a matching unanswered
// `pendingQuestions` entry for that chat purely as a restore-preservation
// anchor — otherwise the block and timer are closed before the app finishes
// loading. (The approval dock itself renders from `pendingApprovals` state
// and needs no transcript block; the anchor only keeps the transcript/timer
// state honest.) See `tool-approval-interactions.spec.mjs`'s turn-timer test
// for the concrete pattern.
//
// ALSO proven empirically: `window.api.approvals.respond` cannot be
// monkey-patched from a spec (Electron's `contextBridge.exposeInMainWorld`
// deep-freezes the exposed `api` object), and there is no main-process
// `createPendingApproval` entry registered for a synthetically-injected
// `requestId` (that registration only happens inside a real
// `createApprovalSession(...).check(...)` call from a live agent tool-call).
// So responding to an injected approval clears the card client-side but
// never persists a rule to disk — do not write assertions that expect
// `approvals.json` / `preferences.json` / `sessionApprovalRules` to change
// as a result of responding to an injected (or seeded-pending) approval.

const APPROVAL_REQUEST_CHANNEL = 'approval:request';

/**
 * Inject an `approval:request` event into an already-running app.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types').ApprovalRequestEvent} event
 * @returns {Promise<void>}
 */
export async function injectApprovalRequestEvent(electronApp, event) {
  if (!electronApp) {
    throw new Error('injectApprovalRequestEvent requires an electronApp');
  }
  if (!event || typeof event !== 'object') {
    throw new Error(
      'injectApprovalRequestEvent requires an ApprovalRequestEvent payload',
    );
  }
  if (typeof event.requestId !== 'string' || !event.requestId) {
    throw new Error('injectApprovalRequestEvent payload requires requestId');
  }

  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error(
          'No BrowserWindow available to receive the approval request event',
        );
      }
      windows[0].webContents.send(channel, payload);
    },
    { channel: APPROVAL_REQUEST_CHANNEL, payload: event },
  );
}
