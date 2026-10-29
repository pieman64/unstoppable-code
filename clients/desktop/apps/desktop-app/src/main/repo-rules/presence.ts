import { lstat, opendir } from 'node:fs/promises';
import type { EditorSetupPresence } from '@canopy/protocol/repo-rules';
import type { RepoCheckout } from './discovery';
import { MAX_ENTRIES, safePath } from './safety';

/** Metadata-only hint. Never opens an instruction or discovers nested scopes. */
export async function editorSetupPresence(
  repos: RepoCheckout[],
): Promise<EditorSetupPresence> {
  let entries = 0;
  for (const repo of repos.slice(0, 32)) {
    try {
      const legacy = await lstat(await safePath(repo.root, '.cursorrules'));
      if (legacy.isFile() && legacy.size > 0 && legacy.size <= 65536)
        return { cursorRulesPresent: true };
    } catch {
      /* A missing root rule is normal. */
    }
    const pending = ['.cursor/rules'];
    while (pending.length) {
      const path = pending.shift();
      if (!path || path.split('/').length > 32) continue;
      try {
        const directory = await opendir(await safePath(repo.root, path));
        for await (const entry of directory) {
          if (++entries > MAX_ENTRIES) return { cursorRulesPresent: false };
          const child = `${path}/${entry.name}`;
          if (entry.isDirectory()) pending.push(child);
          else if (entry.isFile() && entry.name.endsWith('.mdc')) {
            const stat = await lstat(await safePath(repo.root, child));
            if (stat.size > 0 && stat.size <= 65536)
              return { cursorRulesPresent: true };
          }
        }
      } catch {
        /* This hint cannot block Settings. */
      }
    }
  }
  return { cursorRulesPresent: false };
}
