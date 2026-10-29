// Runtime injection seeder for live pipeline STEP-OUTPUT events (Phase 01 —
// pipeline workspace panels test harness / baseline-recheck "Harness gaps to
// build first").
//
// Like `injectScriptRunEvent.mjs` / `injectPipelineExecutionEvent.mjs`, this
// injects state into an ALREADY-RUNNING app by emitting the same IPC event the
// main process broadcasts for live pipeline step output, so a step log
// interest in the renderer's `stores/pipelineStepLogStore.ts` receives output
// without a real spawned process.
//
// Source of truth for the channel + shape:
//   - Channel constant: `packages/desktop-shared/src/constants/ipc-channels.ts`
//     `PIPELINE_CHANNELS.STEP_OUTPUT_EVENT = 'pipelines:step-output-event'`.
//   - Payload type: `StepOutputEvent` in
//     `packages/desktop-shared/src/types/pipeline.ts` (~1571):
//     `{ executionId, jobId, jobName, stepId, stepName, attempt, iteration?,
//        recovery?, stream: 'stdout' | 'stderr', data }`.
//   - Broadcaster: `emitStepOutputEvent` in
//     `apps/desktop-app/src/main/pipelines/pipeline-handlers.ts` (also the
//     resume path in `pipeline-resume-service.ts`), both calling
//     `sendToAllWindows(PIPELINE_CHANNELS.STEP_OUTPUT_EVENT, event)`
//     (`apps/desktop-app/src/main/lib/window-send.ts`) — i.e. EVERY open
//     `BrowserWindow`, not just the main one. This seeder mirrors that fan-out.
//   - Preload: `apps/desktop-app/src/preload/api/pipelines-api.ts` ->
//     `onStepOutput` forwards the raw event.
//   - Subscription: the renderer's single, always-mounted bridge
//     (`apps/desktop-app/src/renderer/src/hooks/usePipelineRunsBridge.ts`)
//     batches frames via `requestAnimationFrame` into
//     `stores/pipelineStepLogStore.ts` `routeStepOutputEvents`.
//   - Join: each log interest joins its persisted snapshot with live events
//     through `apps/desktop-app/src/renderer/src/lib/pipelineRunOutput.ts`.
//     Injected events carry no `logPosition`, so they take the unpositioned
//     path: `appendStepOutputEvents` (a per-`stream` remainder holds a chunk
//     that splits a line mid-token across two events) and
//     `mergeStepOutputLines` (persisted-vs-live textual overlap of up to 5
//     lines — pass content that does not textually collide with any seeded
//     persisted log lines to keep assertions unambiguous).
//
// CRITICAL PRECONDITION: output is kept only for a registered step log
// interest, keyed by the exact identity (execution, job, step, attempt,
// iteration, recovery). A mounted step detail (`PipelineStepDetail`, or the
// inline accordion's step detail) registers one. An injected event with no
// matching interest is dropped on arrival, whatever worktree is selected, and
// is not replayed when a detail opens later (the detail reads the persisted
// log instead). A spec MUST have the step's detail open before injecting.
// When the step later reaches a terminal state, the detail re-reads the
// persisted log once, so injected lines that were never persisted disappear
// then; assert them before injecting a terminal transition.

const STEP_OUTPUT_EVENT_CHANNEL = 'pipelines:step-output-event';

/**
 * Send one `StepOutputEvent` to every open `BrowserWindow`, exactly the way
 * the production broadcaster (`sendToAllWindows`) fans a live event out to the
 * main window and any popped-out auxiliary window.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {object} event
 * @param {string} event.executionId
 * @param {string} event.jobId
 * @param {string} [event.jobName] defaults to `jobId`.
 * @param {string} event.stepId
 * @param {string} [event.stepName] defaults to `stepId`.
 * @param {number} [event.attempt] defaults to `0`.
 * @param {number} [event.iteration] omitted from the sent event when not
 *   provided (matches the optional `StepOutputEvent['iteration']` field).
 * @param {number} [event.recovery] omitted from the sent event when not
 *   provided (matches the optional `StepOutputEvent['recovery']` field).
 * @param {'stdout' | 'stderr'} [event.stream] defaults to `'stdout'`.
 * @param {string} event.data raw chunk text. May split a line mid-token (the
 *   renderer's per-stream remainder buffer reassembles it across events fed
 *   through {@link injectPipelineStepOutputChunks}).
 * @returns {Promise<import('@canopy/desktop-shared/types/pipeline').StepOutputEvent>}
 *   the fully-populated event that was sent.
 */
export async function injectPipelineStepOutputEvent(electronApp, event) {
  if (!electronApp) {
    throw new Error('injectPipelineStepOutputEvent requires an electronApp');
  }
  if (!event || typeof event !== 'object') {
    throw new Error('injectPipelineStepOutputEvent requires an event object');
  }
  const { executionId, jobId, stepId, data } = event;
  if (
    typeof executionId !== 'string' ||
    typeof jobId !== 'string' ||
    typeof stepId !== 'string'
  ) {
    throw new Error(
      'injectPipelineStepOutputEvent requires string executionId, jobId, and stepId',
    );
  }
  if (typeof data !== 'string') {
    throw new Error(
      'injectPipelineStepOutputEvent requires a string data chunk',
    );
  }

  /** @type {import('@canopy/desktop-shared/types/pipeline').StepOutputEvent} */
  const fullEvent = {
    executionId,
    jobId,
    jobName: event.jobName ?? jobId,
    stepId,
    stepName: event.stepName ?? stepId,
    attempt: event.attempt ?? 0,
    ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
    ...(event.recovery !== undefined ? { recovery: event.recovery } : {}),
    stream: event.stream ?? 'stdout',
    data,
  };

  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error(
          'No BrowserWindow available to receive the pipeline step output event',
        );
      }
      for (const window of windows) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
          continue;
        }
        window.webContents.send(payload.channel, payload.event);
      }
    },
    { channel: STEP_OUTPUT_EVENT_CHANNEL, event: fullEvent },
  );

  return fullEvent;
}

/**
 * Convenience: inject several ordered `data` chunks for the SAME step,
 * sequentially, so a chunk that splits a line mid-token (e.g. `'alpha-1\nalph'`
 * followed by `'a-2\n'`) reassembles into whole lines through the renderer's
 * per-stream remainder buffer (`appendStepOutputEvents` in
 * `pipelineRunOutput.ts`) exactly as it would from a real process writing to
 * the same stream.
 *
 * Chunks are awaited one at a time (never `Promise.all`) so IPC delivery order
 * matches call order — required for the remainder-buffer reassembly to
 * produce the expected, non-interleaved lines.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {object} base shared event fields for every chunk — everything
 *   {@link injectPipelineStepOutputEvent} accepts except `data` (so at least
 *   `executionId`, `jobId`, and `stepId`; `stream` defaults to `'stdout'`).
 * @param {string[]} chunks ordered raw chunk strings sent on `base.stream`.
 * @returns {Promise<import('@canopy/desktop-shared/types/pipeline').StepOutputEvent[]>}
 *   the fully-populated events that were sent, in send order.
 */
export async function injectPipelineStepOutputChunks(
  electronApp,
  base,
  chunks,
) {
  if (!base || typeof base !== 'object') {
    throw new Error(
      'injectPipelineStepOutputChunks requires a base event object',
    );
  }
  if (!Array.isArray(chunks)) {
    throw new Error('injectPipelineStepOutputChunks requires a chunks array');
  }

  const sent = [];
  for (const data of chunks) {
    const event = await injectPipelineStepOutputEvent(electronApp, {
      ...base,
      data,
    });
    sent.push(event);
  }
  return sent;
}
