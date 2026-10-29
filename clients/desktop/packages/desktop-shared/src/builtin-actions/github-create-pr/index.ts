import { runGitHubCreatePrAction } from './runner';

void runGitHubCreatePrAction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
