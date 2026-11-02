import {
  hasToolName,
  driveParentWatchFlow,
} from './delegation-capabilities/helpers.mjs';

/** One spawn, one child Read, then settlement. Never batch calls. */
export function createStreamSmokeScript() {
  let spawned = false;
  let read = false;
  let sequence = 0;
  const withIds = (response) => {
    if (response?.step?.toolCalls) {
      if (response.step.toolCalls.length !== 1)
        throw new Error('Stream smoke cannot batch tools');
      response.step.toolCalls = response.step.toolCalls.map((call) => ({
        ...call,
        id: `stream-smoke-tool-${++sequence}`,
      }));
    }
    return response;
  };
  return async (ctx) => {
    if (ctx.role === 'parent') {
      if (
        !spawned &&
        !ctx.results &&
        hasToolName(ctx.item.toolNames, ctx.spawnTool)
      ) {
        spawned = true;
        return withIds(
          ctx.reply({
            toolCalls: [{ name: ctx.spawnTool, input: ctx.spawnInput }],
            stopReason: 'tool_use',
          }),
        );
      }
      const watch = driveParentWatchFlow(ctx);
      if (watch) return withIds(watch);
      // Avoid the built-in parent's tool-producing fallbacks after spawn.
      if (spawned)
        return ctx.reply({
          text: ctx.context.includes(ctx.finding)
            ? ctx.integrated
            : 'Waiting for the delegated task to settle.',
          stopReason: 'end_turn',
        });
    }
    if (ctx.role === 'child') {
      if (!read) {
        read = true;
        return withIds(
          ctx.reply({
            text: 'Inspecting the stream smoke evidence.',
            toolCalls: [ctx.nativeRead('delegation-evidence.txt')],
            stopReason: 'tool_use',
          }),
        );
      }
      return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
    }
    return undefined;
  };
}

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const PRIMARY_STAGES = ['stored', 'inline', 'final'];

/**
 * A primary-only turn, no delegate: a stored Read, an inline Read, then the
 * answer. Each parent request waits until the test releases its stage, so
 * each result commits while the chat is mounted and the turn is still open.
 */
export function createPrimaryLiveOutputScript({ storedPath, inlinePath }) {
  const reached = Object.fromEntries(PRIMARY_STAGES.map((s) => [s, barrier()]));
  const released = Object.fromEntries(
    PRIMARY_STAGES.map((s) => [s, barrier()]),
  );
  const script = async (ctx) => {
    if (ctx.role !== 'parent' || !hasToolName(ctx.item.toolNames, 'Read'))
      return undefined;
    // The stage follows the conversation, so a retried request repeats it.
    const stage = PRIMARY_STAGES[Math.min(ctx.resultEntries.length, 2)];
    reached[stage].release();
    await released[stage].promise;
    if (stage === 'final')
      return ctx.reply({ text: ctx.integrated, stopReason: 'end_turn' });
    const file = stage === 'stored' ? storedPath : inlinePath;
    const call = ctx.nativeRead(file);
    return ctx.reply({
      text: `Reading the ${stage} evidence.`,
      toolCalls: [{ ...call, id: `primary-live-${stage}` }],
      stopReason: 'tool_use',
    });
  };
  return {
    script,
    /** Resolves once the stage's request is held. */
    waitForHeld: (stage) => reached[stage].promise,
    release: (stage) => released[stage].release(),
    releaseAll: () => PRIMARY_STAGES.forEach((s) => released[s].release()),
  };
}
