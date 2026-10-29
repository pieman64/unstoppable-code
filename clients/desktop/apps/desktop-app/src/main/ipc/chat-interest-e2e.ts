import type { ChatInterestDeclaration } from '@canopy/desktop-shared/types';
import { isE2eBuild } from '../lib/e2e-gate';
import type { ChatStateSubscriptions } from './chat-state-delivery';

interface InterestSubscriber {
  id: number;
  isDestroyed(): boolean;
}

interface ChatInterestInspection {
  list(): Array<{ webContentsId: number; interest: ChatInterestDeclaration }>;
}

declare global {
  // Installed only in E2E builds for Electron flow inspection.
  var __CANOPY_E2E_CHAT_INTEREST__: ChatInterestInspection | undefined;
}

export function installChatInterestE2eHook(
  subscriptions: ChatStateSubscriptions<InterestSubscriber>,
): () => void {
  if (!isE2eBuild()) return (): void => undefined;
  const inspection: ChatInterestInspection = {
    list: () =>
      subscriptions
        .interestEntries()
        .filter(([subscriber]) => !subscriber.isDestroyed())
        .map(([subscriber, interest]) => ({
          webContentsId: subscriber.id,
          interest,
        })),
  };
  globalThis.__CANOPY_E2E_CHAT_INTEREST__ = inspection;
  return (): void => {
    if (globalThis.__CANOPY_E2E_CHAT_INTEREST__ === inspection)
      delete globalThis.__CANOPY_E2E_CHAT_INTEREST__;
  };
}
