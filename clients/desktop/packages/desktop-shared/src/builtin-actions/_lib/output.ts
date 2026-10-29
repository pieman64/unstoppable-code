import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brandEnvName, getBrandEnv } from '../../brand/env';

let resolvedRunDir: string | null = null;

function getOutputFilePath(): string {
  const outputFile = getBrandEnv(process.env, 'OUTPUT');
  if (!outputFile) {
    throw new Error(
      `${brandEnvName('OUTPUT')} is required for builtin actions`,
    );
  }
  return outputFile;
}

function getRunDir(): string {
  if (resolvedRunDir !== null) {
    return resolvedRunDir;
  }

  const baseDir =
    getBrandEnv(process.env, 'OUTPUT_DIR') ?? dirname(getOutputFilePath());
  mkdirSync(baseDir, { recursive: true });

  for (let index = 0; index < 10000; index++) {
    const candidate = join(baseDir, String(index));
    try {
      mkdirSync(candidate);
      resolvedRunDir = candidate;
      return resolvedRunDir;
    } catch {
      // Directory already claimed by another process, try the next index
    }
  }

  throw new Error(`Failed to allocate run directory under ${baseDir}`);
}

export function resetRunDir(): void {
  resolvedRunDir = null;
}

export function setOutput(key: string, value: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`Output "${key}" must be single-line`);
  }

  appendFileSync(getOutputFilePath(), `${key}=${value}\n`, 'utf8');
}

export function requestPause(): void {
  setOutput(brandEnvName('PAUSE'), 'true');
}

export function writeOutputFile(
  key: string,
  fileName: string,
  content: string,
): string {
  const dir = getRunDir();
  const filePath = join(dir, fileName);
  writeFileSync(filePath, content, 'utf8');
  setOutput(key, filePath);
  return filePath;
}

export function writePrivateOutputFile(
  key: string,
  fileName: string,
  content: string,
): string {
  const dir = getRunDir();
  chmodSync(dir, 0o700);
  const filePath = join(dir, fileName);
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
  setOutput(key, filePath);
  return filePath;
}

export function setOutputPathOrWriteFile(
  key: string,
  preferredPath: string | undefined,
  fallbackFileName: string,
  content: string,
): string {
  if (preferredPath && preferredPath.trim().length > 0) {
    setOutput(key, preferredPath);
    return preferredPath;
  }

  return writeOutputFile(key, fallbackFileName, content);
}
