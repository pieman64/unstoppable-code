import type { PreferencesData } from '@canopy/desktop-shared/types';
import { UninstallInstalledItemRequestSchema } from '@canopy/protocol/installed-items';
import {
  installedItemKey,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';
import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
} from '../../lib/preferences-store';
import {
  createInstalledItemStatusService,
  type InstalledItemRecord,
  type InstalledItemStatusPort,
} from '../installed-item-status-service';
import {
  runSerializedPluginMutation,
  resetPluginMutationQueueForTests,
} from '../../plugins/plugin-mutation-queue';

function fixture(initial: InstalledItemRecord[]): {
  port: InstalledItemStatusPort;
  service: ReturnType<typeof createInstalledItemStatusService>;
  preferences: () => PreferencesData;
} {
  let preferences = normalizePreferences(DEFAULT_PREFERENCES, 'persisted');
  let items = structuredClone(initial);
  const port: InstalledItemStatusPort = {
    readPreferences: () => Promise.resolve(preferences),
    updatePreferences: jest.fn(async (update) => {
      preferences = normalizePreferences(
        { ...preferences, ...(await update(preferences)) },
        'persisted',
      );
      return preferences;
    }),
    list: jest.fn(() => Promise.resolve(items)),
    canonical: (ref) => Promise.resolve(ref),
    serialize: runSerializedPluginMutation,
    setClaudeEnabled: jest.fn((_id, enabled) => {
      items = items.map((item) => ({ ...item, enabled }));
      return Promise.resolve();
    }),
    parkCodex: jest.fn(() => {
      items = items.map((item) => ({ ...item, codex: undefined }));
      return Promise.resolve();
    }),
    restoreCodex: jest.fn(() => {
      items = items.map((item) => ({ ...item, enabled: true }));
      return Promise.resolve();
    }),
    setMcpEnabled: jest.fn((ref, enabled) => {
      items = items.map((item) =>
        installedItemKey(ref) === installedItemKey(item.ref)
          ? { ...item, enabled }
          : item,
      );
      return Promise.resolve();
    }),
    remove: jest.fn((record) => {
      items = items.filter((item) => item !== record);
      return Promise.resolve();
    }),
    removeDeviceServer: jest.fn(() => {
      items = [];
      return Promise.resolve();
    }),
    prune: jest.fn(() => Promise.resolve()),
    publish: jest.fn(() => Promise.resolve()),
  };
  return {
    port,
    service: createInstalledItemStatusService(port),
    preferences: (): PreferencesData => preferences,
  };
}
const pluginRef: InstalledItemRef = {
  kind: 'plugin',
  marketplaceId: 'm',
  pluginName: 'p',
};
const plugin: InstalledItemRecord = {
  ref: pluginRef,
  enabled: true,
  removable: true,
  claudeIds: ['p@M'],
  codex: {
    pluginId: 'actual-provider-id',
    pluginName: 'P',
    marketplacePath: '/source/marketplace.json',
    remoteMarketplaceName: null,
    version: '1',
  },
};

beforeEach(resetPluginMutationQueueForTests);
test('parks only an installed Codex facet after durably persisting recovery and disable intent', async () => {
  const f = fixture([plugin]);
  jest.mocked(f.port.parkCodex).mockImplementationOnce((id) => {
    expect(id).toBe('actual-provider-id');
    expect(f.preferences().disabledInstalledItems).toContain(
      installedItemKey(pluginRef),
    );
    expect(f.preferences().parkedCodexPlugins?.[0]).toMatchObject({
      state: 'parking',
      pluginId: id,
      version: '1',
    });
    return Promise.resolve();
  });
  const outcome = await f.service.setStatus({
    target: pluginRef,
    status: 'disabled',
  });
  expect(outcome.success).toBe(true);
  expect(outcome.snapshot.items[0].status).toBe('disabled');
  expect(f.preferences().parkedCodexPlugins?.[0].state).toBe('parked');
});
test('failed Claude disable retains durable intent, actual state and retry notice', async () => {
  const f = fixture([{ ...plugin, codex: undefined }]);
  jest
    .mocked(f.port.setClaudeEnabled)
    .mockRejectedValueOnce(new Error('offline'));
  const first = await f.service.setStatus({
    target: pluginRef,
    status: 'disabled',
  });
  expect(first.success).toBe(false);
  expect(first.snapshot.items[0].status).toBe('disabled');
  expect(
    first.snapshot.items[0].notices.some(
      (notice) => notice.code === 'provider_pending' && notice.retryable,
    ),
  ).toBe(true);
  const retry = await f.service.setStatus({
    target: pluginRef,
    status: 'disabled',
  });
  expect(retry.success).toBe(true);
  expect(f.port.setClaudeEnabled).toHaveBeenCalledTimes(2);
});

test('a disabled Codex facet cannot hide a failed Claude disable notice', async () => {
  const f = fixture([
    { ...plugin, enabled: false, claudeEnabled: true, codexEnabled: false },
  ]);
  jest
    .mocked(f.port.setClaudeEnabled)
    .mockRejectedValueOnce(new Error('Claude offline'));
  jest
    .mocked(f.port.parkCodex)
    .mockRejectedValueOnce(new Error('Codex offline'));
  const result = await f.service.setStatus({
    target: pluginRef,
    status: 'disabled',
  });
  expect(result.snapshot.items[0].notices).toContainEqual(
    expect.objectContaining({ code: 'provider_pending', provider: 'claude' }),
  );
});
test('failed restoration survives recreation of the service and unchanged-status retry', async () => {
  const f = fixture([plugin]);
  await f.service.setStatus({ target: pluginRef, status: 'disabled' });
  jest
    .mocked(f.port.restoreCodex)
    .mockRejectedValueOnce(new Error('saved version unavailable'));
  const failure = await f.service.setStatus({
    target: pluginRef,
    status: 'active',
  });
  expect(failure.success).toBe(false);
  expect(failure.snapshot.items[0].status).toBe('disabled');
  expect(f.preferences().parkedCodexPlugins?.[0].state).toBe('restoring');
  const restarted = createInstalledItemStatusService(f.port);
  expect(
    (await restarted.setStatus({ target: pluginRef, status: 'active' }))
      .success,
  ).toBe(true);
  expect(f.preferences().parkedCodexPlugins).toEqual([]);
  expect(f.preferences().globalPluginSelections?.pluginRefs).toContainEqual({
    marketplaceId: 'm',
    pluginName: 'p',
  });
});
test('never installs a previously absent provider facet', async () => {
  const f = fixture([{ ...plugin, codex: undefined }]);
  for (const status of ['disabled', 'available', 'active'] as const)
    expect(
      (await f.service.setStatus({ target: pluginRef, status })).success,
    ).toBe(true);
  expect(f.port.restoreCodex).not.toHaveBeenCalled();
  expect(f.port.parkCodex).not.toHaveBeenCalled();
});
test('MCP partial writes report each configuration and recompute the server aggregate', async () => {
  const f = fixture(
    ['a', 'b'].map((configId) => ({
      ref: { kind: 'mcp-config', serverId: 's', configId },
      enabled: true,
      removable: true,
    })),
  );
  jest
    .mocked(f.port.setMcpEnabled)
    .mockRejectedValueOnce(new Error('write failed'));
  const outcome = await f.service.setStatus({
    target: { kind: 'mcp-server', serverId: 's' },
    status: 'disabled',
  });
  expect(outcome.success).toBe(false);
  expect(outcome.errors).toHaveLength(1);
  expect(
    outcome.snapshot.items.find((entry) => entry.target.kind === 'mcp-server')
      ?.status,
  ).toBe('available');
  expect(f.preferences().disabledInstalledItems).toEqual([]);
});
test('external provider disable is Disabled until explicitly enabled', async () => {
  const f = fixture([{ ...plugin, enabled: false, codex: undefined }]);
  expect((await f.service.listStatus()).items[0].status).toBe('disabled');
  expect(
    (await f.service.setStatus({ target: pluginRef, status: 'available' }))
      .snapshot.items[0].status,
  ).toBe('available');
});
test('built-in uninstall is refused in the service; config uninstall is not server authorization', async () => {
  const f = fixture([{ ...plugin, removable: false, reason: 'Bundled' }]);
  expect(
    (await f.service.uninstall({ target: pluginRef })).errors[0],
  ).toMatchObject({ code: 'not_removable', retryable: false });
  expect(f.port.remove).not.toHaveBeenCalled();
  expect(() =>
    UninstallInstalledItemRequestSchema.parse({
      target: { kind: 'mcp-config', serverId: 's', configId: 'c' },
    }),
  ).toThrow();
});
test('failed uninstall preserves references; removal and repeated retries prune safely', async () => {
  const f = fixture([plugin]);
  jest
    .mocked(f.port.remove)
    .mockRejectedValueOnce(new Error('one provider remains'));
  expect((await f.service.uninstall({ target: pluginRef })).success).toBe(
    false,
  );
  expect(f.port.prune).not.toHaveBeenCalled();
  expect((await f.service.uninstall({ target: pluginRef })).success).toBe(true);
  expect((await f.service.uninstall({ target: pluginRef })).success).toBe(true);
  expect(f.port.prune).toHaveBeenCalledTimes(2);
});
test('status and uninstall serialize and composed mutations do not reacquire the queue', async () => {
  const f = fixture([{ ...plugin, codex: undefined }]);
  const order: string[] = [];
  jest.mocked(f.port.setClaudeEnabled).mockImplementationOnce(async () => {
    await runSerializedPluginMutation(() => {
      order.push('status');
      return Promise.resolve();
    });
  });
  jest.mocked(f.port.remove).mockImplementationOnce(() => {
    order.push('uninstall');
    return Promise.resolve();
  });
  await Promise.all([
    f.service.setStatus({ target: pluginRef, status: 'disabled' }),
    f.service.uninstall({ target: pluginRef }),
  ]);
  expect(order).toEqual(['status', 'uninstall']);
});

test('cleanup after deletion is recoverable across service recreation for account refs', async () => {
  const ref: InstalledItemRef = {
    kind: 'account-mcp',
    connectionId: 'account-connection',
  };
  const f = fixture([
    {
      ref,
      enabled: true,
      removable: true,
      selectionRef: { serverId: 'github', configId: 'work' },
    },
  ]);
  jest.mocked(f.port.prune).mockRejectedValueOnce(new Error('disk full'));
  const first = await f.service.uninstall({ target: ref });
  expect(first.success).toBe(false);
  expect(first.snapshot.items[0].status).toBeNull();
  expect(
    f.preferences().pendingInstalledItemUninstalls?.[0].refs,
  ).toContainEqual({
    kind: 'mcp-config',
    serverId: 'github',
    configId: 'work',
  });
  const restarted = createInstalledItemStatusService(f.port);
  expect((await restarted.uninstall({ target: ref })).success).toBe(true);
  expect(jest.mocked(f.port.prune).mock.calls[1][0]).toContainEqual({
    kind: 'mcp-config',
    serverId: 'github',
    configId: 'work',
  });
  expect(f.preferences().pendingInstalledItemUninstalls).toEqual([]);
});

test('normalizes alias disable intent when enabling the canonical installed item', async () => {
  const f = fixture([{ ...plugin, codex: undefined }]);
  f.port.canonical = (ref): Promise<InstalledItemRef> =>
    Promise.resolve(
      ref.kind === 'plugin' && ref.marketplaceId === 'Alias'
        ? { ...ref, marketplaceId: 'm' }
        : ref,
    );
  await f.port.updatePreferences(() => ({
    disabledInstalledItems: [
      installedItemKey({
        kind: 'plugin',
        marketplaceId: 'Alias',
        pluginName: 'P',
      }),
    ],
  }));
  expect((await f.service.listStatus()).items[0].status).toBe('disabled');
  expect(
    (await f.service.setStatus({ target: pluginRef, status: 'active' }))
      .success,
  ).toBe(true);
  expect(f.preferences().disabledInstalledItems).toEqual([]);
});

test('failed provider reads never become Available, including after a committed mutation', async () => {
  const f = fixture([{ ...plugin, codex: undefined }]);
  jest
    .mocked(f.port.list)
    .mockResolvedValueOnce([{ ...plugin, codex: undefined }])
    .mockRejectedValueOnce(new Error('provider unavailable'));
  const outcome = await f.service.setStatus({
    target: pluginRef,
    status: 'disabled',
  });
  expect(outcome.success).toBe(false);
  expect(outcome.snapshot.items[0].status).toBeNull();
  expect(outcome.errors[0].code).toBe('state_unavailable');
});

test('empty device servers have no derived status and remain explicitly removable', async () => {
  const f = fixture([]);
  f.port.deviceServerIds = (): readonly string[] => ['empty'];
  const snapshot = await f.service.listStatus();
  expect(snapshot.items[0]).toMatchObject({
    target: { kind: 'mcp-server', serverId: 'empty' },
    status: null,
    removable: true,
  });
});

test('catalog refresh failure preserves the effective outcome and remains retryable', async () => {
  const f = fixture([{ ...plugin, codex: undefined }]);
  jest
    .mocked(f.port.publish)
    .mockRejectedValueOnce(new Error('refresh failed'));
  const result = await f.service.setStatus({
    target: pluginRef,
    status: 'disabled',
  });
  expect(result.success).toBe(false);
  expect(result.snapshot.items[0].status).toBe('disabled');
  expect(result.errors).toContainEqual(
    expect.objectContaining({ code: 'refresh_failed', retryable: true }),
  );
});
