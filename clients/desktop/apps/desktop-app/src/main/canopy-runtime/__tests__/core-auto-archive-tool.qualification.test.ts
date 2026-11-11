import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from '../../__tests__/helpers/chat-state-service-fixture';
import {
  observeTurn,
  turnStarted,
} from '../../__tests__/helpers/turn-lifecycle-events';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolRuntime,
} from '../../canopy-tools/core';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { AGENT_AUTO_ARCHIVE_PRINCIPAL_ID } from '../auto-archive-principal-guard';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const mockState = { runtime: null as DesktopCanopyDispatcher | null };
jest.mock('../desktop-runtime', () => ({
  ...jest.requireActual<Record<string, unknown>>('../desktop-runtime'),
  getActiveDesktopRuntime: (): unknown => mockState.runtime,
}));

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };
const CALLER: CanopyCallerDescriptor = {
  principalId: AGENT_AUTO_ARCHIVE_PRINCIPAL_ID,
  clientInstanceId: 'desktop-main',
  authorityId: 'local',
  interfaceKind: 'mcp',
  grants: ['core.chat.write'],
};

let fixture: ChatStateServiceFixture;
let ledgerDir: string;
let sequence = 0;

function session(chatId = 'chat-1'): CanopyInjectedToolRuntime {
  return {
    autoArchiveChat: { ...SCOPE, chatId },
  } as CanopyInjectedToolRuntime;
}

async function owner(chatId = 'chat-1'): Promise<string | undefined> {
  const snapshot = await fixture.service.getState(SCOPE);
  return snapshot.tabsFile.tabs.find((tab) => tab.id === chatId)
    ?.autoArchiveTurnId;
}

async function markers(): Promise<Record<string, boolean>> {
  const snapshot = await fixture.service.getState(SCOPE);
  return Object.fromEntries(
    snapshot.tabsFile.tabs.map((tab) => [tab.id, tab.autoArchive === true]),
  );
}

function update(action: Record<string, unknown>): Promise<unknown> {
  const runtime = mockState.runtime;
  if (!runtime) throw new Error('no runtime');
  const commandId = `guard-${(sequence += 1)}`;
  return runtime.instruction(
    'core.chat.update',
    {
      ...SCOPE,
      commandId,
      action: action as never,
      _meta: { idempotencyKey: commandId },
    },
    { caller: CALLER, metadata: { idempotencyKey: commandId } },
  );
}

beforeEach(async () => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'auto-archive-tool-'));
  fixture = createChatStateServiceFixture();
  resetChatStateServiceForTests(fixture.service);
  setChatStateCommandPort(fixture.service);
  mockState.runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(ledgerDir, 'ledger.sqlite'),
    }),
    chatCommandPort: fixture.service,
    shutdownTimeoutMs: 25,
  });
  await fixture.createChat(SCOPE);
  const created = await fixture.service.command({
    schemaVersion: 1,
    commandId: 'create-2',
    ...SCOPE,
    command: {
      type: 'chat.create_tab',
      tabId: 'chat-2',
      title: 'Other',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    },
  });
  expect(created.outcome).toBe('applied');
});

afterEach(async () => {
  setChatStateCommandPort(null);
  await mockState.runtime?.shutdown();
  mockState.runtime = null;
  await fixture.dispose();
  rmSync(ledgerDir, { recursive: true, force: true });
});

describe('SetChatAutoArchive through core.chat.update (CAN-6014)', () => {
  it("sets and clears only the session's own chat; a chat or tab in tool input is refused", async () => {
    await expect(
      executeCanopyInjectedTool(
        'set_auto_archive',
        { enabled: true, chatId: 'chat-2', tabId: 'chat-2' },
        session(),
      ),
    ).resolves.toEqual({
      text: 'Invalid arguments for SetChatAutoArchive.',
      isError: true,
    });
    expect(await markers()).toEqual({ 'chat-1': false, 'chat-2': false });
    const enabled = await executeCanopyInjectedTool(
      'set_auto_archive',
      { enabled: true },
      session(),
    );
    expect(enabled.text).toContain('Auto-archive is enabled');
    expect(await markers()).toEqual({ 'chat-1': true, 'chat-2': false });
    await executeCanopyInjectedTool(
      'set_auto_archive',
      { enabled: false },
      session(),
    );
    expect(await markers()).toEqual({ 'chat-1': false, 'chat-2': false });
  });

  it('a chat without a session chat cannot use it', async () => {
    await expect(
      executeCanopyInjectedTool(
        'set_auto_archive',
        { enabled: true },
        {} as CanopyInjectedToolRuntime,
      ),
    ).resolves.toEqual({
      text: 'SetChatAutoArchive is only available for chats.',
      isError: true,
    });
    expect(await markers()).toEqual({ 'chat-1': false, 'chat-2': false });
  });

  it('the principal may set only autoArchive: any other action or setting is refused', async () => {
    for (const action of [
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive: true, title: 'Renamed' },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { customTitle: 'Renamed' },
      },
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive: true },
        expectedPluginSelections: {},
      },
      { type: 'chat.activate_tab', tabId: 'chat-2' },
      { type: 'chat.mark_read', chatId: 'chat-2' },
      {
        type: 'chat.set_approval_mode',
        tabId: 'chat-1',
        approvalMode: 'full-access',
      },
    ])
      await expect(update(action)).rejects.toMatchObject({
        payload: { kind: 'permission_denied' },
      });
    // The owning turn is main's to record: core.chat.update's schema has no
    // such setting.
    await expect(
      update({
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive: true, autoArchiveTurnId: 'turn-9' },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(await markers()).toEqual({ 'chat-1': false, 'chat-2': false });
    await expect(
      update({
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { autoArchive: true },
      }),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(await markers()).toEqual({ 'chat-1': true, 'chat-2': false });
  });

  it('main records the turn running when the tool sets the marker; the tool never names one', async () => {
    await observeTurn(
      fixture.service,
      turnStarted(
        { ...SCOPE, chatId: 'chat-1' },
        { turnId: 'turn-1', sequence: 1, atMs: 1 },
      ),
    );
    await executeCanopyInjectedTool(
      'set_auto_archive',
      { enabled: true },
      session(),
    );
    expect(await owner()).toBe('turn-1');
    await executeCanopyInjectedTool(
      'set_auto_archive',
      { enabled: false },
      session(),
    );
    expect(await owner()).toBeUndefined();
    await expect(
      executeCanopyInjectedTool(
        'set_auto_archive',
        { enabled: true, autoArchiveTurnId: 'turn-9' },
        session(),
      ),
    ).resolves.toEqual({
      text: 'Invalid arguments for SetChatAutoArchive.',
      isError: true,
    });
    expect(await markers()).toEqual({ 'chat-1': false, 'chat-2': false });
  });

  it('a keyed retry patches once', async () => {
    const call = { toolUseId: 't1', invocationId: 'claude:toolu_1' };
    await executeCanopyInjectedTool(
      'set_auto_archive',
      { enabled: true },
      session(),
      call,
    );
    await executeCanopyInjectedTool(
      'set_auto_archive',
      { enabled: true },
      session(),
      call,
    );
    expect(await markers()).toEqual({ 'chat-1': true, 'chat-2': false });
  });
});
