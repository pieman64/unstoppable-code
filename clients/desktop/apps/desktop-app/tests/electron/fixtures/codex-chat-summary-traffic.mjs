// Classifies the chat-summary helper's traffic on the fake Codex app-server.
//
// The first message of a chat schedules a background topic summary
// (`scheduleChatSummary` → `generateChatSummary`). With a Codex summary model,
// the shipped default, that summary runs through the same app-server as the
// conversation: an ephemeral `thread/start` carrying the summary system prompt,
// then one `turn/start` whose input quotes the user's message inside
// `<user_message_to_summarize>`. Because it quotes the message, a fixture mode
// keyed on prompt text would also script the summary, and a spec counting every
// `turn/start` would count it.
//
// The fake server uses these helpers to answer summary turns plainly, and specs
// use them to count only the conversation's own traffic. Both fingerprints
// mirror `apps/desktop-app/src/main/agents/utils.ts`: the instructions
// fingerprint opens its shared `SHORT_CHAT_TITLE_SYSTEM_PROMPT`
// (`packages/protocol/src/generated-names.ts`),
// and the marker wraps the submitted summary prompt.
// `node/codex-chat-summary-traffic.test.mjs` fails if either source drifts.

export const CHAT_SUMMARY_TURN_MARKER = '<user_message_to_summarize>';
export const CHAT_SUMMARY_INSTRUCTIONS_FINGERPRINT =
  'expert at providing concise topic summaries';
/** Deterministic topic summary the fake server answers summary turns with. */
export const CHAT_SUMMARY_FIXTURE_REPLY = 'Codex fixture topic summary';

export function isChatSummaryThreadStartParams(params) {
  return (
    typeof params?.developerInstructions === 'string' &&
    params.developerInstructions.includes(CHAT_SUMMARY_INSTRUCTIONS_FINGERPRINT)
  );
}

export function isChatSummaryTurnInput(input) {
  return JSON.stringify(input ?? null).includes(CHAT_SUMMARY_TURN_MARKER);
}

function isClientRequest(entry) {
  return entry?.direction === 'client' && entry.message;
}

function requestKey(entry) {
  return `${String(entry.pid)}:${String(entry.message.id)}`;
}

function summaryThreadStartKeys(entries) {
  return new Set(
    entries
      .filter(
        (entry) =>
          isClientRequest(entry) &&
          entry.message.method === 'thread/start' &&
          isChatSummaryThreadStartParams(entry.message.params),
      )
      .map(requestKey),
  );
}

function summaryThreadIds(entries, threadStartKeys) {
  const threadIds = new Set(
    chatSummaryTurnStarts(entries).map((request) => request.params?.threadId),
  );
  for (const entry of entries) {
    const startedThreadId = entry?.message?.result?.thread?.id;
    if (
      entry?.direction === 'server' &&
      startedThreadId &&
      threadStartKeys.has(requestKey(entry))
    ) {
      threadIds.add(startedThreadId);
    }
  }
  return threadIds;
}

function isSummaryEntry(entry, summaryRequestKeys, threadIds) {
  const message = entry.message ?? {};
  // Request ids are only meaningful for client requests and the server's
  // responses to them; server-initiated requests use their own id space.
  const isRequestOrResponse =
    entry.direction === 'client' || message.method === undefined;
  if (
    isRequestOrResponse &&
    message.id !== undefined &&
    summaryRequestKeys.has(requestKey(entry))
  ) {
    return true;
  }
  return threadIds.has(message.params?.threadId ?? message.result?.thread?.id);
}

/**
 * Drops every chat-summary request, response, and notification from raw fake
 * app-server log entries (`{ direction, pid, message }`). A summary thread is
 * recognized from its `thread/start` instructions or from a summary
 * `turn/start`, so its traffic is excluded even before its turn starts.
 * Entries in other directions (for example fixture markers) are kept.
 */
export function withoutChatSummaryTraffic(entries) {
  const threadStartKeys = summaryThreadStartKeys(entries);
  const threadIds = summaryThreadIds(entries, threadStartKeys);
  // Responses carry only the request id, so remember which requests were
  // the summary's to drop their responses too.
  const summaryRequestKeys = new Set([
    ...threadStartKeys,
    ...entries
      .filter(
        (entry) =>
          isClientRequest(entry) &&
          threadIds.has(entry.message.params?.threadId),
      )
      .map(requestKey),
  ]);
  return entries.filter(
    (entry) =>
      !['client', 'server'].includes(entry?.direction) ||
      !isSummaryEntry(entry, summaryRequestKeys, threadIds),
  );
}

/** Client `turn/start` requests issued by the chat-summary helper. */
export function chatSummaryTurnStarts(entries) {
  return entries
    .filter(
      (entry) =>
        isClientRequest(entry) &&
        entry.message.method === 'turn/start' &&
        isChatSummaryTurnInput(entry.message.params?.input),
    )
    .map((entry) => entry.message);
}
