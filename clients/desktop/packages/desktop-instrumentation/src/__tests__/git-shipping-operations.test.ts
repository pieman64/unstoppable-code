import {
  DESKTOP_OPERATIONS,
  createPostHogOperationTracker,
} from '../operations';
import { sanitizePostHogEvent } from '../posthog-privacy';

it.each([
  ['canopy.git_commit', 'git:commit_create'],
  ['canopy.pull_request_open', 'git:pull_request_open'],
  ['canopy.pull_request_merge', 'git:pull_request_merge'],
] as const)('projects %s through an exact privacy allowlist', (name, event) => {
  expect(DESKTOP_OPERATIONS[name].contextKeys).toEqual([
    'source',
    'workspace_type',
    'is_install_first',
    'flow',
    'repo_count',
  ]);
  const tracker = createPostHogOperationTracker({
    now: () => 10,
    appVersion: '1.2.3',
  });
  const context = {
    source: 'manual',
    workspace_type: 'single-repo',
    flow: 'commit',
    repo_count: 1,
    repo_name: 'secret-repo',
    branch: 'private-branch',
    pr_number: 4634,
    url: 'https://github.com/private/repo/pull/4634',
    sha: 'secret-sha',
    project_id: 'private-project',
    worktree_id: 'private-worktree',
    chat_id: 'private-chat',
  };
  tracker.start(name, { context });
  const recorded = tracker.finish(name, { status: 'success' }, 'background', {
    context,
  });
  expect(recorded).toEqual({
    event,
    properties: {
      source: 'manual',
      workspace_type: 'single-repo',
      flow: 'commit',
      repo_count: 1,
      status: 'success',
      duration_ms: 0,
      surface: 'background',
      app_version: '1.2.3',
    },
  });
  if (!recorded) throw new Error('Expected a completed operation event');
  expect(JSON.stringify(sanitizePostHogEvent(recorded))).not.toMatch(
    /secret|private|4634/,
  );
  expect(
    tracker.finish(name, { status: 'success' }, 'background', {
      context: { ...context, is_install_first: false },
    })?.properties.is_install_first,
  ).toBe(false);
});
