import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreDeferredToolReloads } from '@canopy/core-runtime/node/agent/deferred-tools';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  type ChatUpdatePluginsResponse,
  type DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from '../../__tests__/helpers/chat-state-service-fixture';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { executeLoadDeferredTools } from '../executor';
import {
  deferredToolsReloadCoordinator,
  setDeferredToolReloads,
} from '../reload-coordinator';
import {
  createDesktopDeferredToolReloadHost,
  type DesktopDeferredToolReloadPayload,
} from '../reload-host';

jest.mock('../catalog', () => ({
  buildDeferredToolsCatalog: jest.fn(() => Promise.resolve({})),
  classifyLoadItems: jest.fn(() => ({
    willEnable: [{ ref: 'ref-added', kind: 'plugin', name: 'added' }],
    rejected: [],
    additions: {
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'added' }],
      mcpServerRefs: [],
    },
  })),
  searchDeferredCatalogResult: jest.fn(),
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
}

const scope: DeferredToolsReloadScopeKey = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

describe('deferred-tool reload failure notice (CAN-4127)', () => {
  it('a reload failure notice reaches the canonical transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reload-notice-'));
    const path = join(dir, 'ledger.db');
    const operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(path),
    });
    const fixture: ChatStateServiceFixture = createChatStateServiceFixture();
    resetChatStateServiceForTests(fixture.service);
    const reloads =
      new CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>({
        operations,
        host: createDesktopDeferredToolReloadHost({
          revalidateCatalog: (): Promise<string | null> =>
            Promise.resolve(null),
          readCanonicalTab: (): Promise<{ sdkSessionId: string }> =>
            Promise.resolve({ sdkSessionId: 'sess-1' }),
          readLiveTurnUserMessageId: (): Promise<string> =>
            Promise.resolve('msg-1'),
          applyChatPluginSelectionsUpdate:
            (): Promise<ChatUpdatePluginsResponse> =>
              Promise.reject(new Error('update refused')),
          armContinuation: (): void => undefined,
          ingestChatEvent: (): Promise<void> => Promise.resolve(),
          onTurnCancelled: (): void => undefined,
        }),
      });
    setDeferredToolReloads(reloads);
    try {
      await fixture.createChat(scope);
      await executeLoadDeferredTools(
        { items: [{ ref: 'ref-added' }] },
        { scope, providerType: 'claude' },
        { toolUseId: 'tool-1' },
      );
      deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
      await flush();
      const { tabs } = await fixture.service.getCompatibilityTabs(
        { projectId: scope.projectId, worktreeId: scope.worktreeId },
        { chatIds: [scope.chatId], fullTranscript: true },
      );
      const tab = tabs.find((candidate) => candidate.id === scope.chatId);
      expect(
        tab?.messages.filter(
          (message) =>
            message.role === 'system' &&
            message.blocks.some(
              (block) =>
                block.type === 'text' &&
                block.text === DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
            ),
        ),
      ).toHaveLength(1);
    } finally {
      setDeferredToolReloads(null);
      reloads.close();
      resetChatStateServiceForTests();
      await fixture.dispose();
      operations.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
