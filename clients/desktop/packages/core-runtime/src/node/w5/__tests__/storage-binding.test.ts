import { bindW5Storage, type W5StorageAdmission } from '../storage-binding';

const admit: W5StorageAdmission = (_targets, operation) => operation();

it('binds every W5 namespace to the composed writer', () => {
  const storage = bindW5Storage('electron_main', admit);
  expect(storage.workspaceIndex).toEqual({
    namespace: 'workspace_index',
    writer: 'electron_main',
  });
  expect(storage.workspaceManifest).toEqual({
    namespace: 'workspace_manifest',
    writer: 'electron_main',
  });
  expect(storage.worktreeList).toEqual({
    namespace: 'worktree_list',
    writer: 'electron_main',
  });
  expect(storage.project).toEqual([
    storage.workspaceIndex,
    storage.workspaceManifest,
    storage.worktreeList,
  ]);
  storage.project.forEach((target, index) =>
    expect(target).toBe(
      [storage.workspaceIndex, storage.workspaceManifest, storage.worktreeList][
        index
      ],
    ),
  );
});

it('takes the writer from composition and returns the injected admission unchanged', async () => {
  const storage = bindW5Storage('daemon', admit);
  expect(storage.project.map((target) => target.writer)).toEqual([
    'daemon',
    'daemon',
    'daemon',
  ]);
  expect(storage.admit).toBe(admit);
  await expect(
    storage.admit(storage.project, () => Promise.resolve('done')),
  ).resolves.toBe('done');
});

it('returns separate targets for separate bindings', () => {
  const first = bindW5Storage('electron_main', admit);
  const second = bindW5Storage('electron_main', admit);
  expect(second.workspaceIndex).not.toBe(first.workspaceIndex);
  expect(second.project).not.toBe(first.project);
});
