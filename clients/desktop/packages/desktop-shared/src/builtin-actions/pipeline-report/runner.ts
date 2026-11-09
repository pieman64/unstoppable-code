import { runWithSynchronousActionEnvironment } from '../_lib/action-env';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import { setOutput, writeOutputFile } from '../_lib/output';

const TEXT_FORMAT = 'text';
const JSON_FORMAT = 'json';
const REPORT_OUTPUT_KEY = brandEnvName('OUTPUT_REPORT');
const REPORT_JSON_OUTPUT_KEY = brandEnvName('OUTPUT_REPORT_JSON');
const ACTION_NAME = 'pipeline-report';

function normalizeFormat(rawFormat: string | undefined): string {
  return (rawFormat ?? TEXT_FORMAT).trim().toLowerCase();
}

function withTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

export function runPipelineReportAction(
  env: NodeJS.ProcessEnv = process.env,
): void {
  runWithSynchronousActionEnvironment(env, () => {
    const content = env.INPUT_CONTENT;
    if (!content) {
      throw new Error(`${ACTION_NAME}: "content" input is required`);
    }

    const format = normalizeFormat(env.INPUT_FORMAT);
    if (format !== TEXT_FORMAT && format !== JSON_FORMAT) {
      throw new Error(
        `${ACTION_NAME}: invalid format "${format}" - must be "text" or "json"`,
      );
    }

    let finalContent = withTrailingNewline(content);
    let fileName = 'report.md';
    let outputKey = REPORT_OUTPUT_KEY;

    if (format === JSON_FORMAT) {
      const parsed: unknown = JSON.parse(content);
      finalContent = `${JSON.stringify(parsed, null, 2)}\n`;
      fileName = 'report.json';
      outputKey = REPORT_JSON_OUTPUT_KEY;
    }

    const reportPath = writeOutputFile(outputKey, fileName, finalContent);
    setOutput('report_path', reportPath);
  });
}
