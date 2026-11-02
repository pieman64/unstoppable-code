import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES,
  WORKER_FILESYSTEM_ENTRY_ERROR_CODES,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
} from '../index';

const COPY =
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.entry.copy'
  ];
const MOVE =
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.entry.move'
  ];

const copy = {
  scope: { workspaceId: 'project', worktreeId: 'task' },
  sourceFileRootId: 'project',
  sourceRelativePath: 'docs/guide.md',
  destinationFileRootId: 'attachments',
  destinationRelativePath: 'guide.md',
  expectedSourceVersion: null,
  conflictPolicy: 'increment',
  _meta: { idempotencyKey: 'copy-1' },
};

function refusal(code: string): object {
  return {
    kind: 'failed_precondition',
    code,
    message: 'Refused.',
    retry: { kind: 'never' },
  };
}

describe('worker.filesystem.entry.copy and .move (CAN-4101 on the CAN-4159 contract)', () => {
  // CAN-5502: composed so the daemon's core+worker profile admits them;
  // the filesystem write set keeps file.write and directory.create alone.
  it('is composed into the Canopy registry, not the filesystem write set', () => {
    expect(CANOPY_INSTRUCTION_DEFINITIONS['worker.filesystem.entry.copy']).toBe(
      COPY,
    );
    expect(CANOPY_INSTRUCTION_DEFINITIONS['worker.filesystem.entry.move']).toBe(
      MOVE,
    );
    for (const operation of [
      'worker.filesystem.entry.copy',
      'worker.filesystem.entry.move',
    ])
      expect(
        Object.prototype.hasOwnProperty.call(
          WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
          operation,
        ),
      ).toBe(false);
  });

  it('takes the catalog page copy request, keyed, with no execution ids', () => {
    expect(COPY).toMatchObject({
      kind: 'instruction',
      plane: 'worker',
      idempotency: 'keyed',
      requiredGrants: ['worker.filesystem.write'],
    });
    expect(COPY.params.safeParse(copy).success).toBe(true);
    for (const change of [
      { sourceRelativePath: '' },
      { destinationRelativePath: 'a'.repeat(4097) },
      { expectedSourceVersion: undefined },
      { expectedSourceVersion: '' },
      { conflictPolicy: 'replace' },
      { _meta: {} },
      { scope: { workspaceId: 'project', executionId: 'run' } },
      { fromRelativePath: 'docs/guide.md' },
    ])
      expect(COPY.params.safeParse({ ...copy, ...change }).success).toBe(false);
  });

  it('returns the requested and effective copy destinations and nothing else', () => {
    const result = {
      sourceFileRootId: 'project',
      sourceRelativePath: 'docs/guide.md',
      destinationFileRootId: 'attachments',
      requestedDestinationRelativePath: 'guide.md',
      destinationRelativePath: 'guide copy.md',
      copiedEntryCount: 1,
      version: '12:1700000000000',
    };
    expect(COPY.result.parse(result)).toEqual(result);
    const withoutRequested = Object.fromEntries(
      Object.entries(result).filter(
        ([key]) => key !== 'requestedDestinationRelativePath',
      ),
    );
    expect(COPY.result.safeParse(withoutRequested).success).toBe(false);
    expect(
      COPY.result.safeParse({ ...result, hostPath: '/repo/guide.md' }).success,
    ).toBe(false);
    expect(
      COPY.result.safeParse({ ...result, copiedEntryCount: 0 }).success,
    ).toBe(false);
  });

  it('keeps the copy page codes and adds the desktop guards it has none for', () => {
    expect(WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES.slice(0, 8)).toEqual([
      'worker.filesystem.root.notFound',
      'worker.filesystem.source.notFound',
      'worker.filesystem.source.conflict',
      'worker.filesystem.destination.exists',
      'worker.filesystem.path.escape',
      'worker.filesystem.destination.nested',
      'worker.filesystem.symlink.rejected',
      'worker.filesystem.split.locked',
    ]);
    for (const code of WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES)
      expect(COPY.error.safeParse(refusal(code)).success).toBe(true);
    for (const code of [
      'worker.filesystem.entry.exists',
      'worker.filesystem.entry.nested',
      'worker.filesystem.entry.crossRootSymlink',
    ]) {
      expect(COPY.error.safeParse(refusal(code)).success).toBe(false);
      expect(MOVE.error.safeParse(refusal(code)).success).toBe(true);
    }
    for (const code of WORKER_FILESYSTEM_ENTRY_ERROR_CODES)
      expect(MOVE.error.safeParse(refusal(code)).success).toBe(true);
  });
});
