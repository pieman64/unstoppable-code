/**
 * @jest-environment jsdom
 */
import { offerCursorRulesReview } from '../cursorRulesOffer';
import { openRepoRulesModal } from '@/stores/repoRulesModalStore';
import type { ToastMeta } from '@/stores/githubStore';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';

const addToast = jest.fn<
  void,
  [string, 'error' | 'info' | 'success' | 'warning', unknown, ToastMeta?]
>();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof addToast } => ({ addToast }),
  },
}));
jest.mock('@/stores/repoRulesModalStore', () => ({
  openRepoRulesModal: jest.fn(),
}));
const projects: Array<{ id: string; name: string }> = [];
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { projects: typeof projects } => ({ projects }),
  },
}));

const status = jest.fn<Promise<RepoRulesStatus>, [{ workspaceId: string }]>();
function savedStatus(
  overrides: Partial<RepoRulesStatus> = {},
): RepoRulesStatus {
  return { enabled: false, disabledRuleIds: [], revision: 0, ...overrides };
}
const presence = jest.fn<
  Promise<{ cursorRulesPresent: boolean }>,
  [{ workspaceId: string }]
>();

let workspaceCounter = 0;
/** The offer is once per workspace per session, so each test uses fresh ids. */
function freshId(): string {
  workspaceCounter += 1;
  return `workspace-${workspaceCounter}`;
}

function onlyToastMeta(): ToastMeta {
  expect(addToast).toHaveBeenCalledTimes(1);
  const meta = addToast.mock.calls[0]?.[3];
  if (!meta) throw new Error('Expected toast metadata');
  return meta;
}

beforeEach(() => {
  addToast.mockReset();
  jest.mocked(openRepoRulesModal).mockReset();
  projects.length = 0;
  status.mockReset().mockResolvedValue(savedStatus());
  presence.mockReset().mockResolvedValue({ cursorRulesPresent: true });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { repoRules: { status }, editorSetup: { presence } },
  });
});

it('offers the review for a new project with Cursor rules and opens it for that project', async () => {
  const workspaceId = freshId();
  projects.push({ id: workspaceId, name: 'rules-demo' });

  await offerCursorRulesReview([{ workspaceId }], 'add-project');

  expect(status).toHaveBeenCalledWith({ workspaceId });
  expect(presence).toHaveBeenCalledWith({ workspaceId });
  const [message, type] = addToast.mock.calls[0] ?? [];
  expect(type).toBe('info');
  // The title already says rules were found. The stacked notification card
  // puts the title in front of the message, so the message must not repeat it.
  expect(message).toBe(
    'Review them to use them in new chats. The repository stays unchanged.',
  );
  const meta = onlyToastMeta();
  expect(meta).toMatchObject({
    title: 'Cursor rules found',
    workspaceName: 'rules-demo',
    // Lets the stacked card show the project's icon, like other project
    // notifications.
    projectId: workspaceId,
    persistent: true,
    // The member just added the project with the app in front.
    suppressOsNotification: true,
  });
  expect(meta.action?.label).toBe('Review Cursor rules');
  meta.action?.onClick();
  expect(openRepoRulesModal).toHaveBeenCalledWith({
    source: 'add-project',
    workspaceId,
  });
});

it('prefers the name the caller already knows', async () => {
  const workspaceId = freshId();
  projects.push({ id: workspaceId, name: 'stale' });
  await offerCursorRulesReview(
    [{ workspaceId, displayName: 'imported-app' }],
    'first-run-import',
  );
  expect(onlyToastMeta().workspaceName).toBe('imported-app');
});

it('stays quiet when the project has no rules or its rules are already on', async () => {
  const withoutRules = freshId();
  presence.mockResolvedValueOnce({ cursorRulesPresent: false });
  await offerCursorRulesReview([{ workspaceId: withoutRules }], 'add-project');

  const alreadyOn = freshId();
  status.mockResolvedValueOnce(savedStatus({ enabled: true }));
  await offerCursorRulesReview([{ workspaceId: alreadyOn }], 'add-project');

  expect(addToast).not.toHaveBeenCalled();
  // An enabled policy needs no presence check at all.
  expect(presence).not.toHaveBeenCalledWith({ workspaceId: alreadyOn });
});

it('leaves alone a project whose rules were already reviewed and turned off', async () => {
  const workspaceId = freshId();
  status.mockResolvedValueOnce(
    savedStatus({ reviewedAt: '2026-10-15T00:00:00.000Z', revision: 1 }),
  );
  await offerCursorRulesReview([{ workspaceId }], 'add-project');
  expect(addToast).not.toHaveBeenCalled();
  expect(presence).not.toHaveBeenCalled();
});

it('treats a failed check as no rules', async () => {
  presence.mockRejectedValueOnce(new Error('unavailable'));
  await offerCursorRulesReview([{ workspaceId: freshId() }], 'add-project');
  status.mockRejectedValueOnce(new Error('unavailable'));
  await offerCursorRulesReview([{ workspaceId: freshId() }], 'add-project');
  expect(addToast).not.toHaveBeenCalled();
});

it('checks a project again after a check that failed', async () => {
  const workspaceId = freshId();
  status.mockRejectedValueOnce(new Error('unavailable'));
  await offerCursorRulesReview([{ workspaceId }], 'add-project');
  expect(addToast).not.toHaveBeenCalled();

  // A later trigger, such as a finished background clone, still offers it.
  await offerCursorRulesReview([{ workspaceId }], 'add-project');
  expect(addToast).toHaveBeenCalledTimes(1);
});

it('offers one review for several new projects and lets the review ask which one', async () => {
  const first = freshId();
  const second = freshId();
  const third = freshId();
  presence.mockImplementation(({ workspaceId }) =>
    Promise.resolve({ cursorRulesPresent: workspaceId !== third }),
  );

  await offerCursorRulesReview(
    [{ workspaceId: first }, { workspaceId: second }, { workspaceId: third }],
    'first-run-import',
  );

  expect(addToast.mock.calls[0]?.[0]).toBe(
    '2 new projects have Cursor rules. Review them to use them in new chats. The repositories stay unchanged.',
  );
  const meta = onlyToastMeta();
  expect(meta.workspaceName).toBeUndefined();
  expect(meta.projectId).toBeUndefined();
  meta.action?.onClick();
  expect(openRepoRulesModal).toHaveBeenCalledWith({
    source: 'first-run-import',
    workspaceIds: [first, second],
  });
});

it('offers a project at most once per session', async () => {
  const workspaceId = freshId();
  await offerCursorRulesReview([{ workspaceId }], 'add-project');
  await offerCursorRulesReview([{ workspaceId }], 'add-project');
  expect(addToast).toHaveBeenCalledTimes(1);
  expect(presence).toHaveBeenCalledTimes(1);
});

it('checks at most ten projects from one import', async () => {
  const workspaces = Array.from({ length: 12 }, () => ({
    workspaceId: freshId(),
  }));
  await offerCursorRulesReview(workspaces, 'first-run-import');
  expect(presence).toHaveBeenCalledTimes(10);
});
