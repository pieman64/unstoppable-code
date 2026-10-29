import { createHash } from 'node:crypto';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ScriptActionDiagnostic } from '@canopy/protocol/script-actions';

export const DETECTION_LIMITS = {
  sourceBytes: 8 * 1024 * 1024,
  sourceEntries: 200,
  repositoryEntries: 2000,
  packages: 200,
  shellCandidates: 50,
  globDepth: 4,
  directoryEntries: 4096,
  directories: 2000,
  reads: 15000,
} as const;
const SOURCE_LIMIT_MESSAGE = `Source exceeds ${DETECTION_LIMITS.sourceBytes / (1024 * 1024)} MB.`;
export interface SourceFile {
  digest: string;
  head: string;
  content: string;
  executable: boolean;
}
export class SourceReader {
  public readonly diagnostics: ScriptActionDiagnostic[] = [];
  public readonly watchedDirectories = new Set<string>();
  public failureCount = 0;
  private reads = 0;
  private directories = 0;
  public constructor(private readonly root: string) {}
  public async requireRoot(): Promise<boolean> {
    try {
      return (await stat(await realpath(this.root))).isDirectory();
    } catch {
      this.diagnose('.', 'unreadable', 'Source root could not be read.');
      return false;
    }
  }
  public diagnose(
    source: string,
    code: ScriptActionDiagnostic['code'],
    message: string,
  ): void {
    this.failureCount++;
    if (this.diagnostics.length < 1000)
      this.diagnostics.push({ source: source || '.', code, message });
  }
  public async contained(name: string): Promise<string | null> {
    const root = await realpath(this.root);
    const target = await realpath(join(root, name));
    const rest = relative(root, target);
    if (isAbsolute(rest) || rest === '..' || rest.startsWith(`..${sep}`)) {
      this.diagnose(
        name,
        'outside-root',
        'Source resolves outside the repository.',
      );
      return null;
    }
    return target;
  }
  public async read(name: string): Promise<SourceFile | null> {
    if (++this.reads > DETECTION_LIMITS.reads) {
      this.diagnose(name, 'truncated', 'Source read limit reached.');
      return null;
    }
    try {
      const target = await this.contained(name);
      if (!target) return null;
      const handle = await open(target, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          this.diagnose(name, 'unsupported', 'Source must be a regular file.');
          return null;
        }
        if (info.size > DETECTION_LIMITS.sourceBytes) {
          this.diagnose(name, 'truncated', SOURCE_LIMIT_MESSAGE);
          return null;
        }
        // One spare byte detects a file that grew after stat.
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > info.size) {
          this.diagnose(
            name,
            'unreadable',
            'Source changed while it was read. Rescan to try again.',
          );
          return null;
        }
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(
            buffer.subarray(0, length),
          );
        } catch {
          this.diagnose(name, 'malformed', 'Source must use UTF-8 text.');
          return null;
        }
        return {
          content,
          digest: createHash('sha256')
            .update(buffer.subarray(0, length))
            .digest('hex'),
          head: buffer.subarray(0, Math.min(256, length)).toString('utf8'),
          executable: (info.mode & 0o111) !== 0,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isMissing(error))
        this.diagnose(name, 'unreadable', 'Source could not be read.');
      return null;
    }
  }
  public async directory(
    name: string,
  ): Promise<{ name: string; directory: boolean; file: boolean }[]> {
    if (++this.directories > DETECTION_LIMITS.directories) {
      this.diagnose(name, 'truncated', 'Directory traversal limit reached.');
      return [];
    }
    try {
      const target = await this.contained(name);
      if (!target) return [];
      this.watchedDirectories.add(name);
      const directory = await opendir(target);
      const entries: { name: string; directory: boolean; file: boolean }[] = [];
      for await (const entry of directory) {
        if (entries.length >= DETECTION_LIMITS.directoryEntries) {
          this.diagnose(
            name,
            'truncated',
            'Directory exceeds the discovery limit.',
          );
          return [];
        }
        // Never follow directory links: prevents workspace cycles and duplicate discovery.
        entries.push({
          name: entry.name,
          directory: entry.isDirectory(),
          file: entry.isFile(),
        });
      }
      return entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch (error) {
      if (!isMissing(error))
        this.diagnose(name, 'unreadable', 'Directory could not be read.');
      return [];
    }
  }
  public async exists(name: string): Promise<boolean> {
    try {
      const target = await this.contained(name);
      return target !== null && (await stat(target)).isFile();
    } catch (error) {
      if (!isMissing(error))
        this.diagnose(name, 'unreadable', 'Source could not be inspected.');
      return false;
    }
  }
}
export function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
