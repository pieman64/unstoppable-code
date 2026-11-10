import { BRAND } from '@canopy/brand/current';
import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { runRtkRewrite, type RtkRewriteOptions } from './rewrite';

/** Node-only options for the Claude RTK hook integration. */
export interface RtkClaudeHookOptions extends RtkRewriteOptions {
  isEnabled?: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getToolInput(input: unknown): unknown {
  if (!isRecord(input)) {
    return undefined;
  }

  return input['tool_input'];
}

export function buildRtkClaudeHooks(
  options: RtkClaudeHookOptions,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          async (
            input: HookInput,
            _toolUseId: string | undefined,
            hookOptions: {
              signal: AbortSignal;
            },
          ): Promise<HookJSONOutput> => {
            if (options.isEnabled?.() === false) {
              return { continue: true };
            }

            const originalToolInput = getToolInput(input);
            if (!isRecord(originalToolInput)) {
              return { continue: true };
            }

            const command = originalToolInput.command;
            if (typeof command !== 'string' || command.trim().length === 0) {
              return { continue: true };
            }

            const rewrittenCommand = await runRtkRewrite(
              command,
              options,
              hookOptions.signal,
            );
            if (!rewrittenCommand) {
              return { continue: true };
            }

            const updatedInput: Record<string, unknown> = {
              ...originalToolInput,
              command: rewrittenCommand,
            };
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput,
                permissionDecision: 'allow',
                permissionDecisionReason: `Command rewritten by ${BRAND.displayName} RTK integration`,
              },
            };
          },
        ],
      },
    ],
  };
}
