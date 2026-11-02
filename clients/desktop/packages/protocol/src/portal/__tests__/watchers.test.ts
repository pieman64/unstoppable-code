import * as portal from '../index';

describe('Portal chat watcher contract', () => {
  const entity = {
    id: 'watcher',
    projectId: 'project',
    worktreeId: 'branch',
    chatId: 'chat',
    trigger: 'worktree_pipeline_completion',
    targetKind: 'worktree_pipeline',
    status: 'active',
    createdAt: '2026-10-27T12:00:00.000Z',
    display: {
      title: 'Build',
      subtitle: 'Workflow completion',
      watching: 'Tests',
      watchingSubtitle: 'Project / branch',
      status: 'Active',
      details: [],
    },
  };

  it('parses display-only entities and strips unrecognized host fields', () => {
    expect(
      portal.parsePortalWatcher({
        ...entity,
        target: { cwd: '/private' },
        display: { ...entity.display, secret: 'never-copy' },
      }),
    ).toEqual(entity);
    expect(
      portal.parsePortalWatcher({ ...entity, status: 'firing' }),
    ).toBeNull();
    expect(portal.parsePortalWatcher({ ...entity, chatId: '' })).toBeNull();
  });

  it('requires an explicit boolean notification choice', () => {
    expect(
      portal.PortalWatcherDeletePayloadSchema.safeParse({
        watcherId: 'watcher',
        notifySubscriber: false,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { watcherId: '' },
      { watcherId: 'watcher', notifySubscriber: 'false' },
      { watcherId: 'watcher', notifySubscriber: true, destination: 'foreign' },
    ]) {
      expect(
        portal.PortalWatcherDeletePayloadSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });
  it('advertises the additive entity and bounded delete command', () => {
    expect(portal.PORTAL_ENTITY_TYPES).toContain('watcher');
    expect(portal.PORTAL_COMMAND_TYPES).toContain('portal.watcher.delete');
    expect(portal.PORTAL_SMALL_RPC_COMMAND_TYPES).toContain(
      'portal.watcher.delete',
    );
    expect(portal).toHaveProperty(
      'PORTAL_CAPABILITY_CHAT_WATCHERS',
      'chat_watchers',
    );
  });

  it('replaces watchers with their subscriber scopes, never overview', () => {
    expect(portal.WORKTREE_SCOPE_ENTITY_TYPES).toContain('watcher');
    expect(portal.PORTAL_FEATURE_SCOPE_ENTITY_TYPES.chat).toContain('watcher');
    expect(portal.PORTAL_FEATURE_SCOPE_ENTITY_TYPES.app_advisor).toContain(
      'watcher',
    );
    expect(portal.OVERVIEW_SCOPE_ENTITY_TYPES).not.toContain('watcher');
  });
});
