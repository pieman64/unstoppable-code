import {
  createRunLogCoordinator as createCoreRunLogCoordinator,
  writeRunLogMeta as writeCoreRunLogMeta,
  type RunLogCoordinator,
  type RunLogFiles,
} from '@canopy/core-runtime/node/script/execution';
import { writeFileAtomically } from './atomic-file';

/*
 * The run-log write chains and caps moved to the worker's script execution
 * (`@canopy/core-runtime/node/script/execution`, CAN-4143). Hook invocation
 * logs reuse them here with the desktop's atomic writer until hook execution
 * moves (CAN-4146).
 */

export {
  appendRunLogLines,
  completeRunLogFiles,
  MAX_RUN_LOG_BYTES,
  MAX_RUN_LOG_LINES,
  readRunLogTailLines,
  startRunLogFiles,
  type RunLogCoordinator,
  type RunLogPaths,
} from '@canopy/core-runtime/node/script/execution';

const desktopRunLogFiles: RunLogFiles = {
  writeFileAtomically: (path, text) =>
    writeFileAtomically(path, text, { encoding: 'utf8' }),
};

export function createRunLogCoordinator(): RunLogCoordinator {
  return createCoreRunLogCoordinator(desktopRunLogFiles);
}

export function writeRunLogMeta(
  metaPath: string,
  meta: unknown,
): Promise<void> {
  return writeCoreRunLogMeta(desktopRunLogFiles, metaPath, meta);
}
