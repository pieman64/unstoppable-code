import type { ParentPort } from 'electron';
import { isAbsolute } from 'node:path';
import {
  isProfileId,
  isProfileRecord,
} from '@canopy/protocol/browser-profiles';
import { scanBrowserProfileDirectory } from '@canopy/desktop-shared/node/browser-profiles/inventory-scan';

// No runtime Electron/main import: this entry executes in a utility process.
const port: ParentPort | undefined = process.parentPort;
if (port)
  port.once('message', (event: unknown): void => {
    void (async (): Promise<void> => {
      const request = isProfileRecord(event) ? event.data : undefined;
      try {
        if (
          !isProfileRecord(request) ||
          !isProfileId(request.profileId) ||
          !Number.isSafeInteger(request.storageGeneration) ||
          Number(request.storageGeneration) < 1 ||
          typeof request.directory !== 'string' ||
          !isAbsolute(request.directory) ||
          request.directory.includes('\0')
        )
          throw new Error('Invalid inventory request.');
        const identity = {
          profileId: request.profileId,
          storageGeneration: request.storageGeneration,
        };
        const totals = await scanBrowserProfileDirectory(request.directory, {
          onProgress: (progress) =>
            port.postMessage({
              ...identity,
              kind: 'progress',
              totals: progress,
            }),
        });
        // Exit only after the parent has accepted the result. An immediate exit
        // after postMessage can drop the final message before its IPC transport flushes.
        const deadline = setTimeout(() => process.exit(1), 10_000);
        port.once('message', (event: unknown) => {
          const ack = isProfileRecord(event) ? event.data : undefined;
          clearTimeout(deadline);
          process.exit(
            isProfileRecord(ack) &&
              ack.kind === 'ack' &&
              ack.profileId === identity.profileId &&
              ack.storageGeneration === identity.storageGeneration
              ? 0
              : 1,
          );
        });
        port.postMessage({ ...identity, kind: 'complete', totals });
      } catch {
        // Never emit paths, database contents or filesystem errors to profile metadata.
        port.postMessage({
          kind: 'error',
          message: 'Browser inventory could not measure this storage.',
        });
        process.exit(1);
      }
    })();
  });
