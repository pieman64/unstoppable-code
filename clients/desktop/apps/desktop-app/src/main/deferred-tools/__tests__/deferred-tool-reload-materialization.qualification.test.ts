import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoreDeferredToolReloads,
  type DeferredToolReloadMaterializationOutcome,
  type DeferredToolReloadScope,
} from '@canopy/core-runtime/node/agent/deferred-tools';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { pluginEntryId } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatUpdatePluginsResponse,
  type DeferredToolsReloadEvent,
  type DeferredToolsReloadScopeKey,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { executeLoadDeferredTools } from '../executor';
import {
  deferredToolsReloadCoordinator,
  setDeferredToolReloads,
  type DeferredToolsResumeRequest,
} from '../reload-coordinator';
import {
  createDesktopDeferredToolReloadHost,
  type DesktopDeferredToolReloadPayload,
} from '../reload-host';

const addedPlugin = { marketplaceId: 'market', pluginName: 'added' };

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

const chatScope: DeferredToolsReloadScopeKey = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

describe('deferred-tool reloads check the core catalog materialization (CAN-4127)', () => {
  let dir: string;
  let operations: OperationService;
  let reloads: CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>;
  let calls: string[];
  let materializeRequests: Array<{
    scope: DeferredToolReloadScope;
    origin: unknown;
    owner: unknown;
  }>;
  let outcome: DeferredToolReloadMaterializationOutcome;
  let resumes: DeferredToolsResumeRequest[];
  let notices: PersistedChatMessage[];
  let events: DeferredToolsReloadEvent[];
  let cleanups: Array<() => void>;

  function compose(scope: DeferredToolsReloadScopeKey): void {
    reloads = new CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>({
      operations,
      host: createDesktopDeferredToolReloadHost({
        revalidateCatalog: (): Promise<string | null> => Promise.resolve(null),
        readCanonicalTab: (): Promise<{ sdkSessionId: string }> =>
          Promise.resolve({ sdkSessionId: 'sess-1' }),
        readLiveTurnUserMessageId: (): Promise<string> =>
          Promise.resolve('msg-1'),
        applyChatPluginSelectionsUpdate: (
          req,
        ): Promise<ChatUpdatePluginsResponse> => {
          calls.push('update');
          return Promise.resolve({ pluginSelections: req.pluginSelections });
        },
        armContinuation: (): void => undefined,
        ingestChatEvent: (): Promise<void> => Promise.resolve(),
        appendSystemNotice: (_scope, message): Promise<void> => {
          notices.push(message);
          return Promise.resolve();
        },
        onTurnCancelled: (): void => undefined,
      }),
      materializations: {
        materialize: (
          request,
        ): Promise<DeferredToolReloadMaterializationOutcome> => {
          calls.push('materialize');
          materializeRequests.push(request);
          return Promise.resolve(outcome);
        },
      },
    });
    setDeferredToolReloads(reloads);
    cleanups.push(
      deferredToolsReloadCoordinator.registerResumeHandler(
        scope,
        (request): Promise<void> => {
          calls.push('resume');
          resumes.push(request);
          return Promise.resolve();
        },
      ),
      deferredToolsReloadCoordinator.subscribe((event) => events.push(event)),
    );
  }

  async function reload(scope: DeferredToolsReloadScopeKey): Promise<void> {
    await executeLoadDeferredTools(
      { items: [{ ref: 'ref-added' }] },
      { scope, providerType: 'claude' },
      { toolUseId: 'tool-1' },
    );
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reload-materialization-'));
    const path = join(dir, 'ledger.db');
    operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(path),
    });
    calls = [];
    materializeRequests = [];
    resumes = [];
    notices = [];
    events = [];
    cleanups = [];
    outcome = { state: 'ready', materializationId: 'mat-1', unavailable: [] };
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    setDeferredToolReloads(null);
    reloads.close();
    operations.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a reload materializes the chat once through the core catalog', async () => {
    compose(chatScope);
    await reload(chatScope);
    expect(calls).toEqual(['update', 'materialize', 'resume']);
    expect(materializeRequests).toEqual([
      {
        scope: {
          workspaceId: chatScope.projectId,
          worktreeId: chatScope.worktreeId,
          chatId: chatScope.chatId,
        },
        origin: { kind: 'system', sourceId: 'deferred-tools:claude' },
        owner: { kind: 'system', id: 'local-desktop' },
      },
    ]);
    expect(resumes).toHaveLength(1);
    const { items } = await operations.list({
      kinds: ['core.agent.deferredTools.reload'],
      limit: 10,
    });
    expect(items[0]?.outcome).toMatchObject({ materializationId: 'mat-1' });
  });

  it('an enabled entry the materialization lists unavailable fails the reload', async () => {
    outcome = {
      state: 'ready',
      materializationId: 'mat-1',
      unavailable: [{ entryId: pluginEntryId(addedPlugin) }],
    };
    compose(chatScope);
    await reload(chatScope);
    const failures = events.filter((event) => event.error);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error?.outcome).toBe('enable_failed');
    expect(failures[0]?.error?.message).toContain(pluginEntryId(addedPlugin));
    expect(calls).not.toContain('resume');
    expect(notices).toHaveLength(1);
  });

  it('a failed materialization fails the reload closed', async () => {
    outcome = { state: 'failed', materializationId: 'mat-1', unavailable: [] };
    compose(chatScope);
    await reload(chatScope);
    const failures = events.filter((event) => event.error);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toEqual({
      outcome: 'enable_failed',
      message: 'The enabled items could not be materialized for this chat.',
    });
    expect(calls).not.toContain('resume');
    expect(notices).toHaveLength(1);
  });

  it('an App Advisor reload is not materialized', async () => {
    const advisorScope: DeferredToolsReloadScopeKey = {
      ...chatScope,
      projectId: APP_ADVISOR_PROJECT_ID,
    };
    compose(advisorScope);
    await reload(advisorScope);
    expect(calls).toEqual(['update', 'resume']);
    expect(deferredToolsReloadCoordinator.hasActiveReload(advisorScope)).toBe(
      false,
    );
  });
});
