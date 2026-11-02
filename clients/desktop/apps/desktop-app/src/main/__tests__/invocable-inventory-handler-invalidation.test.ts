jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplaces: jest.fn(),
  refreshMarketplaces: jest.fn(),
  addMarketplace: jest.fn(),
  updateMarketplace: jest.fn(),
  removeMarketplace: jest.fn(),
  readComponentContent: jest.fn(),
  installPlugin: jest.fn(),
  prepareCodexCompatibilityPlugin: jest.fn(),
  setCodexCompatDisabled: jest.fn(),
  installBuiltInPlugin: jest.fn(),
}));
jest.mock('../skills/skill-service', () => ({
  loadSkills: jest.fn(),
  fetchAvailable: jest.fn(),
  installSkills: jest.fn(),
  removeSkillForContext: jest.fn(),
  updateSkill: jest.fn(),
  checkUpdates: jest.fn(),
  readSkillContent: jest.fn(),
  saveCustomSkill: jest.fn(),
  readRawSkill: jest.fn(),
  writeRawSkill: jest.fn(),
  writeRawSkillForContext: jest.fn(),
}));
jest.mock('../canopy-cloud/client', () => ({
  assertCanopyCloudCapability: jest.fn(),
}));
jest.mock('../skills/canopy-server-client', () => ({
  createSharedSkill: jest.fn(),
  deleteSharedSkill: jest.fn(),
  getSharedSkill: jest.fn(),
  listSharedSkills: jest.fn(),
  updateSharedSkill: jest.fn(),
}));

import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import type { IpcMainInvokeEvent } from 'electron';
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import { registerIpcHandler } from '../ipc/register';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import { registerPluginHandlers } from '../plugins/plugin-handlers';
import * as pluginService from '../plugins/plugin-service';
import { registerSkillHandlers } from '../skills/skill-handlers';
import * as skillService from '../skills/skill-service';

const registerIpcHandlerMock = jest.mocked(registerIpcHandler);
const refreshInvocableInventoryAfterMutationMock = jest.mocked(
  refreshInvocableInventoryAfterMutation,
);
type InvocableIpcHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

describe('invocable inventory mutation invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refreshes inventory after successful plugin mutations only', async () => {
    const handlers = new Map<string, InvocableIpcHandler>();
    registerIpcHandlerMock.mockImplementation(
      (channel, handler: InvocableIpcHandler): void => {
        handlers.set(channel, handler);
      },
    );
    jest
      .mocked(pluginService.installPlugin)
      .mockResolvedValueOnce({ success: true, data: pluginResult() })
      .mockResolvedValueOnce({ success: false, error: 'failed' });

    registerPluginHandlers();

    const handler = handlers.get(PLUGINS_CHANNELS.INSTALL_PLUGIN);
    expect(handler).toBeDefined();
    await handler?.(
      ipcEvent(),
      'market',
      'plugin',
      'https://example.test/repo',
    );
    expect(refreshInvocableInventoryAfterMutationMock).toHaveBeenCalledWith(
      'plugins:install-plugin',
    );

    refreshInvocableInventoryAfterMutationMock.mockClear();
    await handler?.(
      ipcEvent(),
      'market',
      'plugin',
      'https://example.test/repo',
    );
    expect(refreshInvocableInventoryAfterMutationMock).not.toHaveBeenCalled();
  });

  it('forces provider updates only when the caller asks for them', async () => {
    const handlers = new Map<string, InvocableIpcHandler>();
    registerIpcHandlerMock.mockImplementation(
      (channel, handler: InvocableIpcHandler): void => {
        handlers.set(channel, handler);
      },
    );
    jest.mocked(pluginService.refreshMarketplaces).mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });

    registerPluginHandlers();

    // A deliberate user gesture (Refresh button, invalid-marketplace Retry)
    // opts in explicitly and bypasses the 24h TTL.
    await handlers.get(PLUGINS_CHANNELS.REFRESH)?.(ipcEvent(), 'always');
    expect(pluginService.refreshMarketplaces).toHaveBeenLastCalledWith(
      expect.any(Function),
      { providerUpdates: 'always' },
    );

    // Incidental callers must NOT. `PipelineTriggerModal` refreshes catalogs
    // on the window `focus` event, so pinning 'always' on the handler made
    // every alt-tab force a full provider recheck and defeated the TTL.
    await handlers.get(PLUGINS_CHANNELS.REFRESH)?.(ipcEvent());
    expect(pluginService.refreshMarketplaces).toHaveBeenLastCalledWith(
      expect.any(Function),
      { providerUpdates: 'if-stale' },
    );

    // An unexpected value must not be forwarded as an opt-in.
    await handlers.get(PLUGINS_CHANNELS.REFRESH)?.(ipcEvent(), 'bogus');
    expect(pluginService.refreshMarketplaces).toHaveBeenLastCalledWith(
      expect.any(Function),
      { providerUpdates: 'if-stale' },
    );
  });

  it('refreshes inventory after successful skill mutations only', async () => {
    const handlers = new Map<string, InvocableIpcHandler>();
    registerIpcHandlerMock.mockImplementation(
      (channel, handler: InvocableIpcHandler): void => {
        handlers.set(channel, handler);
      },
    );
    jest
      .mocked(skillService.removeSkillForContext)
      .mockResolvedValueOnce({ success: true, data: undefined })
      .mockResolvedValueOnce({ success: false, error: 'failed' });

    registerSkillHandlers();

    const handler = handlers.get(SKILLS_CHANNELS.REMOVE);
    expect(handler).toBeDefined();
    await handler?.(ipcEvent(), 'source-a', 'skill-a');
    expect(refreshInvocableInventoryAfterMutationMock).toHaveBeenCalledWith(
      'skills:remove',
    );

    refreshInvocableInventoryAfterMutationMock.mockClear();
    await handler?.(ipcEvent(), 'source-a', 'skill-a');
    expect(refreshInvocableInventoryAfterMutationMock).not.toHaveBeenCalled();
  });

  it('preserves write-raw response shape while refreshing after success', async () => {
    const handlers = new Map<string, InvocableIpcHandler>();
    registerIpcHandlerMock.mockImplementation(
      (channel, handler: InvocableIpcHandler): void => {
        handlers.set(channel, handler);
      },
    );
    jest.mocked(skillService.writeRawSkillForContext).mockResolvedValue({
      skillId: 'custom/raw-skill',
      skillName: 'raw-skill',
    });

    registerSkillHandlers();

    const handler = handlers.get(SKILLS_CHANNELS.WRITE_RAW);
    expect(handler).toBeDefined();
    const result = await handler?.(ipcEvent(), {
      skillName: 'raw-skill',
      rawSkill: '---\nname: raw-skill\n---\n',
    });

    expect(result).toEqual({
      skillId: 'custom/raw-skill',
      skillName: 'raw-skill',
    });
    expect(refreshInvocableInventoryAfterMutationMock).toHaveBeenCalledWith(
      'skills:write-raw',
    );
  });
});

function ipcEvent(): IpcMainInvokeEvent {
  const event: Partial<IpcMainInvokeEvent> = {};
  Reflect.set(event, 'sender', { send: jest.fn() });
  // Mutation handlers in this suite only inspect sender.send, not Electron's
  // remaining invoke-event fields.
  return event as IpcMainInvokeEvent;
}

function pluginResult(): PluginInfo {
  return {
    name: 'plugin',
    sourcePath: '',
    marketplaceId: 'market',
    providerSupport: { claude: 'native' as const, codex: 'none' as const },
    facets: {},
  };
}
