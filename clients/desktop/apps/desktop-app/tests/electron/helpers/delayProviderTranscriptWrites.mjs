/**
 * Test-only slow durable sink. A scope's transcript writes become durable
 * when their delta-journal batch is written (`writeBatch` in
 * `chat-delta-journal/writer.ts`); the `.jsonl` files are materialized later,
 * at checkpoint. Every journal batch that appends provider rows (any non-user
 * message) to a committed transcript log waits `delayMs` before its write, so
 * the provider transcript commit is slow and later batches back up behind it.
 * Active-projection updates (`active*` effects, which carry in-flight rows),
 * user-only batches such as the user-prompt transaction, and index metadata
 * are not delayed, so the live turn's runtime still advances.
 */
export async function delayProviderTranscriptWrites(
  electronApp,
  { userDataDir, workspaceId, scopeId, delayMs },
) {
  await electronApp.evaluate(
    (_electron, options) => {
      const { createRequire, syncBuiltinESMExports } =
        process.getBuiltinModule('node:module');
      const require = createRequire(`${process.cwd()}/package.json`);
      const fsPromises = require('node:fs/promises');
      const path = require('node:path');
      const journalPath = path.join(
        options.userDataDir,
        'workspaces',
        options.workspaceId,
        'chat-storage-v2',
        options.scopeId,
        'delta-journal.log',
      );
      // Mirrors the frame layout in `chat-delta-journal/format.ts`: a 40-byte
      // header (`CDJ1`, payload length, sha256) and a JSON record payload.
      const FRAME_HEADER_BYTES = 40;
      const MAGIC = 'CDJ1';
      const appendsProviderRows = (bytes) => {
        for (let offset = 0; offset + FRAME_HEADER_BYTES <= bytes.length; ) {
          if (bytes.toString('ascii', offset, offset + 4) !== MAGIC)
            return false;
          const end =
            offset + FRAME_HEADER_BYTES + bytes.readUInt32LE(offset + 4);
          if (end > bytes.length) return false;
          let record;
          try {
            record = JSON.parse(
              bytes.toString('utf8', offset + FRAME_HEADER_BYTES, end),
            );
          } catch {
            return false;
          }
          if (
            record?.type === 'commit' &&
            (record.transcripts ?? []).some(
              (effect) =>
                effect.kind === 'append' &&
                (effect.messages ?? []).some(
                  (message) => message?.role !== 'user',
                ),
            )
          )
            return true;
          offset = end;
        }
        return false;
      };
      const originalOpen = fsPromises.open;
      let pendingWrites = 0;
      let stopped = false;
      fsPromises.open = async (filePath, ...args) => {
        const handle = await originalOpen(filePath, ...args);
        const resolved =
          typeof filePath === 'string' ? path.resolve(filePath) : '';
        if (resolved !== journalPath || args[0] !== 'r+') return handle;
        const originalWrite = handle.write.bind(handle);
        let checked = false;
        handle.write = async (buffer, ...rest) => {
          // A batch is one append; hold it once, before its first write.
          if (!checked && !stopped && Buffer.isBuffer(buffer)) {
            checked = true;
            if (appendsProviderRows(buffer)) {
              pendingWrites += 1;
              try {
                await new Promise((resolve) =>
                  setTimeout(resolve, options.delayMs),
                );
              } finally {
                pendingWrites -= 1;
              }
            }
          }
          return originalWrite(buffer, ...rest);
        };
        return handle;
      };
      syncBuiltinESMExports();
      globalThis.__providerTranscriptWriteDelay = {
        pendingCount: () => pendingWrites,
        stop() {
          stopped = true;
          fsPromises.open = originalOpen;
          syncBuiltinESMExports();
          delete globalThis.__providerTranscriptWriteDelay;
        },
      };
    },
    { userDataDir, workspaceId, scopeId, delayMs },
  );
  return {
    pendingCount: () =>
      electronApp.evaluate(
        () => globalThis.__providerTranscriptWriteDelay?.pendingCount() ?? 0,
      ),
    stop: () =>
      electronApp.evaluate(() =>
        globalThis.__providerTranscriptWriteDelay?.stop(),
      ),
  };
}
