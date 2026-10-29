import * as fs from 'node:fs';

export function ensureDir(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[pipelines] Failed to create directory ${dirPath}:`, error);
    return false;
  }
}

export function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    try {
      // Attempt atomic rename. On POSIX this overwrites; on Windows it may throw EEXIST.
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        // Avoid unlink-then-rename race on Windows: fall back to direct write
        fs.writeFileSync(filePath, content, 'utf-8');
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          /* best-effort */
        }
      } else {
        throw error;
      }
    }
  } finally {
    // Clean up tmp file if rename failed
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
  }
}

export function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function safeDeleteFile(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
