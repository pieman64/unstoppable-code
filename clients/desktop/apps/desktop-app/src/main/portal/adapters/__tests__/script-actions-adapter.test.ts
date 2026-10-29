/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect mocked adapter methods without invoking them. */
import type { ScriptActionsSnapshot } from '@canopy/protocol/script-actions';
import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import type { PortalAdapterContext } from '../types';
import { createPortalScriptActionsAdapter } from '../script-actions-adapter';
import { scriptActionsService } from '../../../services/script-actions-host';
jest.mock('../../../services/script-actions-host', () => ({
  scriptActionsService: { list: jest.fn() },
}));
const command: PortalCommandEnvelope = {
  id: 'command',
  sequence: 1,
  type: 'portal.script_actions.list',
  payload: { projectId: 'project', worktreeId: 'tree' },
  target: { workspaceLocalId: 'project', worktreeLocalId: 'tree' },
  createdAt: '2026-10-21T00:00:00Z',
  expiresAt: null,
};
const snapshot: ScriptActionsSnapshot = {
  actions: [],
  pendingCount: 0,
  shellAliasScanEnabled: false,
  scanStatus: 'complete',
  scannedAt: null,
  diagnostics: [],
};
const context: PortalAdapterContext = {
  sessionId: 'session',
  getWindow: () => null,
  enqueueEvent: jest.fn(),
  complete: jest.fn(),
  fail: jest.fn(),
};
beforeEach(() => {
  jest.clearAllMocks();
});
it('requires payload scope to match the authenticated routing target', async () => {
  await createPortalScriptActionsAdapter('list')(
    {
      ...command,
      target: { workspaceLocalId: 'other', worktreeLocalId: 'tree' },
    },
    context,
  );
  expect(context.fail).toHaveBeenCalledWith(
    expect.anything(),
    'invalid_target',
    expect.any(String),
  );
  expect(scriptActionsService.list).not.toHaveBeenCalled();
});
it('validates both request and response shapes', async () => {
  await createPortalScriptActionsAdapter('list')(
    { ...command, payload: { projectId: '../private', worktreeId: 'tree' } },
    context,
  );
  expect(context.fail).toHaveBeenCalledWith(
    expect.anything(),
    'invalid_payload',
    expect.any(String),
  );
  jest.mocked(scriptActionsService.list).mockResolvedValue(snapshot);
  await createPortalScriptActionsAdapter('list')(command, context);
  expect(context.complete).toHaveBeenCalledWith(command, snapshot);
});
