import type { ExternalProjectCandidate } from '@canopy/desktop-shared/types';
import { isPathInside } from '../lib/path-safety';
import type {
  ChatHistoryChatInput,
  ChatHistoryProfileInput,
  ChatHistoryProjectInput,
} from '../memory/local/chat-history-profile';
import type { DiscoveredRoot, DiscoveredSession } from './types';

function sessionKey(session: DiscoveredSession): string {
  return `${session.provider}:${session.id}`;
}

function projectsWithHistory(
  candidates: readonly ExternalProjectCandidate[],
  sessionsByCandidate: ReadonlyMap<string, readonly DiscoveredSession[]>,
  privateRoots: readonly string[],
): {
  projects: ChatHistoryProjectInput[];
  projectBySession: Map<string, string>;
} {
  const projects: ChatHistoryProjectInput[] = [];
  const projectBySession = new Map<string, string>();
  for (const candidate of candidates) {
    const candidatePaths = [
      candidate.rootPath,
      ...candidate.linkedWorktreePaths,
      ...(sessionsByCandidate.get(candidate.id) ?? []).map(
        (session) => session.cwd,
      ),
    ];
    if (
      privateRoots.some((root) =>
        candidatePaths.some(
          (candidatePath) =>
            isPathInside(root, candidatePath) ||
            isPathInside(candidatePath, root),
        ),
      )
    )
      continue;
    // A folder picked by hand carries no provider history, and one whose
    // only sessions were SDK-driven has no chats of the user's own.
    // `sessionCount` counts native chats, including those of a folder that
    // no longer exists (which the scan keeps no sessions for).
    if (candidate.providers.length === 0 || candidate.sessionCount === 0) {
      continue;
    }
    projects.push({
      name: candidate.displayName,
      chatCount: candidate.sessionCount,
    });
    for (const session of sessionsByCandidate.get(candidate.id) ?? []) {
      if (!projectBySession.has(sessionKey(session))) {
        projectBySession.set(sessionKey(session), candidate.displayName);
      }
    }
  }
  return { projects, projectBySession };
}

/**
 * What a scan says about the person who ran it (CAN-3079): the titles of
 * every native chat the adapters found, including chats in folders that are
 * not importable projects such as the home directory, and the names of the
 * projects with provider evidence. Chats the app ran itself (under its data
 * directories) and SDK-driven sessions are left out.
 */
export function collectChatHistoryProfileInput(options: {
  roots: readonly DiscoveredRoot[];
  candidates: readonly ExternalProjectCandidate[];
  sessionsByCandidate: ReadonlyMap<string, readonly DiscoveredSession[]>;
  excludedRoots: readonly string[];
  privateRoots?: readonly string[];
}): ChatHistoryProfileInput {
  const { projects, projectBySession } = projectsWithHistory(
    options.candidates,
    options.sessionsByCandidate,
    options.privateRoots ?? [],
  );
  const chats: ChatHistoryChatInput[] = [];
  const seen = new Set<string>();
  const sessions = options.roots.flatMap((root) => root.sessions);
  for (const session of sessions) {
    const key = sessionKey(session);
    if (!session.native || !session.title || seen.has(key)) continue;
    // Platform-aware containment: Windows paths compare case-insensitively.
    if (options.excludedRoots.some((root) => isPathInside(root, session.cwd))) {
      continue;
    }
    if (
      options.privateRoots?.some(
        (root) =>
          isPathInside(root, session.cwd) || isPathInside(session.cwd, root),
      )
    )
      continue;
    seen.add(key);
    const project = projectBySession.get(key);
    chats.push({
      title: session.title,
      ...(project ? { project } : {}),
      lastActivityAt: session.lastActivityAt ?? session.startedAt,
    });
  }
  return { projects, chats };
}
