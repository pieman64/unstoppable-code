import {
  CanopyRequestMetadataSchema,
  CanopyStreamCursorSchema,
  LEDGER_INSTRUCTION_DEFINITIONS,
  LEDGER_QUERY_DEFINITIONS,
  limitLedgerRequest,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  WorkerFilesystemFileWriteParamsSchema,
} from '@canopy/protocol/canopy-core';
import { paramsDeclareMeta } from '../request-metadata';

const declaring = CanopyStreamCursorSchema.extend({
  _meta: CanopyRequestMetadataSchema.required({ idempotencyKey: true }),
});

describe('paramsDeclareMeta', () => {
  it('matches an object schema that declares _meta', () => {
    expect(paramsDeclareMeta(declaring)).toBe(true);
    expect(paramsDeclareMeta(CanopyStreamCursorSchema)).toBe(false);
  });

  it('matches a union only when every branch declares _meta', () => {
    expect(paramsDeclareMeta(WorkerFilesystemFileWriteParamsSchema)).toBe(true);
    expect(paramsDeclareMeta(declaring.or(CanopyStreamCursorSchema))).toBe(
      false,
    );
    // Structural stand-ins for an enum's string options and an empty union.
    expect(paramsDeclareMeta({ options: [declaring, '_meta'] })).toBe(false);
    expect(paramsDeclareMeta({ options: [] })).toBe(false);
  });

  it('reads a pipe on the side that parses the wire params', () => {
    // A preprocess hands the wire params to its output schema.
    expect(paramsDeclareMeta(limitLedgerRequest(declaring))).toBe(true);
    expect(
      paramsDeclareMeta(limitLedgerRequest(CanopyStreamCursorSchema)),
    ).toBe(false);
    // A transform after an object parses the wire params with that object.
    expect(paramsDeclareMeta(declaring.transform((value) => value))).toBe(true);
    expect(
      paramsDeclareMeta(CanopyStreamCursorSchema.transform(() => declaring)),
    ).toBe(false);
    expect(paramsDeclareMeta(limitLedgerRequest(declaring).or(declaring))).toBe(
      true,
    );
  });

  it('rejects values with no schema shape', () => {
    expect(paramsDeclareMeta(undefined)).toBe(false);
    expect(paramsDeclareMeta({ shape: null })).toBe(false);
    expect(paramsDeclareMeta({ in: null, out: declaring })).toBe(false);
  });

  // Keyed catalog contracts that declare _meta: the CAN-4159 write contracts
  // (a union for worker.filesystem.file.write) and the Ledger's keyed
  // core.ledger.entry.add, core.ledger.entry.update and
  // core.ledger.summary.publish (a request-size preprocess). Read only.
  it.each([
    ...Object.entries(WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS),
    ...Object.entries(WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS),
    ...Object.entries(LEDGER_INSTRUCTION_DEFINITIONS),
  ])('recognizes the declared _meta of %s', (_name, definition) => {
    expect(paramsDeclareMeta(definition.params)).toBe(true);
  });

  it.each(Object.entries(LEDGER_QUERY_DEFINITIONS))(
    'finds no _meta in the params of %s',
    (_name, definition) => {
      expect(paramsDeclareMeta(definition.params)).toBe(false);
    },
  );
});
