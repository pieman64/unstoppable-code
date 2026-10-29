import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
  AI_CREDITS_PROXY_ERROR_MARKER,
  AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE,
  type CanopyProxyError,
} from '@canopy/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Restore only failures already established by the caller's trusted routing
// or proxy evidence. Preserve Codex's original field projection by default.
function buildRestoredProxyFailureBody(failure: CanopyProxyError): string {
  // The proxy's own message when it parsed one; otherwise the shared copy the
  // hosted route sends for that code, so the restored entry matches it.
  const message =
    failure.message ??
    (failure.code === 'no_billing_source'
      ? AI_CREDITS_NO_BILLING_SOURCE_MESSAGE
      : failure.code === 'work_owner_not_member'
        ? AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE
        : null);
  // Field order matches `writeProxyError`/`proxyFailureBody`: marker first,
  // then code, so a truncated render still classifies. The correlation id is
  // the one the proxy read off the hosted body, never a fabricated one.
  return JSON.stringify({
    error: {
      canopy_proxy: AI_CREDITS_PROXY_ERROR_MARKER,
      code: failure.code,
      ...(failure.correlationId
        ? { correlation_id: failure.correlationId }
        : {}),
      ...(message === null ? {} : { message }),
    },
  });
}

/**
 * Replace whichever field carries the provider's rendered error text with the
 * restored marked body.
 *
 * A failed routed turn does NOT arrive in one canonical shape. The app-server
 * has been observed reporting the same 402 as a bare `{type:'error', message}`
 * with no `turn.failed` at all, while a wire-shaped `turn.failed` carries
 * `error.message` instead. Whichever one arrives becomes the persisted
 * `Error: <text>` system message, so restoring only one of them leaves the raw
 * `unexpected status 402 ..., url: http://127.0.0.1:...` line on the other.
 * Both are rewritten rather than guessing which shape a given provider build
 * emits.
 */
function withRestoredProxyFailureText(
  event: Record<string, unknown>,
  failure: CanopyProxyError,
): Record<string, unknown> {
  const restored = buildRestoredProxyFailureBody(failure);
  return {
    ...event,
    ...(typeof event.message === 'string' ? { message: restored } : {}),
    ...(isRecord(event.error)
      ? { error: { ...event.error, message: restored } }
      : {}),
  };
}

/**
 * Restore the proxy-observed refusal onto the failure event. Only the
 * no-billing-source case also carries the banner flag; every other marked
 * refusal (a refused work owner, CAN-3462) is named by the transcript notice
 * that parses the restored body.
 */
export function withProxyFailureRestored(
  data: unknown,
  failure: CanopyProxyError,
  projection?: 'claude',
): unknown {
  if (!isRecord(data)) return data;
  const flag =
    failure.code === 'no_billing_source'
      ? { [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true }
      : {};
  if (data.type === 'codex' && isRecord(data.event)) {
    return {
      ...data,
      event: {
        ...withRestoredProxyFailureText(data.event, failure),
        ...flag,
      },
    };
  }
  return {
    ...withRestoredProxyFailureText(data, failure),
    ...(projection === 'claude' ? claudeFailureText(data, failure) : {}),
    ...flag,
  };
}

/** Project onto the fields Claude's transcript and Portal consumers actually read. */
function claudeFailureText(
  event: Record<string, unknown>,
  failure: CanopyProxyError,
): Record<string, unknown> {
  const restored = buildRestoredProxyFailureBody(failure);
  const message = isRecord(event.message) ? event.message : undefined;
  const content: unknown[] | undefined = Array.isArray(message?.content)
    ? message.content
    : undefined;
  const errors: unknown[] | undefined = Array.isArray(event.errors)
    ? event.errors
    : undefined;
  const projectedContent = content?.map((block): unknown =>
    isRecord(block) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.trim()
      ? { ...block, text: restored }
      : block,
  );
  const needsMessageContent =
    event.type === 'assistant' ||
    (event.type === 'error' && typeof event.error !== 'string');
  const hasErrorText = projectedContent?.some(
    (block) =>
      isRecord(block) &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim(),
  );
  return {
    ...(event.type === 'result' ? { result: restored } : {}),
    ...(typeof event.error === 'string' && event.type === 'error'
      ? { error: restored }
      : {}),
    ...(errors
      ? {
          errors: errors.map((error) =>
            typeof error === 'string' ? restored : error,
          ),
        }
      : {}),
    ...(content || needsMessageContent
      ? {
          message: {
            ...message,
            content: [
              ...(projectedContent ?? []),
              ...(!hasErrorText && needsMessageContent
                ? [{ type: 'text', text: restored }]
                : []),
            ],
          },
        }
      : {}),
  };
}
