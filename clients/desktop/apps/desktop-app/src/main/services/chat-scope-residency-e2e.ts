import { isE2eBuild } from '../lib/e2e-gate';
import type { ChatStateV2Repository } from './chat-state-v2-repository';

interface ChatScopeResidencyInspection {
  list(): ReturnType<ChatStateV2Repository['residencySnapshot']>;
}

declare global {
  // Installed only in E2E builds for performance-scenario inspection.
  var __CANOPY_E2E_CHAT_SCOPE_RESIDENCY__:
    | ChatScopeResidencyInspection
    | undefined;
}

export function installChatScopeResidencyE2eHook(
  repository: ChatStateV2Repository,
): () => void {
  if (!isE2eBuild()) return (): void => undefined;
  const inspection: ChatScopeResidencyInspection = {
    list: () => repository.residencySnapshot(),
  };
  globalThis.__CANOPY_E2E_CHAT_SCOPE_RESIDENCY__ = inspection;
  return (): void => {
    if (globalThis.__CANOPY_E2E_CHAT_SCOPE_RESIDENCY__ === inspection)
      delete globalThis.__CANOPY_E2E_CHAT_SCOPE_RESIDENCY__;
  };
}
