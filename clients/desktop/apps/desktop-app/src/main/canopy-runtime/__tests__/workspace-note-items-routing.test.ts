import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  createRouteHarness,
  FakeSender,
  localCaller,
} from './daemon-files-route-harness';
import {
  deleteTextItemForIpc,
  listTextItemsForIpc,
  readTextItemForIpc,
  saveTextItemForIpc,
} from '../workspace-item-notes-dispatch';

jest.mock('../../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: () => Promise<void>;
  } => ({
    scheduleWorkspace: (): Promise<void> => Promise.resolve(),
  }),
}));

it('makes zero daemon contact for workspace notes and prompts with the Files route enabled', async () => {
  const harness = await createRouteHarness();
  try {
    resetWorkCounters();
    const caller = localCaller(new FakeSender(1));
    for (const kind of ['note', 'prompt'] as const) {
      const saved = await saveTextItemForIpc(harness.runtime, caller, kind, {
        projectId: 'single',
        title: 'Daemon free',
        content: 'body',
      });
      expect(saved.id).toBe('daemon-free');
      await expect(
        listTextItemsForIpc(harness.runtime, caller, kind, 'single'),
      ).resolves.toMatchObject([{ id: 'daemon-free' }]);
      await expect(
        readTextItemForIpc(
          harness.runtime,
          caller,
          kind,
          'single',
          'daemon-free',
        ),
      ).resolves.toMatchObject({ content: 'body' });
      const item = await harness.runtime.query(
        'core.workspace.item.get',
        { itemId: `${kind}:single:daemon-free` },
        { caller: { ...caller, grants: ['core.workspace.read'] } },
      );
      await expect(
        harness.runtime.instruction(
          'core.workspace.item.upsert',
          {
            itemId: item.itemId,
            workspaceId: 'single',
            worktreeId: null,
            kind,
            title: 'Daemon free',
            content: 'edited',
            artifactId: null,
            expectedRevision: item.revision,
            originWorktreeId: null,
          },
          {
            caller: { ...caller, grants: ['core.workspace.write'] },
            metadata: { idempotencyKey: `zero-contact-${kind}` },
          },
        ),
      ).resolves.toMatchObject({ content: 'edited' });
      await deleteTextItemForIpc(
        harness.runtime,
        caller,
        kind,
        'single',
        'daemon-free',
      );
      await expect(
        listTextItemsForIpc(harness.runtime, caller, kind, 'single'),
      ).resolves.toEqual([]);
    }
    expect(harness.connectionsFactory).not.toHaveBeenCalled();
    expect(harness.connections.gets).toEqual([]);
    expect(harness.hostContext).not.toHaveBeenCalled();
    expect(harness.daemon.names()).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  } finally {
    await harness.close();
  }
}, 30_000);
