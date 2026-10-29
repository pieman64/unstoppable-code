import { isCodeGraphGenerationQueueSnapshot } from '../code-graph-validation';

describe('isCodeGraphGenerationQueueSnapshot', () => {
  const validSnapshot = {
    revision: 3,
    entries: [
      {
        id: 'queue-entry',
        scope: 'worktree',
        workspaceIds: ['workspace-a'],
        workspaceLabel: 'Workspace A',
        worktreeId: 'worktree-a',
        trigger: 'manual',
        queuedAt: 1,
        startedAt: null,
        status: 'queued',
        reorderable: true,
      },
    ],
  };

  it('accepts a complete queue snapshot', () => {
    expect(isCodeGraphGenerationQueueSnapshot(validSnapshot)).toBe(true);
  });

  it.each([
    { ...validSnapshot, revision: -1 },
    { ...validSnapshot, entries: [{ ...validSnapshot.entries[0], id: 7 }] },
    {
      ...validSnapshot,
      entries: [{ ...validSnapshot.entries[0], workspaceIds: ['ok', 7] }],
    },
    {
      ...validSnapshot,
      entries: [{ ...validSnapshot.entries[0], status: 'completed' }],
    },
  ])('rejects malformed renderer event payloads', (payload) => {
    expect(isCodeGraphGenerationQueueSnapshot(payload)).toBe(false);
  });
});
