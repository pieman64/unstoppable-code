import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { resetRunDir } from '../_lib/output';
import { runPipelineReportAction } from '../pipeline-report/runner';

const OUTPUT_ENV = brandEnvName('OUTPUT');
const OUTPUT_DIR_ENV = brandEnvName('OUTPUT_DIR');
const REPORT_OUTPUT_ENV = brandEnvName('OUTPUT_REPORT');
const REPORT_JSON_OUTPUT_ENV = brandEnvName('OUTPUT_REPORT_JSON');

function readOutputMap(outputFile: string): Record<string, string> {
  const lines = fs.readFileSync(outputFile, 'utf8').trim().split('\n');
  return Object.fromEntries(
    lines
      .filter((line) => line.length > 0)
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

describe('pipeline-report action', () => {
  let tempDir: string;
  let outputFile: string;
  let outputDir: string;
  let originalOutput: string | undefined;
  let originalOutputDir: string | undefined;

  beforeEach(() => {
    resetRunDir();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-report-'));
    outputFile = path.join(tempDir, 'app-output.txt');
    outputDir = path.join(tempDir, 'execution-output');
    originalOutput = process.env[OUTPUT_ENV];
    originalOutputDir = process.env[OUTPUT_DIR_ENV];
    delete process.env[OUTPUT_ENV];
    delete process.env[OUTPUT_DIR_ENV];
  });

  afterEach(() => {
    if (originalOutput === undefined) {
      delete process.env[OUTPUT_ENV];
    } else {
      process.env[OUTPUT_ENV] = originalOutput;
    }
    if (originalOutputDir === undefined) {
      delete process.env[OUTPUT_DIR_ENV];
    } else {
      process.env[OUTPUT_DIR_ENV] = originalOutputDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a text report and emits the reserved output key', () => {
    runPipelineReportAction({
      [OUTPUT_ENV]: outputFile,
      [OUTPUT_DIR_ENV]: outputDir,
      INPUT_CONTENT: '# Report',
      INPUT_FORMAT: 'text',
    });

    const outputs = readOutputMap(outputFile);
    const reportPath = path.join(outputDir, '0', 'report.md');

    expect(outputs[REPORT_OUTPUT_ENV]).toBe(reportPath);
    expect(outputs.report_path).toBe(reportPath);
    expect(fs.readFileSync(reportPath, 'utf8')).toBe('# Report\n');
  });

  it('writes a pretty-printed JSON report', () => {
    runPipelineReportAction({
      [OUTPUT_ENV]: outputFile,
      [OUTPUT_DIR_ENV]: outputDir,
      INPUT_CONTENT: '{"status":"ok"}',
      INPUT_FORMAT: 'json',
    });

    const outputs = readOutputMap(outputFile);
    const reportPath = path.join(outputDir, '0', 'report.json');

    expect(outputs[REPORT_JSON_OUTPUT_ENV]).toBe(reportPath);
    expect(outputs.report_path).toBe(reportPath);
    expect(fs.readFileSync(reportPath, 'utf8')).toBe(
      '{\n  "status": "ok"\n}\n',
    );
  });

  it('rejects invalid formats', () => {
    expect(() =>
      runPipelineReportAction({
        [OUTPUT_ENV]: outputFile,
        [OUTPUT_DIR_ENV]: outputDir,
        INPUT_CONTENT: 'hello',
        INPUT_FORMAT: 'xml',
      }),
    ).toThrow(/invalid format/i);
  });

  it('rejects invalid JSON input', () => {
    expect(() =>
      runPipelineReportAction({
        [OUTPUT_ENV]: outputFile,
        [OUTPUT_DIR_ENV]: outputDir,
        INPUT_CONTENT: '{',
        INPUT_FORMAT: 'json',
      }),
    ).toThrow();
  });

  it('restores output env vars after execution', () => {
    process.env[OUTPUT_ENV] = 'original-output';
    process.env[OUTPUT_DIR_ENV] = 'original-dir';

    runPipelineReportAction({
      [OUTPUT_ENV]: outputFile,
      [OUTPUT_DIR_ENV]: outputDir,
      INPUT_CONTENT: 'hello',
      INPUT_FORMAT: 'text',
    });

    expect(process.env[OUTPUT_ENV]).toBe('original-output');
    expect(process.env[OUTPUT_DIR_ENV]).toBe('original-dir');
  });
});
