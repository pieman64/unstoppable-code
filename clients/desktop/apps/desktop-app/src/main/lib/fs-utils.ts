import * as fs from 'fs';
import { readdir, readFile } from 'node:fs/promises';

/**
 * Safely read and parse a JSON file, returning `null` on any error.
 */
export function safeReadJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Async {@link safeReadJson}. Prefer this on any path that runs on the Electron
 * main thread during a user interaction — `readFileSync` blocks the main event
 * loop, and the send-time auth preflight reads one server file per selected MCP
 * server on every send (CAN-1814 review).
 */
export async function safeReadJsonAsync<T>(
  filePath: string,
): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Safely read a text file, returning `null` on any error.
 */
export function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    try {
      await readdir(path);
      return true;
    } catch {
      return false;
    }
  }
}

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
