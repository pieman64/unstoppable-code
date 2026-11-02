import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  WorkerFilesystemDirectoryCreateParamsSchema,
  WorkerFilesystemEntryDeleteParamsSchema,
  WorkerFilesystemFileWriteParamsSchema,
} from '../index';

const _meta = { idempotencyKey: 'key-1' };
const write = {
  scope: { chatId: 'chat' },
  fileRootId: 'workspace',
  relativePath: 'src/a.ts',
  content: 'a',
  _meta,
};

it('registers the writes as keyed worker instructions', () => {
  for (const definition of [
    ...Object.values(WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS),
    ...Object.values(WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS),
  ])
    expect(definition).toMatchObject({
      kind: 'instruction',
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: ['worker.filesystem.write'],
    });
  expect(Object.keys(WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS)).toEqual([
    'worker.filesystem.file.write',
    'worker.filesystem.directory.create',
  ]);
  expect(Object.keys(WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS)).toEqual([
    'worker.filesystem.entry.delete',
    'worker.filesystem.entry.copy',
    'worker.filesystem.entry.move',
  ]);
});

it('requires a version to replace a file and forbids one to create it', () => {
  const parse = (params: object): boolean =>
    WorkerFilesystemFileWriteParamsSchema.safeParse(params).success;
  expect(parse({ ...write, createOnly: true })).toBe(true);
  expect(parse({ ...write, createOnly: false, expectedVersion: '1:2' })).toBe(
    true,
  );
  expect(parse({ ...write, createOnly: false })).toBe(false);
  expect(parse({ ...write, createOnly: false, expectedVersion: null })).toBe(
    false,
  );
  expect(parse({ ...write, createOnly: true, expectedVersion: '1:2' })).toBe(
    false,
  );
  expect(parse({ ...write, createOnly: true, _meta: {} })).toBe(false);
});

it('accepts only an absent leaf and a known delete disposition', () => {
  expect(
    WorkerFilesystemDirectoryCreateParamsSchema.safeParse({
      scope: {},
      fileRootId: 'workspace',
      relativePath: 'docs',
      createParents: false,
      expectedAbsent: false,
      _meta,
    }).success,
  ).toBe(false);
  expect(
    WorkerFilesystemEntryDeleteParamsSchema.safeParse({
      scope: {},
      fileRootId: 'workspace',
      relativePath: 'docs',
      expectedVersion: null,
      recursive: true,
      disposition: 'shred',
      _meta,
    }).success,
  ).toBe(false);
});

it('declares the desktop host codes for file writes and folder creates (CAN-4100)', () => {
  const declares = (
    name: 'worker.filesystem.file.write' | 'worker.filesystem.directory.create',
    code: string,
  ): boolean =>
    WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS[name].error.safeParse({
      kind: 'failed_precondition',
      code,
      message: 'refused',
      retry: { kind: 'never' },
    }).success;
  for (const code of [
    'worker.filesystem.file.notFound',
    'worker.filesystem.root.notFound',
    'worker.filesystem.path.invalid',
    'worker.filesystem.path.escape',
    'worker.filesystem.split.locked',
    'worker.filesystem.root.excluded',
  ])
    expect(declares('worker.filesystem.file.write', code)).toBe(true);
  expect(
    declares(
      'worker.filesystem.directory.create',
      'worker.filesystem.root.excluded',
    ),
  ).toBe(true);
  // Additive only: neither gains the other's or the entry instructions' codes.
  expect(
    declares('worker.filesystem.file.write', 'worker.filesystem.entry.exists'),
  ).toBe(false);
  expect(
    declares(
      'worker.filesystem.directory.create',
      'worker.filesystem.file.notFound',
    ),
  ).toBe(false);
});
