import { readPreferencesFile } from '../../lib/preferences-store';
import { getUserMemoryDir, getWorkspaceMemoryDir } from '../../lib/paths';
import { isTrivialMemoryInput } from '../memory-context';
import { LOCAL_MEMORY_RECALL_BUDGET, renderLocalMemoryRecall } from './render';
import { resolveLocalMemoryPolicy } from './policy';
import {
  readMemoryIndex,
  readRecentInboxNoteEntries,
  type RecentInboxNote,
} from './store';
import { recordUsageSoon } from './usage';

const recentNotesBudget = {
  maxNotes: LOCAL_MEMORY_RECALL_BUDGET.recentNotesPerScope,
  maxCharsPerNote: LOCAL_MEMORY_RECALL_BUDGET.recentNoteChars,
};

type TopicKeyParser = (indexExcerpt: string) => string[];

// The last excerpt parsed per scope and the topics it links. An index rarely
// changes between turns, so a batch of injections parses it once.
const injectedTopicKeys = new Map<
  string,
  { excerpt: string; keys: string[] }
>();

function topicKeysFor(
  scopeDir: string,
  indexExcerpt: string,
  parse: TopicKeyParser,
): string[] {
  const cached = injectedTopicKeys.get(scopeDir);
  if (cached?.excerpt === indexExcerpt) return cached.keys;
  const keys = parse(indexExcerpt);
  injectedTopicKeys.set(scopeDir, { excerpt: indexExcerpt, keys });
  return keys;
}

/**
 * Injection is a use of what it carries: the topics its index lines link,
 * found by the parser the consolidation resolver uses
 * (`referencedTopicFileKeys`), and the inbox notes it quotes. Recorded
 * without waiting, in batches. Parsing the excerpt costs milliseconds per
 * scope, so it runs when the batch is applied, never before the turn starts.
 */
function recordInjectedUsage(
  scopeDir: string,
  indexExcerpt: string,
  notes: RecentInboxNote[],
  parse: TopicKeyParser,
): void {
  recordUsageSoon(
    scopeDir,
    notes.map((note) => note.fileKey),
    indexExcerpt === ''
      ? undefined
      : (): string[] => topicKeysFor(scopeDir, indexExcerpt, parse),
  );
}

export interface PreparedLocalMemory {
  renderedBlock: string;
}

export async function prepareLocalMemoryContext(options: {
  userText: string;
  projectId: string;
  worktreeId: string;
}): Promise<PreparedLocalMemory | null> {
  const preferences = await readPreferencesFile().catch(() => null);
  if (
    !preferences?.localMemoryEnabled ||
    isTrivialMemoryInput(options.userText)
  ) {
    return null;
  }
  // Resolve sentinel-keyed sessions (plan-explore / code-review) to the REAL
  // workspace their memory tools write to; injection and save/search must
  // always read the same directory. A null resolution means the session has
  // no workspace scope — skip workspace memory entirely but keep injecting
  // user-scope memory.
  const policy = await resolveLocalMemoryPolicy({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
  });
  if (policy.kind === 'blocked') return null;
  // Private memory keeps this project's chats away from user-scope memory.
  const userMemoryExcluded = policy.kind === 'scoped' && policy.privateMemory;
  const userDir = getUserMemoryDir();
  const workspaceDir =
    policy.kind === 'scoped' ? getWorkspaceMemoryDir(policy.workspaceId) : null;
  const [userIndex, workspaceIndex, userRecent, workspaceRecent] =
    await Promise.all([
      userMemoryExcluded
        ? Promise.resolve({ text: '', truncated: false })
        : readMemoryIndex(userDir),
      workspaceDir === null
        ? Promise.resolve({ text: '', truncated: false })
        : readMemoryIndex(workspaceDir),
      userMemoryExcluded
        ? Promise.resolve([])
        : readRecentInboxNoteEntries(userDir, recentNotesBudget),
      workspaceDir === null
        ? Promise.resolve([])
        : readRecentInboxNoteEntries(workspaceDir, recentNotesBudget),
    ]);
  const rendered = renderLocalMemoryRecall({
    userIndex,
    workspaceIndex,
    recentNotes: [...userRecent, ...workspaceRecent].map((note) => note.text),
  });
  if (!rendered) return null;
  const injectedUserNotes = userRecent.slice(0, rendered.includedNotes);
  const injectedWorkspaceNotes = workspaceRecent.slice(
    0,
    Math.max(0, rendered.includedNotes - userRecent.length),
  );
  // The Markdown parser stays off Electron's startup import path: it loads
  // on the first injection, and later imports resolve from the cache.
  const { referencedTopicFileKeys } = await import('./topic-reference');
  if (!userMemoryExcluded) {
    recordInjectedUsage(
      userDir,
      rendered.userIndex,
      injectedUserNotes,
      referencedTopicFileKeys,
    );
  }
  if (workspaceDir !== null) {
    recordInjectedUsage(
      workspaceDir,
      rendered.workspaceIndex,
      injectedWorkspaceNotes,
      referencedTopicFileKeys,
    );
  }
  return { renderedBlock: rendered.block };
}
