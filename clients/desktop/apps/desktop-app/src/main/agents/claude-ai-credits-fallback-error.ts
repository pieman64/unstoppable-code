import { readClaudeApiErrorStatus } from '@canopy/agent-transcript';
import { CLAUDE_AI_CREDITS_FALLBACK_ERROR_CODE } from '@canopy/protocol/llm-gateway';
import { isRecord } from '../lib/type-guards';

const MESSAGE_CONTENT_REJECTION =
  /^API Error: 400 messages(?:\[\d+\]|\.\d+)\.content:\s*Invalid input\s*$/;

/** Keep provider diagnostics intact; attach only a trusted presentation hint. */
export function withClaudeAiCreditsFallbackError(
  event: unknown,
  nativeAuthFallback: boolean,
): unknown {
  if (!nativeAuthFallback || !isRecord(event)) return event;
  if (event.parent_tool_use_id != null) return event;

  let message: string | undefined;
  if (event.type === 'result' && event.is_error === true) {
    if (readClaudeApiErrorStatus(event) !== 400) return event;
    message = typeof event.result === 'string' ? event.result : undefined;
  } else if (
    event.type === 'assistant' &&
    event.error === 'unknown' &&
    isRecord(event.message) &&
    event.message.model === '<synthetic>' &&
    Array.isArray(event.message.content) &&
    event.message.content.length === 1
  ) {
    const block: unknown = event.message.content[0];
    if (!isRecord(block) || block.type !== 'text') return event;
    if ('api_error_status' in event && event.api_error_status !== 400)
      return event;
    message = typeof block.text === 'string' ? block.text : undefined;
  }

  if (!message || !MESSAGE_CONTENT_REJECTION.test(message)) return event;
  return {
    ...event,
    canopy_display_error_code: CLAUDE_AI_CREDITS_FALLBACK_ERROR_CODE,
  };
}
