import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_ENTRY_ERROR_CODES,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_INSTRUCTION_DEFINITIONS,
} from '../index';

const DELETE =
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.entry.delete'
  ];
const MOVE =
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[
    'worker.filesystem.entry.move'
  ];

describe('worker.filesystem.entry.delete (CAN-4101 on the CAN-4159 contract)', () => {
  // CAN-5502: composed so the daemon's core+worker profile admits it.
  it('is composed into the worker and Canopy registries as the same definition', () => {
    expect(
      WORKER_INSTRUCTION_DEFINITIONS['worker.filesystem.entry.delete'],
    ).toBe(DELETE);
    expect(
      CANOPY_INSTRUCTION_DEFINITIONS['worker.filesystem.entry.delete'],
    ).toBe(DELETE);
  });

  it('keeps the catalog codes and adds the desktop guards, shared with entry.move', () => {
    expect(WORKER_FILESYSTEM_ENTRY_ERROR_CODES.slice(0, 3)).toEqual([
      'worker.filesystem.entry.invalidState',
      'worker.filesystem.entry.revisionConflict',
      'worker.filesystem.entry.notFound',
    ]);
    for (const definition of [DELETE, MOVE])
      for (const code of WORKER_FILESYSTEM_ENTRY_ERROR_CODES)
        expect(
          definition.error.safeParse({
            kind: 'failed_precondition',
            code,
            message: 'Refused.',
            retry: { kind: 'never' },
          }).success,
        ).toBe(true);
    expect(
      DELETE.error.safeParse({
        kind: 'failed_precondition',
        code: 'worker.filesystem.entry.shredded',
        message: 'Refused.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });

  it('accepts only keyed retry directives', () => {
    const parse = (retry: object): boolean =>
      DELETE.error.safeParse({ kind: 'unavailable', message: 'x', retry })
        .success;
    expect(parse({ kind: 'never' })).toBe(true);
    expect(parse({ kind: 'same_idempotency_key' })).toBe(true);
    expect(parse({ kind: 'after_refresh', resource: 'filesystem-tree' })).toBe(
      true,
    );
    expect(parse({ kind: 'same_request' })).toBe(false);
  });
});
