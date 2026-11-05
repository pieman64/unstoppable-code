/**
 * Subprocess entry for `readChatStorage.mjs`: prints the committed state of
 * one format 3 or format 4 chat scope as JSON, with any requested format 4
 * delegation streams' rows.
 *
 * A format 3 scope keeps new commits in `delta-journal.log`; its index and
 * transcript files only change at a checkpoint. This runs the app's own
 * read-only replay helper so a spec sees what the app has committed, without
 * a second copy of the journal format in test code. It never writes the scope.
 *
 * `readChatStorage.mjs` bundles this file with esbuild and runs the bundle
 * with Node. Do not import it from a spec.
 */
import { openReplayedChatScope } from '../../src/main/lib/chat-delta-journal/reader.ts';
import { assertChatStorageIndexes } from '../../src/main/lib/chat-storage-v2.ts';

const REPLAY_ATTEMPTS = 6;

async function readMessages(view, chatId) {
  const log = view.transcript(chatId);
  const messages = [];
  for await (const message of log.iterate(chatId)) messages.push(message);
  const committedIds = new Set(messages.map((message) => message.id));
  for (const message of await log.activeMessages(chatId))
    if (!committedIds.has(message.id)) messages.push(message);
  return messages;
}

/** Every committed row of one delegation stream, oldest first. */
async function readStream(view, target) {
  const rows = [];
  let before;
  for (;;) {
    const page = await view.stream(
      { kind: 'delegation', ...target },
      before === undefined ? {} : { before },
    );
    rows.unshift(...page.rows);
    if (page.nextBefore === undefined) return rows;
    before = page.nextBefore;
  }
}

async function readScope({ directory, scopeId, chats, streams = [] }) {
  const view = await openReplayedChatScope(
    { directory, scopeId },
    assertChatStorageIndexes,
  );
  try {
    const chatIds =
      chats === 'tabs'
        ? view.indexes.live.tabs
            .filter((tab) => tab.kind !== 'file')
            .map((tab) => tab.id)
        : chats;
    const messages = {};
    for (const chatId of chatIds)
      messages[chatId] = await readMessages(view, chatId);
    const streamRows = [];
    for (const target of streams)
      streamRows.push(await readStream(view, target));
    return { indexes: view.indexes, messages, streams: streamRows };
  } finally {
    await view.dispose();
  }
}

async function main() {
  const request = JSON.parse(process.argv[2]);
  // The app keeps writing while a spec reads, and this reader holds no scope
  // lease. A checkpoint can land between its reads of the marker, the
  // indexes, the journal and a chat's transcript files, which shows up as an
  // integrity error or as a record that no longer applies to the rows it
  // copied. Each file is replaced atomically, so a retry sees a consistent
  // set; a persistent failure still rejects.
  for (let attempt = 1; ; attempt += 1) {
    try {
      process.stdout.write(JSON.stringify(await readScope(request)));
      return;
    } catch (error) {
      if (attempt >= REPLAY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
