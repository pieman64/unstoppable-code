import { appendFile, open, type FileHandle } from 'node:fs/promises';

const NEWLINE = 0x0a;

/**
 * Whether the file ends inside a line, as an append cut short by a crash
 * leaves it. A file that is missing or cannot be checked is treated as clean.
 */
async function endsInsideLine(filePath: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    const { bytesRead } = await handle.read(last, 0, 1, size - 1);
    return bytesRead === 1 && last[0] !== NEWLINE;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Append complete JSONL lines to `filePath`. A torn last line is ended first,
 * so it stays one unreadable line instead of swallowing the first new record.
 */
export async function appendJsonlLines(
  filePath: string,
  lines: string,
): Promise<void> {
  const separator = (await endsInsideLine(filePath)) ? '\n' : '';
  await appendFile(filePath, `${separator}${lines}`);
}
