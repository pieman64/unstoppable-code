import { runGatherLinearContextAction } from './runner';

void runGatherLinearContextAction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
