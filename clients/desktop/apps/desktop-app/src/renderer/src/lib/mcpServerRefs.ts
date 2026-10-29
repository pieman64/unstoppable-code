import type {
  RewriteMcpServerRefsRequest,
  RewriteMcpServerRefsResponse,
} from '@canopy/desktop-shared/types/mcp-servers';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * Points saved defaults and chats at the moved server, then reloads projects.
 * With `retire`, main also removes that device server in the same step, but
 * only while it still matches the fingerprint.
 */
export async function pointRefsAt(
  from: RewriteMcpServerRefsRequest['from'],
  to: RewriteMcpServerRefsRequest['to'],
  retire?: RewriteMcpServerRefsRequest['retire'],
): Promise<RewriteMcpServerRefsResponse> {
  const result = await window.mcpServers.rewriteServerRefs({
    from,
    to,
    ...(retire ? { retire } : {}),
  });
  try {
    await useProjectsStore.getState().loadProjects({ silent: true });
  } catch {
    // The defaults are saved; only the project list behind the page is stale.
  }
  return result;
}
