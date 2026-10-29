import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  requestPause,
  resetRunDir,
  setOutput,
  setOutputPathOrWriteFile,
  writeOutputFile,
} from '../_lib/output';
import { brandEnvName } from '../../brand/env';

describe('builtin action output helpers', () => {
  let tempDir: string;
  let outputFile: string;
  let originalOutput: string | undefined;
  let originalOutputDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-output-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    originalOutput = process.env.CANOPY_OUTPUT;
    originalOutputDir = process.env.CANOPY_OUTPUT_DIR;
    process.env.CANOPY_OUTPUT = outputFile;
    delete process.env.CANOPY_OUTPUT_DIR;
    resetRunDir();
  });

  afterEach(() => {
    if (originalOutput === undefined) {
      delete process.env.CANOPY_OUTPUT;
    } else {
      process.env.CANOPY_OUTPUT = originalOutput;
    }
    if (originalOutputDir === undefined) {
      delete process.env.CANOPY_OUTPUT_DIR;
    } else {
      process.env.CANOPY_OUTPUT_DIR = originalOutputDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes valid single-line outputs', () => {
    setOutput('result', 'success');

    expect(fs.readFileSync(outputFile, 'utf8')).toBe('result=success\n');
  });

  it('fails clearly when the branded output env var is missing', () => {
    delete process.env.CANOPY_OUTPUT;

    expect(() => setOutput('result', 'success')).toThrow(
      new RegExp(brandEnvName('OUTPUT')),
    );
  });

  it('rejects values containing newlines', () => {
    expect(() => setOutput('result', 'line one\nline two')).toThrow(
      /single-line/,
    );
  });

  it('rejects values containing carriage returns', () => {
    expect(() => setOutput('result', 'line one\rline two')).toThrow(
      /single-line/,
    );
  });

  it('writes sibling files and emits their paths', () => {
    const filePath = writeOutputFile('artifact', 'payload.txt', 'hello');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello');
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(`artifact=${filePath}\n`);
  });

  it('prefers CANOPY_OUTPUT_DIR when provided', () => {
    const outputDir = path.join(tempDir, 'stable-output');
    process.env.CANOPY_OUTPUT_DIR = outputDir;

    const filePath = writeOutputFile('artifact', 'payload.txt', 'hello');

    expect(filePath).toBe(path.join(outputDir, '0', 'payload.txt'));
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello');
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(`artifact=${filePath}\n`);
  });

  it('uses the preferred path without writing a fallback file', () => {
    const preferredPath = path.join(tempDir, 'step.log');
    const resolvedPath = setOutputPathOrWriteFile(
      'transcript_file',
      preferredPath,
      'transcript.jsonl',
      'payload',
    );

    expect(resolvedPath).toBe(preferredPath);
    expect(fs.existsSync(path.join(tempDir, 'transcript.jsonl'))).toBe(false);
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      `transcript_file=${preferredPath}\n`,
    );
  });

  it('falls back to writing a file when no preferred path is provided', () => {
    const resolvedPath = setOutputPathOrWriteFile(
      'transcript_file',
      undefined,
      'transcript.jsonl',
      'payload',
    );

    expect(resolvedPath).toBe(path.join(tempDir, '0', 'transcript.jsonl'));
    expect(fs.readFileSync(resolvedPath, 'utf8')).toBe('payload');
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      `transcript_file=${resolvedPath}\n`,
    );
  });

  it('increments subdirectory index for repeated runs', () => {
    writeOutputFile('first', 'a.txt', 'run0');
    expect(fs.readFileSync(path.join(tempDir, '0', 'a.txt'), 'utf8')).toBe(
      'run0',
    );

    resetRunDir();
    writeOutputFile('second', 'b.txt', 'run1');
    expect(fs.readFileSync(path.join(tempDir, '1', 'b.txt'), 'utf8')).toBe(
      'run1',
    );
  });

  it('writes the reserved pause output', () => {
    requestPause();

    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      `${brandEnvName('PAUSE')}=true\n`,
    );
  });
});
