jest.mock('../lib/project-owner', () => ({
  decideSameOwnerAccess: jest.fn(),
  resolveProjectSavedOwner: jest.fn(),
}));
jest.mock('../lib/app-advisor-project-agent-access', () => ({
  ...jest.requireActual<typeof AppAdvisorAccessModule>(
    '../lib/app-advisor-project-agent-access',
  ),
  decideAppAdvisorAccessForCaller: jest.fn(),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    accountEpoch: (): number => 1,
    getState: (): never => {
      throw new Error(
        'Project discovery must not read selected workspace context.',
      );
    },
  })),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  type ProjectOwnerContext,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorAccessModule from '../lib/app-advisor-project-agent-access';
import {
  ADVISOR_ACCESS_DISABLED,
  decideAppAdvisorAccessForCaller,
} from '../lib/app-advisor-project-agent-access';
import { resolveProjectSavedOwner } from '../lib/project-owner';
import { isBotAccessAllowed } from '../project-discovery/bots';
import {
  botAccessAgent,
  requireBotAccess,
} from '../project-discovery/bots/target';
import { getCallerOwner } from '../project-discovery/owner-policy';

const PERSONAL: ProjectOwnerContext = { kind: 'personal' };
const ORIGIN = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

beforeEach(() => {
  jest.mocked(resolveProjectSavedOwner).mockReset();
  jest.mocked(decideAppAdvisorAccessForCaller).mockReset();
});

describe('getCallerOwner', () => {
  it('returns the run owner for a pipeline caller without reading project metadata', async () => {
    await expect(
      getCallerOwner({ kind: 'pipeline', owner: PERSONAL }),
    ).resolves.toEqual(PERSONAL);
    expect(resolveProjectSavedOwner).not.toHaveBeenCalled();
  });

  it('returns an organization run owner as is', async () => {
    await expect(
      getCallerOwner({
        kind: 'pipeline',
        owner: { kind: 'organization', organizationId: 'org-1' },
      }),
    ).resolves.toEqual({ kind: 'organization', organizationId: 'org-1' });
    expect(resolveProjectSavedOwner).not.toHaveBeenCalled();
  });

  it('returns the run owner even when the run has an agent origin', async () => {
    await expect(
      getCallerOwner({
        kind: 'pipeline',
        owner: PERSONAL,
        agentOrigin: ORIGIN,
      }),
    ).resolves.toEqual(PERSONAL);
    expect(resolveProjectSavedOwner).not.toHaveBeenCalled();
  });
});

describe('requireBotAccess', () => {
  it('allows a person-started pipeline run, with the run owner, without consulting the project-agent setting', async () => {
    await expect(
      requireBotAccess({ kind: 'pipeline', owner: PERSONAL }),
    ).resolves.toMatchObject({ owner: PERSONAL });
    expect(decideAppAdvisorAccessForCaller).not.toHaveBeenCalled();
  });

  it("applies the origin agent's App Advisor access in an agent-originated run", async () => {
    jest
      .mocked(decideAppAdvisorAccessForCaller)
      .mockResolvedValue({ allowed: false, reason: 'advisor_access_disabled' });
    await expect(
      requireBotAccess({
        kind: 'pipeline',
        owner: PERSONAL,
        agentOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: ADVISOR_ACCESS_DISABLED });
    expect(decideAppAdvisorAccessForCaller).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
    });
  });

  it('allows an agent-originated run whose origin has access, with the origin owner', async () => {
    jest
      .mocked(decideAppAdvisorAccessForCaller)
      .mockResolvedValue({ allowed: true });
    jest.mocked(resolveProjectSavedOwner).mockResolvedValue(PERSONAL);
    await expect(
      requireBotAccess({
        kind: 'pipeline',
        owner: PERSONAL,
        agentOrigin: ORIGIN,
      }),
    ).resolves.toMatchObject({ owner: PERSONAL });
    expect(resolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
    });
  });

  it('fails closed when the origin agent owner is unknown', async () => {
    jest
      .mocked(decideAppAdvisorAccessForCaller)
      .mockResolvedValue({ allowed: true });
    jest
      .mocked(resolveProjectSavedOwner)
      .mockResolvedValue({ kind: 'unknown' });
    await expect(
      requireBotAccess({
        kind: 'pipeline',
        owner: PERSONAL,
        agentOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: ADVISOR_ACCESS_DISABLED });
  });
});

describe('isBotAccessAllowed', () => {
  it('allows a person-started pipeline run', async () => {
    await expect(
      isBotAccessAllowed({
        kind: 'pipeline',
        owner: PERSONAL,
      }),
    ).resolves.toBe(true);
    expect(decideAppAdvisorAccessForCaller).not.toHaveBeenCalled();
  });

  it("uses the origin agent's setting in an agent-originated run", async () => {
    jest
      .mocked(decideAppAdvisorAccessForCaller)
      .mockResolvedValue({ allowed: false, reason: 'advisor_access_disabled' });
    await expect(
      isBotAccessAllowed({
        kind: 'pipeline',
        owner: PERSONAL,
        agentOrigin: ORIGIN,
      }),
    ).resolves.toBe(false);
  });
});

describe('botAccessAgent', () => {
  it('gates bots by a project agent origin only', () => {
    expect(botAccessAgent({ kind: 'pipeline', owner: PERSONAL })).toBeNull();
    expect(
      botAccessAgent({
        kind: 'pipeline',
        owner: PERSONAL,
        agentOrigin: ORIGIN,
      }),
    ).toEqual({ projectId: 'p', worktreeId: 'w' });
    expect(
      botAccessAgent({
        kind: 'pipeline',
        owner: PERSONAL,
        agentOrigin: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'advisor-task',
          chatId: 'advisor-chat',
        },
      }),
    ).toBeNull();
    expect(botAccessAgent({ kind: 'app_advisor', chatId: 'c' })).toBeNull();
  });
});
