const REFUSED_REPLY = 'The delegate start was refused; no child was started.';

/**
 * Script only the deterministic inference around a real managed-delegation
 * tool call. The desktop still executes the advertised spawn tool, broker,
 * policy check, and refusal path through production code.
 */
export function createLifetimeLimitProviderScript() {
  let spawnAttemptCount = 0;
  let spawnWasAttempted = false;

  const run = (ctx) => {
    if (ctx.role === 'child')
      return ctx.reply({ text: REFUSED_REPLY, stopReason: 'end_turn' });
    if (ctx.role !== 'parent') return undefined;
    if (!ctx.item.toolNames.includes(ctx.spawnTool)) return undefined;
    if (ctx.results || spawnWasAttempted)
      return ctx.reply({ text: REFUSED_REPLY, stopReason: 'end_turn' });

    spawnWasAttempted = true;
    spawnAttemptCount += 1;
    return ctx.reply({
      toolCalls: [{ name: ctx.spawnTool, input: ctx.spawnInput }],
      stopReason: 'tool_use',
    });
  };

  return {
    run,
    getSpawnAttemptCount: () => spawnAttemptCount,
  };
}
