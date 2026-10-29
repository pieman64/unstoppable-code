import type { ChatModel } from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { isModelBlockedByStoredPolicy } from '../../lib/model-policy-state';
import { resolveHelperWorkOwner } from '../../ollama/helper-invocation';

/**
 * Whether the stored organization model policy blocks `model` for local
 * memory work in a scope. The work owner is the scope's workspace, or the
 * default owner for the user scope. This is the one check every memory
 * helper run makes before it dispatches, and the check a rebuild or manual
 * run makes before it changes or queues anything, so they cannot disagree.
 * A background caller that already knows its owner passes it in `owner`,
 * so the check never consults live navigation.
 */
export async function isLocalMemoryModelBlockedByPolicy(
  model: ChatModel,
  workspaceId?: string,
  owner?: { workOwner: WorkOwner | null },
): Promise<boolean> {
  const workOwner = await resolveHelperWorkOwner({
    ...(workspaceId ? { workspaceId } : {}),
    ...(owner ? { workOwner: owner.workOwner } : {}),
  });
  return isModelBlockedByStoredPolicy(model, workOwner);
}
