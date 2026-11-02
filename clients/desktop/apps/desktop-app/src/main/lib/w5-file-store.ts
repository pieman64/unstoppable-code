import { createNodeW5FileStore } from '@canopy/core-runtime/node/w5/file-store';
import { writeFileAtomically } from './atomic-file';

export * from '@canopy/core-runtime/node/w5/file-store';

// Resolves the writer per call, so tests that replace it still intercept.
export const nodeW5FileStore = createNodeW5FileStore(
  (filePath, contents, options) =>
    writeFileAtomically(filePath, contents, options),
);
