import {
  IPC_CHANNELS,
  type ChatSearchCatalogRequest,
  type ChatSearchCatalogResponse,
  type ChatSearchQueryRequest,
  type ChatSearchQueryResponse,
  type ChatSearchScopeHint,
} from '@canopy/desktop-shared/types';
import { getChatSearchService } from '../chat-search/service';
import { addTrackedPlansWriteListener } from '../lib/plan-persistence';
import { getWorkspaceScopingContext } from '../lib/workspace-context-service';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

function linkedPersonalWorkspaceIds(
  scope: ChatSearchScopeHint | undefined,
): string[] {
  if (!Array.isArray(scope?.linkedPersonalWorkspaceIds)) return [];
  return scope.linkedPersonalWorkspaceIds
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(0, 2_000);
}

function isValidChatId(id: unknown): id is string {
  try {
    validateId(id, 'chat ID');
    return true;
  } catch {
    return false;
  }
}

/** The chats a catalog request asks for, or undefined for the newest page. */
function requestedChatIds(
  request: ChatSearchCatalogRequest | undefined,
): string[] | undefined {
  if (!Array.isArray(request?.chatIds)) return undefined;
  // Ids that fail the shared validator can't name a chat; drop them.
  return request.chatIds.filter(isValidChatId).slice(0, 500);
}

/**
 * Cmd+K unified fuzzy search — main-process transport handlers.
 *
 * The `registerIpcHandler` generics pin the channel signatures while the
 * service owns the rebuildable SQLite catalog and FTS5 query behavior:
 *
 * - {@link IPC_CHANNELS.chatSearchCatalog} (tier 1) — fetched once per palette
 *   open; will return the most-recent ~2000 `chat_docs` rows (minus `body`)
 *   ordered by `updatedAt`.
 * - {@link IPC_CHANNELS.chatSearchQuery} (tier 2) — debounced per settled query;
 *   accepts a raw user string (`ChatSearchQueryRequest`) that the backend
 *   sanitizes into safe FTS5 tokens, returning snippets + integer highlight
 *   ranges.
 */
export function registerChatSearchHandlers(): void {
  registerIpcHandler<[ChatSearchCatalogRequest?], ChatSearchCatalogResponse>(
    IPC_CHANNELS.chatSearchCatalog,
    async (_event, scope) => {
      const service = getChatSearchService();
      // Deliberately not awaited: the first palette open returns the current
      // catalog immediately while the disk walk yields between source files.
      service.ensureInitialScan();
      return {
        entries: await service.getCatalogScoped(
          getWorkspaceScopingContext(),
          undefined,
          linkedPersonalWorkspaceIds(scope),
          requestedChatIds(scope),
        ),
      };
    },
  );

  registerIpcHandler<[ChatSearchQueryRequest], ChatSearchQueryResponse>(
    IPC_CHANNELS.chatSearchQuery,
    async (_event, request) => ({
      results: await getChatSearchService().queryResponsive(
        request,
        getWorkspaceScopingContext(),
        linkedPersonalWorkspaceIds(request),
      ),
    }),
  );

  // Tracked plans reach the index through the persistence write hook rather
  // than per-caller IPC hooks: every mutation path (create/update/delete,
  // imports, pipeline plan_ready, comment/share updates) funnels through the
  // single tracked-plans file writer.
  addTrackedPlansWriteListener((projectId, worktreeId, file) => {
    getChatSearchService().indexWorktreePlans(
      projectId,
      worktreeId,
      file.plans,
    );
  });
}
