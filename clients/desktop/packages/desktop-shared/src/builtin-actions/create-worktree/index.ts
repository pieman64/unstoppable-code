import { runCreateWorktreeAction } from './runner';

void runCreateWorktreeAction().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
