import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ChatActivePlanContext,
  type PendingSystemInstruction,
} from '@canopy/desktop-shared/types';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

jest.mock('../lib/plan-system-instructions', () => ({
  buildPlanFileSystemInstruction: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

import { buildPlanFileSystemInstruction } from '../lib/plan-system-instructions';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  parseChatActivePlanContext,
  resolveActivePlanSystemInstruction,
  withActivePlanInstruction,
} from '../lib/active-plan-instruction';

const mockBuildPlanFileSystemInstruction = jest.mocked(
  buildPlanFileSystemInstruction,
);
const mockLogMainProcessError = jest.mocked(logMainProcessError);

describe('parseChatActivePlanContext', () => {
  it('returns undefined for undefined input', () => {
    expect(parseChatActivePlanContext(undefined)).toBeUndefined();
  });

  it.each([null, 'plan-1', 42, [], true])(
    'throws for a non-record value %p',
    (value) => {
      expect(() => parseChatActivePlanContext(value)).toThrow(
        'Invalid active plan context.',
      );
    },
  );

  it('throws when planId is missing', () => {
    expect(() => parseChatActivePlanContext({})).toThrow();
  });

  it.each(['Plan_1', 'PLAN-1', '', '-plan-1', 'plan 1'])(
    'throws for an invalid plan id %p',
    (planId) => {
      expect(() => parseChatActivePlanContext({ planId })).toThrow();
    },
  );

  it('returns just the plan id when no viewed revision is present', () => {
    expect(parseChatActivePlanContext({ planId: 'plan-1' })).toEqual({
      planId: 'plan-1',
    });
  });

  it('returns the plan id and viewed revision when both are valid', () => {
    expect(
      parseChatActivePlanContext({ planId: 'plan-1', viewedRevisionNumber: 2 }),
    ).toEqual({ planId: 'plan-1', viewedRevisionNumber: 2 });
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, '2', null])(
    'throws for an invalid viewed revision number %p',
    (viewedRevisionNumber) => {
      expect(() =>
        parseChatActivePlanContext({ planId: 'plan-1', viewedRevisionNumber }),
      ).toThrow('Invalid active plan context.');
    },
  );
});

describe('resolveActivePlanSystemInstruction', () => {
  const SCOPED_PROJECT_ID = 'project-1';
  const WORKTREE_ID = 'worktree-1';
  const ACTIVE_PLAN: ChatActivePlanContext = { planId: 'plan-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    registerWorkspaceTypes(new Map());
  });

  it('returns null without building anything when no active plan was captured', async () => {
    const result = await resolveActivePlanSystemInstruction({
      projectId: SCOPED_PROJECT_ID,
      worktreeId: WORKTREE_ID,
      activePlan: undefined,
    });

    expect(result).toBeNull();
    expect(mockBuildPlanFileSystemInstruction).not.toHaveBeenCalled();
  });

  it.each([
    APP_ADVISOR_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    STANDALONE_CHAT_PROJECT_ID,
  ])('refuses the %s sentinel scope', async (projectId) => {
    const result = await resolveActivePlanSystemInstruction({
      projectId,
      worktreeId: WORKTREE_ID,
      activePlan: ACTIVE_PLAN,
    });

    expect(result).toBeNull();
    expect(mockBuildPlanFileSystemInstruction).not.toHaveBeenCalled();
  });

  it('refuses a Cowork workspace scope', async () => {
    registerWorkspaceTypes(new Map([['cowork-workspace', 'cowork']]));

    const result = await resolveActivePlanSystemInstruction({
      projectId: 'cowork-workspace',
      worktreeId: WORKTREE_ID,
      activePlan: ACTIVE_PLAN,
    });

    expect(result).toBeNull();
    expect(mockBuildPlanFileSystemInstruction).not.toHaveBeenCalled();
  });

  it('builds an active-plan instruction for a real scope, forwarding the viewed revision', async () => {
    const instruction: PendingSystemInstruction = {
      id: 'active-plan:plan-1',
      text: 'active plan text',
    };
    mockBuildPlanFileSystemInstruction.mockResolvedValue(instruction);

    const result = await resolveActivePlanSystemInstruction({
      projectId: SCOPED_PROJECT_ID,
      worktreeId: WORKTREE_ID,
      activePlan: { planId: 'plan-1', viewedRevisionNumber: 2 },
    });

    expect(result).toBe(instruction);
    expect(mockBuildPlanFileSystemInstruction).toHaveBeenCalledWith({
      projectId: SCOPED_PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
      purpose: 'active-plan',
      viewedRevisionNumber: 2,
    });
  });

  it('returns null and logs when the builder throws', async () => {
    mockBuildPlanFileSystemInstruction.mockRejectedValue(new Error('boom'));

    const result = await resolveActivePlanSystemInstruction({
      projectId: SCOPED_PROJECT_ID,
      worktreeId: WORKTREE_ID,
      activePlan: ACTIVE_PLAN,
    });

    expect(result).toBeNull();
    expect(mockLogMainProcessError).toHaveBeenCalledWith(
      expect.stringContaining('active plan'),
      expect.any(Error),
    );
  });
});

describe('withActivePlanInstruction', () => {
  const AUTHORED: PendingSystemInstruction = {
    id: 'plan-file-location:plan-1',
    text: 'authored plan text',
  };
  const OTHER_AUTHORED: PendingSystemInstruction = {
    id: 'plan-file-location:plan-2',
    text: 'other authored plan text',
  };
  const ACTIVE: PendingSystemInstruction = {
    id: 'active-plan:plan-1',
    text: 'active plan text',
  };

  it('returns undefined unchanged when there are no instructions and nothing to add', () => {
    expect(withActivePlanInstruction(undefined, null)).toBeUndefined();
  });

  it('returns instructions unchanged when the active plan instruction is null', () => {
    expect(withActivePlanInstruction([AUTHORED], null)).toEqual([AUTHORED]);
  });

  it('appends the active plan instruction when no matching authored instruction is present', () => {
    expect(withActivePlanInstruction(undefined, ACTIVE)).toEqual([ACTIVE]);
    expect(withActivePlanInstruction([OTHER_AUTHORED], ACTIVE)).toEqual([
      OTHER_AUTHORED,
      ACTIVE,
    ]);
  });

  it("skips the active plan instruction when the same plan's authored instruction is already present", () => {
    expect(withActivePlanInstruction([AUTHORED], ACTIVE)).toEqual([AUTHORED]);
  });

  it("does not skip a different plan's authored instruction", () => {
    expect(
      withActivePlanInstruction([AUTHORED], {
        id: 'active-plan:plan-2',
        text: 'other active plan text',
      }),
    ).toEqual([
      AUTHORED,
      { id: 'active-plan:plan-2', text: 'other active plan text' },
    ]);
  });
});
