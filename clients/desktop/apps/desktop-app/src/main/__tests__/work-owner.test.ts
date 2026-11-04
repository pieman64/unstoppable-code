import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { AI_CREDITS_WORK_OWNER_HEADER } from '@canopy/protocol/llm-gateway';
import type { WorkspaceOwnerManifestRead } from '../services/workspace-owner-projection';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  __resetSessionWorkOwnersForTests,
  captureSessionWorkOwner,
  createAiCreditsScopeOwnerResolver,
  resolveAiCreditsScopeOwner,
  resolveBackgroundWorkOwner,
  resolveInvocationWorkOwner,
  resolveSessionWorkOwner,
  resolveWorkOwner,
} from '../agents/work-owner';

const ORG_A = '123e4567-e89b-12d3-a456-426614174000';
const ORG_B = '223e4567-e89b-12d3-a456-426614174000';
const CONTEXT_A: WorkspaceContext = {
  kind: 'organization',
  organizationId: ORG_A,
};
const PERSONAL: WorkspaceContext = { kind: 'personal' };

interface PersistedTarget {
  workspaceOwner: WorkspaceContext;
  linkedPersonalCandidate: boolean;
  workspaceType?: 'single-repo' | 'multi-repo' | 'cowork';
}

// Two-org fixture (CAN-3455): A-owned, B-owned, Personal, and a Personal
// single repo linked to Org A.
const WORKSPACES: Record<string, PersistedTarget> = {
  'a-owned': {
    workspaceOwner: CONTEXT_A,
    linkedPersonalCandidate: true,
    workspaceType: 'single-repo',
  },
  'b-owned': {
    workspaceOwner: { kind: 'organization', organizationId: ORG_B },
    linkedPersonalCandidate: false,
    workspaceType: 'multi-repo',
  },
  personal: {
    workspaceOwner: PERSONAL,
    linkedPersonalCandidate: true,
    workspaceType: 'single-repo',
  },
  'linked-to-a': {
    workspaceOwner: PERSONAL,
    linkedPersonalCandidate: true,
    workspaceType: 'single-repo',
  },
  cowork: {
    workspaceOwner: PERSONAL,
    linkedPersonalCandidate: false,
    workspaceType: 'cowork',
  },
  // CAN-3462: an org-owned Cowork project claims its organization.
  [`cowork-org-${ORG_B}`]: {
    workspaceOwner: { kind: 'organization', organizationId: ORG_B },
    linkedPersonalCandidate: false,
    workspaceType: 'cowork',
  },
};

// Legacy standalone chats carry a legacy chat-project id (or the Cowork
// workspace id itself) in the worktree slot; the real resolver maps it through
// `resolveCoworkWorkspaceId`.
const LEGACY_CHAT_PROJECTS: Record<string, string> = {
  'legacy-personal-chat': 'cowork',
  'legacy-org-chat': `cowork-org-${ORG_B}`,
};

const mockResolveBackgroundWorkspaceTarget = jest.fn(
  (projectId: string, worktreeId?: string): Promise<PersistedTarget> => {
    let workspaceId = projectId;
    if (projectId === STANDALONE_CHAT_PROJECT_ID) {
      if (!worktreeId) return Promise.reject(new Error('unknown-provenance'));
      workspaceId = LEGACY_CHAT_PROJECTS[worktreeId] ?? worktreeId;
    }
    const target = WORKSPACES[workspaceId];
    return target
      ? Promise.resolve(target)
      : Promise.reject(new Error('unknown-provenance'));
  },
);
const mockResolveWorkspaceTarget = jest.fn(
  (
    projectId: string,
    options: { organizationId?: string },
  ): Promise<{
    workspaceOwner: WorkspaceContext;
    linkedOrganizationIds: string[];
  }> =>
    Promise.resolve({
      workspaceOwner: PERSONAL,
      linkedOrganizationIds:
        projectId === 'linked-to-a' && options.organizationId === ORG_A
          ? [ORG_A]
          : [],
    }),
);
let mockNavigationContext: WorkspaceContext = PERSONAL;

jest.mock('../services/background-execution-context', () => ({
  resolveBackgroundWorkspaceTarget: (
    projectId: string,
    worktreeId?: string,
  ): unknown => mockResolveBackgroundWorkspaceTarget(projectId, worktreeId),
}));
jest.mock('../services/workspace-target', () => ({
  resolveWorkspaceTarget: (
    projectId: string,
    options: { organizationId?: string },
  ): unknown => mockResolveWorkspaceTarget(projectId, options),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): { context: WorkspaceContext } => ({
      context: mockNavigationContext,
    }),
  }),
}));

describe('work owner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSessionWorkOwnersForTests();
    mockNavigationContext = PERSONAL;
  });

  describe('resolveWorkOwner resolution matrix', () => {
    it.each([
      ['an A-owned workspace', 'a-owned', PERSONAL, CONTEXT_A],
      [
        'a B-owned workspace, even in A context',
        'b-owned',
        CONTEXT_A,
        { kind: 'organization', organizationId: ORG_B },
      ],
      ['a Personal workspace in A context', 'personal', CONTEXT_A, PERSONAL],
      [
        'a Personal workspace linked to A, captured in A',
        'linked-to-a',
        CONTEXT_A,
        CONTEXT_A,
      ],
      [
        'a Personal workspace linked to A, captured in Personal',
        'linked-to-a',
        PERSONAL,
        PERSONAL,
      ],
      ['App Advisor in A context', APP_ADVISOR_PROJECT_ID, CONTEXT_A, PERSONAL],
      [
        'a Personal Cowork workspace in A context',
        'cowork',
        CONTEXT_A,
        PERSONAL,
      ],
      [
        'a B-owned Cowork workspace, even in Personal context',
        `cowork-org-${ORG_B}`,
        PERSONAL,
        { kind: 'organization', organizationId: ORG_B },
      ],
      [
        'a legacy standalone chat without a worktree in A context',
        STANDALONE_CHAT_PROJECT_ID,
        CONTEXT_A,
        PERSONAL,
      ],
    ] satisfies Array<[string, string, WorkspaceContext, WorkspaceContext]>)(
      'resolves %s',
      async (_label, projectId, captured, expected) => {
        await expect(
          resolveWorkOwner({ projectId }, captured),
        ).resolves.toEqual(expected);
      },
    );

    it.each([
      [
        'a legacy chat project in a Personal Cowork',
        'legacy-personal-chat',
        PERSONAL,
      ],
      [
        'a legacy chat project in a B-owned Cowork',
        'legacy-org-chat',
        { kind: 'organization', organizationId: ORG_B },
      ],
      [
        'the Cowork workspace id itself',
        `cowork-org-${ORG_B}`,
        { kind: 'organization', organizationId: ORG_B },
      ],
    ] satisfies Array<[string, string, WorkspaceContext]>)(
      'resolves a legacy standalone chat through %s',
      async (_label, worktreeId, expected) => {
        await expect(
          resolveWorkOwner(
            { projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId },
            CONTEXT_A,
          ),
        ).resolves.toEqual(expected);
        expect(mockResolveBackgroundWorkspaceTarget).toHaveBeenCalledWith(
          STANDALONE_CHAT_PROJECT_ID,
          worktreeId,
        );
      },
    );

    it('omits the claim for a legacy standalone chat whose Cowork is unreadable', async () => {
      await expect(
        resolveBackgroundWorkOwner(
          { projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'gone' },
          undefined,
        ),
      ).resolves.toBeUndefined();
    });

    it('never checks links for a Cowork workspace', async () => {
      await resolveWorkOwner({ projectId: 'cowork' }, CONTEXT_A);
      expect(mockResolveWorkspaceTarget).not.toHaveBeenCalled();
    });

    it('treats work outside any workspace as Personal', async () => {
      await expect(resolveWorkOwner({}, CONTEXT_A)).resolves.toEqual(PERSONAL);
      expect(mockResolveBackgroundWorkspaceTarget).not.toHaveBeenCalled();
    });

    it('checks links only for a Personal single repo captured in an organization', async () => {
      await resolveWorkOwner({ projectId: 'personal' }, PERSONAL);
      await resolveWorkOwner({ projectId: 'a-owned' }, CONTEXT_A);
      expect(mockResolveWorkspaceTarget).not.toHaveBeenCalled();
      await resolveWorkOwner({ projectId: 'linked-to-a' }, CONTEXT_A);
      expect(mockResolveWorkspaceTarget).toHaveBeenCalledWith('linked-to-a', {
        workspaceOwner: PERSONAL,
        linkedPersonalCandidate: true,
        organizationId: ORG_A,
      });
    });

    it('throws rather than guessing when owner authority is unreadable', async () => {
      await expect(
        resolveWorkOwner({ projectId: 'missing' }, CONTEXT_A),
      ).rejects.toThrow('unknown-provenance');
    });
  });

  describe('resolveBackgroundWorkOwner', () => {
    it('uses the persisted execution context, not the navigation context', async () => {
      mockNavigationContext = PERSONAL;
      await expect(
        resolveBackgroundWorkOwner(
          { projectId: 'linked-to-a' },
          serializeWorkspaceContext(CONTEXT_A),
        ),
      ).resolves.toEqual(CONTEXT_A);
    });

    it('resolves a run without an execution context in Personal', async () => {
      mockNavigationContext = CONTEXT_A;
      await expect(
        resolveBackgroundWorkOwner({ projectId: 'linked-to-a' }, undefined),
      ).resolves.toEqual(PERSONAL);
      await expect(
        resolveBackgroundWorkOwner({ projectId: 'a-owned' }, undefined),
      ).resolves.toEqual(CONTEXT_A);
    });

    it('omits the claim for a malformed or unreadable owner', async () => {
      await expect(
        resolveBackgroundWorkOwner({ projectId: 'a-owned' }, 'org:not-a-uuid'),
      ).resolves.toBeUndefined();
      await expect(
        resolveBackgroundWorkOwner({ projectId: 'missing' }, 'personal'),
      ).resolves.toBeUndefined();
    });
  });

  describe('resolveInvocationWorkOwner', () => {
    it('captures the navigation context when the invocation starts', async () => {
      mockNavigationContext = CONTEXT_A;
      await expect(
        resolveInvocationWorkOwner({ projectId: 'linked-to-a' }),
      ).resolves.toEqual(CONTEXT_A);
    });
  });

  describe('session capture', () => {
    const session = {
      projectId: 'linked-to-a',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };

    it('keeps the owner header unchanged when the context switches mid-session', async () => {
      mockNavigationContext = CONTEXT_A;
      captureSessionWorkOwner(session);
      const first = await resolveSessionWorkOwner(session);
      expect(first).toEqual(CONTEXT_A);
      const firstHeader = `${AI_CREDITS_WORK_OWNER_HEADER}: ${first ? serializeWorkspaceContext(first) : ''}`;

      // The user switches the sidebar to Personal while the chat runs, and the
      // provider process respawns (model switch, resume).
      mockNavigationContext = PERSONAL;
      captureSessionWorkOwner(session);
      const afterSwitch = await resolveSessionWorkOwner(session);
      const afterSwitchHeader = `${AI_CREDITS_WORK_OWNER_HEADER}: ${afterSwitch ? serializeWorkspaceContext(afterSwitch) : ''}`;

      expect(afterSwitch).toEqual(first);
      expect(afterSwitchHeader).toBe(firstHeader);
      expect(afterSwitchHeader).toBe(
        `${AI_CREDITS_WORK_OWNER_HEADER}: org:${ORG_A}`,
      );
    });

    it('uses a background chat run execution context instead of live navigation', async () => {
      mockNavigationContext = PERSONAL;
      const backgroundSession = {
        ...session,
        executionContext: serializeWorkspaceContext(CONTEXT_A),
      };

      captureSessionWorkOwner(backgroundSession);

      await expect(resolveSessionWorkOwner(backgroundSession)).resolves.toEqual(
        CONTEXT_A,
      );
    });

    it('rebinds the owner when a later background run changes execution context', async () => {
      captureSessionWorkOwner({
        ...session,
        executionContext: serializeWorkspaceContext(CONTEXT_A),
      });
      await expect(resolveSessionWorkOwner(session)).resolves.toEqual(
        CONTEXT_A,
      );

      captureSessionWorkOwner({
        ...session,
        executionContext: serializeWorkspaceContext(PERSONAL),
      });

      await expect(resolveSessionWorkOwner(session)).resolves.toEqual(PERSONAL);
    });

    it('binds each chat independently', async () => {
      mockNavigationContext = CONTEXT_A;
      captureSessionWorkOwner(session);
      mockNavigationContext = PERSONAL;
      const other = { ...session, chatId: 'chat-2' };
      captureSessionWorkOwner(other);
      await expect(resolveSessionWorkOwner(session)).resolves.toEqual(
        CONTEXT_A,
      );
      await expect(resolveSessionWorkOwner(other)).resolves.toEqual(PERSONAL);
    });

    it('starts owner resolution when the session is captured', async () => {
      captureSessionWorkOwner(session);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockResolveBackgroundWorkspaceTarget).toHaveBeenCalledWith(
        'linked-to-a',
        session.worktreeId,
      );
    });

    it('returns undefined for a session that was never captured', async () => {
      await expect(resolveSessionWorkOwner(session)).resolves.toBeUndefined();
    });

    it('retains an omitted owner when authority is unreadable at capture', async () => {
      mockNavigationContext = CONTEXT_A;
      mockResolveBackgroundWorkspaceTarget.mockRejectedValueOnce(
        new Error('unknown-provenance'),
      );
      captureSessionWorkOwner(session);
      await expect(resolveSessionWorkOwner(session)).resolves.toBeUndefined();
      mockNavigationContext = PERSONAL;
      await expect(resolveSessionWorkOwner(session)).resolves.toBeUndefined();
      expect(mockResolveBackgroundWorkspaceTarget).toHaveBeenCalledTimes(1);
    });
  });

  describe('createAiCreditsScopeOwnerResolver', () => {
    it('projects snapshot evidence with the same binding, link policy and per-chat precedence as fresh reads', async () => {
      mockNavigationContext = CONTEXT_A;
      const captured = {
        projectId: 'linked-to-a',
        worktreeId: 'entry-0',
        chatId: 'chat-captured',
        executionContext: serializeWorkspaceContext(PERSONAL),
      };
      captureSessionWorkOwner(captured);
      await resolveSessionWorkOwner(captured);
      const scopes = [
        ...['linked-to-a', 'b-owned', 'cowork', 'personal'].map(
          (projectId) => ({
            kind: 'work' as const,
            projectId,
            worktreeId: 'entry-0',
            chatId: 'uncaptured-chat',
          }),
        ),
        { kind: 'work' as const, ...captured },
      ];
      const expected = await Promise.all(
        scopes.map(resolveAiCreditsScopeOwner),
      );
      const evidence = new Map<string, WorkspaceOwnerManifestRead>(
        Object.entries(WORKSPACES).map(
          ([id, target]): [string, WorkspaceOwnerManifestRead] => [
            id,
            {
              authority: 'ok',
              ownerMalformed: false,
              memoryMalformed: false,
              config: {
                version: 1,
                type: target.workspaceType ?? 'single-repo',
                repos: [],
                ...(target.workspaceOwner.kind === 'organization'
                  ? {
                      owner: {
                        type: 'organization',
                        organizationId: target.workspaceOwner.organizationId,
                        projectId: ORG_A,
                        instanceId: ORG_B,
                        bindingGeneration: 1,
                      },
                    }
                  : {}),
              },
            },
          ],
        ),
      );
      mockResolveBackgroundWorkspaceTarget.mockClear();
      const resolve = createAiCreditsScopeOwnerResolver(evidence);
      expect(await Promise.all(scopes.map(resolve))).toEqual(expected);
      expect(expected).toEqual([
        CONTEXT_A,
        { kind: 'organization', organizationId: ORG_B },
        PERSONAL,
        PERSONAL,
        PERSONAL,
      ]);
      expect(mockResolveBackgroundWorkspaceTarget).not.toHaveBeenCalled();
      // Execution/authorization still obtains fresh authority, never this map.
      await resolveWorkOwner({ projectId: 'b-owned' }, CONTEXT_A);
      expect(mockResolveBackgroundWorkspaceTarget).toHaveBeenCalledTimes(1);
    });

    it.each(['absent', 'unreadable', 'malformed', 'missing'] as const)(
      'omits %s snapshot provenance instead of guessing or reading live',
      async (state) => {
        mockNavigationContext = CONTEXT_A;
        const evidence = new Map<string, WorkspaceOwnerManifestRead>();
        if (state !== 'missing')
          evidence.set('cowork', {
            config: { version: 1, type: 'cowork', repos: [] },
            authority: state === 'malformed' ? 'ok' : state,
            ownerMalformed: state === 'malformed',
            memoryMalformed: false,
          });
        const resolve = createAiCreditsScopeOwnerResolver(evidence);
        expect(
          await resolve({ kind: 'work', projectId: 'cowork' }),
        ).toBeUndefined();
        expect(mockResolveBackgroundWorkspaceTarget).not.toHaveBeenCalled();
      },
    );

    it('reads owner authority once per project for a listing and keeps per-chat captures', async () => {
      mockNavigationContext = CONTEXT_A;
      const captured = {
        projectId: 'linked-to-a',
        worktreeId: 'entry-0',
        chatId: 'chat-captured',
        executionContext: serializeWorkspaceContext(PERSONAL),
      };
      captureSessionWorkOwner(captured);
      await resolveSessionWorkOwner(captured);
      const scopes = [
        ...['linked-to-a', 'b-owned', 'cowork'].flatMap((projectId) =>
          Array.from({ length: 20 }, (_, index) => ({
            kind: 'work' as const,
            projectId,
            worktreeId: `entry-${index % 4}`,
            chatId: `chat-${index}`,
          })),
        ),
        { kind: 'work' as const, ...captured },
        {
          kind: 'work' as const,
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'legacy-personal-chat',
          chatId: 'legacy-1',
        },
        {
          kind: 'work' as const,
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'legacy-org-chat',
          chatId: 'legacy-2',
        },
      ];
      const expected = [];
      for (const scope of scopes)
        expected.push(await resolveAiCreditsScopeOwner(scope));
      mockResolveBackgroundWorkspaceTarget.mockClear();

      const resolve = createAiCreditsScopeOwnerResolver();
      const owners = [];
      for (const scope of scopes) owners.push(await resolve(scope));

      expect(owners).toEqual(expected);
      expect(owners[60]).toEqual(PERSONAL);
      expect(owners[0]).toEqual(CONTEXT_A);
      expect(owners[62]).toEqual({
        kind: 'organization',
        organizationId: ORG_B,
      });
      expect(mockResolveBackgroundWorkspaceTarget).toHaveBeenCalledTimes(5);
    });
  });
});
