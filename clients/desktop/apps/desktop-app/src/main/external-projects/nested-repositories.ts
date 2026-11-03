import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { compareText } from './file-head';

export interface NestedRepositoryScan {
  /** Possible repository paths, sorted deterministically; markers need validation. */
  repositories: string[];
  complete: boolean;
}

export const NESTED_REPOSITORY_MAX_DEPTH = 2;
export const NESTED_REPOSITORY_DIRECTORY_BUDGET = 400;

/** Read only the configured scope; a complete scan is not a filesystem snapshot. */
export async function findNestedRepositories(
  root: string,
  limits?: { maxDepth?: number; directoryBudget?: number },
): Promise<NestedRepositoryScan> {
  const maxDepth = limits?.maxDepth ?? NESTED_REPOSITORY_MAX_DEPTH;
  const budget = limits?.directoryBudget ?? NESTED_REPOSITORY_DIRECTORY_BUDGET;
  const queue = [{ directory: root, depth: 0 }];
  const repositories: string[] = [];
  let complete = true;
  let reads = 0;
  for (let index = 0; index < queue.length; index += 1) {
    if (reads >= budget) {
      complete = false;
      break;
    }
    const entry = queue[index];
    if (!entry) continue;
    reads += 1;
    try {
      const children = await readdir(entry.directory, { withFileTypes: true });
      const marker = children.some(
        (child) =>
          child.name === '.git' && (child.isDirectory() || child.isFile()),
      );
      if (marker) {
        repositories.push(entry.directory);
        continue;
      }
      if (entry.depth >= maxDepth) continue;
      const eligible = children
        .filter((child) => !child.name.startsWith('.') && child.isDirectory())
        .sort((a, b) => compareText(a.name, b.name));
      for (const child of eligible) {
        queue.push({
          directory: path.join(entry.directory, child.name),
          depth: entry.depth + 1,
        });
      }
    } catch {
      complete = false;
    }
  }
  return { repositories: repositories.sort(compareText), complete };
}
