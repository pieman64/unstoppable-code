import { runGitCommitPushAction } from './runner';

void runGitCommitPushAction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
