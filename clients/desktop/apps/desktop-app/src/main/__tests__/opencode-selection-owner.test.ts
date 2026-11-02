import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { WorkOwnerSession } from '../agents/work-owner';
import type { AiCreditsAttribution } from '../agents/ai-credits-routing';
import type { openOpenCodeExecutionRuntime } from '../opencode/execution-runtime';
import {
  __resetSessionWorkOwnersForTests,
  captureSessionWorkOwner,
  resolveSessionWorkOwner as mockReadSessionOwner,
} from '../agents/work-owner';
import { assertOpenCodeSelectionAvailable } from '../opencode/selection';

const mockOrgId = '123e4567-e89b-12d3-a456-426614174000';
let mockContext: WorkspaceContext = { kind: 'personal' };
let mockAuthorityAvailable = true;
const mockResolveTarget = jest.fn(() => {
  if (!mockAuthorityAvailable)
    return Promise.reject(new Error('unreadable workspace'));
  return Promise.resolve({
    workspaceOwner: { kind: 'personal' },
    linkedPersonalCandidate: true,
  });
});
jest.mock('../services/background-execution-context', (): unknown => ({
  resolveBackgroundWorkspaceTarget: () => mockResolveTarget(),
}));
jest.mock('../services/workspace-target', (): unknown => ({
  resolveWorkspaceTarget: () =>
    Promise.resolve({ linkedOrganizationIds: [mockOrgId] }),
}));
jest.mock('../lib/workspace-context-service', (): unknown => ({
  getWorkspaceContextService: () => ({
    getState: () => ({ context: mockContext }),
  }),
}));
jest.mock('../opencode/connection', (): unknown => ({
  assertOpenCodeModelAvailable: () =>
    Promise.resolve({ supportedThinkingLevels: [] }),
}));
const mockNames = jest.fn(() =>
  Promise.resolve({ workspaceName: 'Workspace' }),
);
jest.mock('../agents/ai-credits-routing', (): unknown => ({
  resolveAiCreditsAttribution: () => mockNames(),
  resolveSessionAiCreditsAttribution: async (session: WorkOwnerSession) => ({
    ...(await mockNames()),
    workOwner: await mockReadSessionOwner(session),
  }),
}));
const mockClose = jest.fn(() => Promise.resolve());
let mockLastAttribution: AiCreditsAttribution | undefined;
const mockOpen = jest.fn(
  async (input: Parameters<typeof openOpenCodeExecutionRuntime>[0]) => {
    mockLastAttribution = await input.attribution();
    if (!mockLastAttribution.workOwner)
      throw new Error('The work owner is unavailable.');
    return {
      signal: input.signal,
      close: mockClose,
      supportedThinkingLevels: [],
      inferenceFunding: 'ai-credits',
      inferenceRoute: { bindingKey: 'a'.repeat(64) },
    };
  },
);
jest.mock('../opencode/execution-runtime', (): unknown => ({
  openOpenCodeExecutionRuntime: (
    input: Parameters<typeof openOpenCodeExecutionRuntime>[0],
  ) => mockOpen(input),
}));
const session = {
  projectId: 'workspace',
  worktreeId: 'worktree',
  chatId: 'fresh-chat',
};
beforeEach(() => {
  jest.clearAllMocks();
  __resetSessionWorkOwnersForTests();
  mockContext = { kind: 'personal' };
  mockAuthorityAvailable = true;
  mockLastAttribution = undefined;
});
afterEach(() => __resetSessionWorkOwnersForTests());

it('admits a fresh chat from its workspace scope without starting its owner capture', async () => {
  await expect(
    assertOpenCodeSelectionAvailable({ model: 'gateway-model', session }),
  ).resolves.toMatchObject({ kind: 'gateway' });
  expect(mockLastAttribution).toEqual({
    workspaceName: 'Workspace',
    workOwner: { kind: 'personal' },
  });
  expect(await mockReadSessionOwner(session)).toBeUndefined();
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('keeps a running chat on its captured organization after navigation changes', async () => {
  mockContext = { kind: 'organization', organizationId: mockOrgId };
  captureSessionWorkOwner(session);
  await mockReadSessionOwner(session);
  mockContext = { kind: 'personal' };
  await assertOpenCodeSelectionAvailable({ model: 'gateway-model', session });
  expect(mockLastAttribution?.workOwner).toEqual({
    kind: 'organization',
    organizationId: mockOrgId,
  });
});
it('admits background work using its explicit execution context', async () => {
  await assertOpenCodeSelectionAvailable({
    model: 'gateway-model',
    session: { ...session, executionContext: `org:${mockOrgId}` },
  });
  expect(mockLastAttribution?.workOwner).toEqual({
    kind: 'organization',
    organizationId: mockOrgId,
  });
});
it('refuses unreadable workspace authority instead of inventing an owner', async () => {
  mockAuthorityAvailable = false;
  await expect(
    assertOpenCodeSelectionAvailable({ model: 'gateway-model', session }),
  ).rejects.toThrow('work owner');
});
