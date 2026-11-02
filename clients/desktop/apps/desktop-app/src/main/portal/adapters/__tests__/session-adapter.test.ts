import {
  IPC_CHANNELS,
  type PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import { handlePortalSetSectionOrder } from '../session-adapter';
import type { PortalAdapterContext } from '../types';
import { setWorkspaceActivitySectionOrder } from '../../../lib/sidebar-items';
import { sendToWindow } from '../../../lib/window-send';

jest.mock('../../../lib/sidebar-items', () => ({
  setWorkspaceActivitySectionOrder: jest.fn(),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../../portal-state-store', () => ({
  persistPortalViewMode: jest.fn(),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

const mockedSetOrder = jest.mocked(setWorkspaceActivitySectionOrder);
const mockedSendToWindow = jest.mocked(sendToWindow);

type SetSectionOrderCommand = Parameters<typeof handlePortalSetSectionOrder>[0];

function command(
  payload: SetSectionOrderCommand['payload'],
): SetSectionOrderCommand {
  return {
    id: 'cmd-1',
    sequence: 1,
    type: 'portal.workspace.set_section_order',
    payload,
    createdAt: '2026-06-10T00:00:00.000Z',
    expiresAt: null,
  };
}

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    enqueueEvent: (event) => events.push(event),
    getWindow: () => null,
    complete: (cmd, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: cmd.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (cmd, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: cmd.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

describe('session portal adapter — set_section_order id validation (SEC5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a workspaceLocalId that is not a canonical id without touching the store', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalSetSectionOrder(
      command({ workspaceLocalId: '../../etc', order: [] }),
      adapterContext(events),
    );
    const failed = events.find((e) => e.type === 'portal.command.failed');
    expect(failed).toBeDefined();
    expect(
      (failed?.payload as { error: { code: string } } | undefined)?.error.code,
    ).toBe('invalid_payload');
    expect(mockedSetOrder).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('accepts a canonical workspaceLocalId and notifies the desktop renderer', async () => {
    mockedSetOrder.mockResolvedValue(true);
    const events: PortalEventEnvelope[] = [];
    await handlePortalSetSectionOrder(
      command({ workspaceLocalId: 'workspace-1', order: [] }),
      adapterContext(events),
    );
    expect(mockedSetOrder).toHaveBeenCalledWith('workspace-1', []);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: 'workspace-1' },
    );
    expect(events.some((e) => e.type === 'portal.command.completed')).toBe(
      true,
    );
  });

  it('accepts the complete desktop activity section id set', async () => {
    mockedSetOrder.mockResolvedValue(true);
    const events: PortalEventEnvelope[] = [];
    const order = [
      'summary',
      'notes',
      'terminals',
      'prompts',
      'attachments',
      'scripts',
    ];

    await handlePortalSetSectionOrder(
      command({ workspaceLocalId: 'workspace-1', order }),
      adapterContext(events),
    );

    expect(mockedSetOrder).toHaveBeenCalledWith('workspace-1', order);
    expect(
      events.some((event) => event.type === 'portal.command.completed'),
    ).toBe(true);
  });

  it('does not notify the renderer when the project is missing', async () => {
    mockedSetOrder.mockResolvedValue(false);
    const events: PortalEventEnvelope[] = [];
    await handlePortalSetSectionOrder(
      command({ workspaceLocalId: 'missing-ws', order: [] }),
      adapterContext(events),
    );
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'portal.command.failed')).toBe(true);
  });
});
