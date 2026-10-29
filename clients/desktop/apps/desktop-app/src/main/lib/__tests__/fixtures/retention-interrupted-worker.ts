import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';
import { createRequire } from 'node:module';

// Keep the real worker, request handler and durable writes. Stop its thread
// after the first installed image, before the applier can write the second.
const write = desktopW5Durability.writeFileDurably;
Object.defineProperty(desktopW5Durability, 'writeFileDurably', {
  value: async (path: string, contents: string): Promise<void> => {
    await write(path, contents);
    process.exit(86);
  },
});
// The worker harness installs tsx's CJS hooks, not its ESM resolver.
createRequire(__filename)('../../../w5-commit-log/commit-log-worker');
