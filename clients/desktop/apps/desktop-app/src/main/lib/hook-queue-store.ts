import { rename } from 'node:fs/promises';
import { HookQueuePayloadStore } from '@canopy/core-runtime/node/initiated-work';
import {
  damagedCopiesOf,
  damagedCopyPath,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import { writeFileAtomically } from './atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import { getHookQueueDir } from './paths';

export function createHookQueuePayloadStore(): HookQueuePayloadStore {
  return new HookQueuePayloadStore({
    directory: getHookQueueDir,
    writeFileAtomically: (path, text) =>
      writeFileAtomically(path, text, { encoding: 'utf8' }),
    quarantine: async (path) => {
      try {
        await rename(path, damagedCopyPath(path));
      } catch (error) {
        logMainProcessWarn(
          '[hook-queue] could not preserve damaged details',
          error,
        );
        return;
      }
      await pruneDamagedCopies(damagedCopiesOf(path));
    },
  });
}
