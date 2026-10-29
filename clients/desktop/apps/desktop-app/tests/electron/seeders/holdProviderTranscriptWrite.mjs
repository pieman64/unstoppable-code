/**
 * Test-only durable-sink barrier. The provider event is allowed through
 * session routing and canonical projection, then held immediately before its
 * durable write: the delta journal record of a format 3 scope, or the pending
 * transcript payload of a version 2 scope. This does not intercept the earlier
 * user-prompt transaction or the legacy chat journal.
 */
export async function holdProviderTranscriptWrite(
  electronApp,
  { userDataDir, workspaceId, scopeId, marker },
) {
  await electronApp.evaluate(
    (_electron, options) => {
      if (globalThis.__providerTranscriptWriteHold) {
        throw new Error('Provider transcript write hold is already installed');
      }
      const { createRequire, syncBuiltinESMExports } =
        process.getBuiltinModule('node:module');
      const require = createRequire(`${process.cwd()}/package.json`);
      const fsPromises = require('node:fs/promises');
      const path = require('node:path');
      const scope = path.join(
        options.userDataDir,
        'workspaces',
        options.workspaceId,
        'chat-storage-v2',
        options.scopeId,
      );
      const root = path.join(scope, 'pending-transcripts');
      const journal = path.join(scope, 'delta-journal.log');
      const originalOpen = fsPromises.open;
      let reached = false;
      let releaseGate = () => undefined;
      let gatedWrite = Promise.resolve();
      const gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
      fsPromises.open = async (filePath, ...args) => {
        const handle = await originalOpen(filePath, ...args);
        const resolved =
          typeof filePath === 'string' ? path.resolve(filePath) : '';
        if (
          resolved !== journal &&
          !(
            resolved.startsWith(`${root}${path.sep}`) &&
            resolved.endsWith('.jsonl')
          )
        ) {
          return handle;
        }
        const originalWrite = handle.write.bind(handle);
        handle.write = (...writeArgs) => {
          const chunk = writeArgs[0];
          if (
            reached ||
            !Buffer.isBuffer(chunk) ||
            !chunk.includes(options.marker)
          ) {
            return originalWrite(...writeArgs);
          }
          reached = true;
          gatedWrite = (async () => {
            await gate;
            return originalWrite(...writeArgs);
          })();
          return gatedWrite;
        };
        return handle;
      };
      syncBuiltinESMExports();
      globalThis.__providerTranscriptWriteHold = {
        read: () => ({ reached, root, marker: options.marker }),
        release: releaseGate,
        async stop() {
          releaseGate();
          fsPromises.open = originalOpen;
          syncBuiltinESMExports();
          await gatedWrite;
          delete globalThis.__providerTranscriptWriteHold;
        },
      };
    },
    { userDataDir, workspaceId, scopeId, marker },
  );
  return {
    read: () =>
      electronApp.evaluate(() =>
        globalThis.__providerTranscriptWriteHold?.read(),
      ),
    release: () =>
      electronApp.evaluate(() =>
        globalThis.__providerTranscriptWriteHold?.release(),
      ),
    stop: () =>
      electronApp.evaluate(async () => {
        await globalThis.__providerTranscriptWriteHold?.stop();
      }),
  };
}
