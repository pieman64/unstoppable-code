jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (id: string): string =>
    id === 'legacy-chat-project' ? 'cowork-ws' : id,
}));

import {
  bumpGlobalPluginDefaultsRevision,
  bumpProjectPluginDefaultsRevision,
  getInheritedPluginDefaultsRevision,
  pluginDefaultsWorkspaceId,
  subscribePluginDefaultsRevision,
} from '../plugins/plugin-defaults-revision';

describe('plugin defaults revision', () => {
  it('changes a chat revision for its own project and the global layer only', () => {
    const chat = { projectId: 'ws-a', worktreeId: 'wt-1' };
    const initial = getInheritedPluginDefaultsRevision(chat);

    bumpProjectPluginDefaultsRevision('ws-b');
    expect(getInheritedPluginDefaultsRevision(chat)).toBe(initial);

    bumpProjectPluginDefaultsRevision('ws-a');
    const afterProject = getInheritedPluginDefaultsRevision(chat);
    expect(afterProject).toBeGreaterThan(initial);

    bumpGlobalPluginDefaultsRevision();
    expect(getInheritedPluginDefaultsRevision(chat)).toBeGreaterThan(
      afterProject,
    );
  });

  it('keys legacy cowork targets by their cowork workspace', () => {
    expect(
      pluginDefaultsWorkspaceId({
        projectId: 'standalone-chat',
        worktreeId: 'legacy-chat-project',
      }),
    ).toBe('cowork-ws');
    expect(
      pluginDefaultsWorkspaceId({
        projectId: 'cowork-ws',
        worktreeId: 'entry',
      }),
    ).toBe('cowork-ws');
    const legacy = getInheritedPluginDefaultsRevision({
      projectId: 'standalone-chat',
      worktreeId: 'legacy-chat-project',
    });
    bumpProjectPluginDefaultsRevision('cowork-ws');
    expect(
      getInheritedPluginDefaultsRevision({
        projectId: 'standalone-chat',
        worktreeId: 'legacy-chat-project',
      }),
    ).toBe(legacy + 1);
  });

  it('notifies subscribers for global and project changes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribePluginDefaultsRevision(listener);
    bumpGlobalPluginDefaultsRevision();
    bumpProjectPluginDefaultsRevision('ws-a');
    unsubscribe();
    bumpProjectPluginDefaultsRevision('ws-a');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
