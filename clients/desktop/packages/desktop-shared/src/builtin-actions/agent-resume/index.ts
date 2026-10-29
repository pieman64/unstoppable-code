import { runAgentResumeAction } from '../agent-prompt/runner';

void runAgentResumeAction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
