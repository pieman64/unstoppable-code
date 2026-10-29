import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  createPlan,
  deletePlan,
  updatePlan,
} from '../../../services/plans-service';
import {
  handlePortalPlanCreate,
  handlePortalPlanDelete,
  handlePortalPlanUpdate,
} from '../plans-adapter';
import type { PortalAdapterContext } from '../types';

jest.mock('../../../services/plans-service', () => ({
  createPlan: jest.fn(),
  deletePlan: jest.fn(),
  listPlans: jest.fn(),
  readPlan: jest.fn(),
  updatePlan: jest.fn(),
}));

const mockedCreatePlan = jest.mocked(createPlan);
const mockedUpdatePlan = jest.mocked(updatePlan);
const mockedDeletePlan = jest.mocked(deletePlan);

function command(
  type: PortalCommandEnvelope['type'],
  payload: unknown,
): PortalCommandEnvelope {
  return {
    id: 'command-1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-09-19T00:00:00.000Z',
    expiresAt: null,
  };
}

function adapterContext(): PortalAdapterContext & {
  events: PortalEventEnvelope[];
} {
  const events: PortalEventEnvelope[] = [];
  return {
    events,
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (source, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: source.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: jest.fn(),
  };
}

describe('plans portal adapter renderer notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the renderer window through create, update, and delete', async () => {
    const context = adapterContext();
    const base = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
    mockedCreatePlan.mockResolvedValue({ planId: 'plan-1' } as never);
    mockedUpdatePlan.mockResolvedValue({ planId: 'plan-1' } as never);
    mockedDeletePlan.mockResolvedValue({ ok: true });

    await handlePortalPlanCreate(
      command('portal.plan.create', {
        ...base,
        title: 'Plan',
        content: '# Plan',
        source: 'claude',
      }) as Parameters<typeof handlePortalPlanCreate>[0],
      context,
    );
    await handlePortalPlanUpdate(
      command('portal.plan.update', {
        ...base,
        planId: 'plan-1',
        title: 'Updated plan',
      }) as Parameters<typeof handlePortalPlanUpdate>[0],
      context,
    );
    await handlePortalPlanDelete(
      command('portal.plan.delete', {
        ...base,
        planId: 'plan-1',
      }) as Parameters<typeof handlePortalPlanDelete>[0],
      context,
    );

    expect(mockedCreatePlan).toHaveBeenCalledWith(
      expect.objectContaining(base),
      {
        portalCommandId: 'command-1',
        getWindow: context.getWindow,
      },
    );
    expect(mockedUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining(base),
      {
        portalCommandId: 'command-1',
        getWindow: context.getWindow,
      },
    );
    expect(mockedDeletePlan).toHaveBeenCalledWith(
      expect.objectContaining(base),
      {
        portalCommandId: 'command-1',
        getWindow: context.getWindow,
      },
    );
  });
});
