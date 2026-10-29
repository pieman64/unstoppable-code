import { runPipelineReportAction } from './runner';

void Promise.resolve()
  .then(() => runPipelineReportAction())
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
