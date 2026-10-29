import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type PersistedChatTab } from '@canopy/desktop-shared/types';
import { getCodexRuntimeService } from '../codex/runtime-service';
import { isErrnoException } from './type-guards';

const CODEX_SESSION_SCAN_ENTRY_LIMIT = 10_000;

export async function findCodexRolloutFiles(
  sessionsRoot: string,
  threadId: string,
  entryLimit = CODEX_SESSION_SCAN_ENTRY_LIMIT,
): Promise<string[]> {
  const suffix = `-${threadId}.jsonl`;
  const results: string[] = [];
  const stack = [sessionsRoot];
  let visitedEntries = 0;
  while (stack.length > 0 && visitedEntries < entryLimit) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      visitedEntries += 1;
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(suffix)) {
        results.push(entryPath);
      }
      if (visitedEntries >= entryLimit) break;
    }
  }
  return results.sort();
}

export async function resolveCodexHomeForTab(args: {
  tab: PersistedChatTab;
  projectId: string;
  worktreeId: string;
  chatId: string;
  warnings: string[];
}): Promise<string> {
  void args;
  const { codexHome } = await getCodexRuntimeService().getCanonicalState();
  return codexHome;
}
