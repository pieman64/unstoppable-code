import {
  runRtkRewrite,
  type RtkRewriteOptions,
} from '@canopy/execution-engine/node/rtk/rewrite';

export interface CursorRtkRewriteOptions extends RtkRewriteOptions {
  signal: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrite a native Cursor `Shell` command through bundled RTK, mirroring the
 * Claude `Bash` PreToolUse hook. Returns the complete replacement
 * `tool_input` for the hook's `updated_input`, or `undefined` when the tool
 * is not Shell, the command is malformed, RTK declines, or the rewrite is a
 * no-op. Policy has already been evaluated on the command Cursor proposed;
 * this only substitutes the bundled wrapper for execution.
 */
export async function rewriteCursorShellInput(
  payload: unknown,
  options: CursorRtkRewriteOptions,
): Promise<Record<string, unknown> | undefined> {
  if (
    !isRecord(payload) ||
    payload.tool_name !== 'Shell' ||
    !isRecord(payload.tool_input)
  )
    return undefined;
  const command = payload.tool_input.command;
  if (typeof command !== 'string' || !command.trim()) return undefined;
  const rewritten = await runRtkRewrite(command, options, options.signal);
  if (!rewritten || rewritten === command) return undefined;
  return { ...payload.tool_input, command: rewritten };
}
