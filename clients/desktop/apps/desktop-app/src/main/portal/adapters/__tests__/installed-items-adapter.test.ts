import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import {
  PORTAL_LONG_RPC_COMMAND_TYPES,
  PORTAL_SMALL_RPC_COMMAND_TYPES,
  PORTAL_DESTRUCTIVE_COMMAND_TYPES,
} from '@canopy/protocol/portal';
import type { PortalAdapterContext } from '../types';
import { handlePortalInstalledItems } from '../installed-items-adapter';
import { installedItemService } from '../../../installed-items/installed-item-service';
jest.mock('../../../installed-items/installed-item-service', () => ({
  installedItemService: {
    listStatus: jest.fn(),
    setStatus: jest.fn(),
    uninstall: jest.fn(),
  },
}));

const complete = jest.fn();
const fail = jest.fn();
const context: PortalAdapterContext = {
  getWindow: () => null,
  enqueueEvent: jest.fn(),
  complete,
  fail,
};
function command(
  type: PortalCommandEnvelope['type'],
  payload: unknown,
): PortalCommandEnvelope {
  return {
    id: 'command',
    sequence: 1,
    type,
    payload,
    target: { workspaceLocalId: 'workspace' },
    createdAt: '2026-10-20T00:00:00Z',
    expiresAt: null,
  };
}
beforeEach(() => jest.clearAllMocks());
test('validates project identity and strict mutation shapes before accessing a service', async () => {
  await handlePortalInstalledItems(
    command('portal.installed_items.list_status', { projectId: 'other' }),
    context,
  );
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'invalid_target',
    expect.any(String),
  );
  await handlePortalInstalledItems(
    command('portal.installed_items.set_status', {
      projectId: 'workspace',
      target: { kind: 'collection', collectionId: 'id' },
      status: 'disabled',
      path: '/tmp',
    }),
    context,
  );
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'invalid_payload',
    expect.any(String),
  );
  expect(installedItemService.setStatus).not.toHaveBeenCalled();
});
test('slow status writes leave the command loop free and complete with the service outcome', async () => {
  let finish: (() => void) | undefined;
  const outcome = {
    success: true,
    snapshot: { items: [] },
    errors: [],
    removed: [],
  };
  jest.mocked(installedItemService.setStatus).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = (): void => resolve(outcome);
      }),
  );
  await handlePortalInstalledItems(
    command('portal.installed_items.set_status', {
      projectId: 'workspace',
      target: { kind: 'collection', collectionId: 'id' },
      status: 'disabled',
    }),
    context,
  );
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  if (!finish) throw new Error('Service did not start');
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(complete).toHaveBeenCalledWith(expect.anything(), outcome);
});
test('configuration uninstall cannot delete a server and provider outages stay retryable', async () => {
  await handlePortalInstalledItems(
    command('portal.installed_items.uninstall', {
      projectId: 'workspace',
      target: { kind: 'mcp-config', serverId: 'id', configId: 'config' },
    }),
    context,
  );
  expect(installedItemService.uninstall).not.toHaveBeenCalled();
  jest
    .mocked(installedItemService.listStatus)
    .mockRejectedValueOnce(new Error('offline'));
  await handlePortalInstalledItems(
    command('portal.installed_items.list_status', { projectId: 'workspace' }),
    context,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'execution_failed',
    expect.any(String),
    true,
  );
});
test('all provider-dependent operations are long RPCs; uninstall follows destructive-command policy', () => {
  for (const type of [
    'portal.installed_items.list_status',
    'portal.installed_items.set_status',
    'portal.installed_items.uninstall',
  ] as const) {
    expect(PORTAL_LONG_RPC_COMMAND_TYPES.has(type)).toBe(true);
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(type)).toBe(false);
  }
  expect(
    PORTAL_DESTRUCTIVE_COMMAND_TYPES.has('portal.installed_items.uninstall'),
  ).toBe(true);
});
