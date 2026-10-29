import { runInNewContext } from 'node:vm';
import { LEDGER_ERROR_REASONS } from '@canopy/protocol/canopy-core';
import {
  isLedgerStorageArguments,
  isLedgerStorageError,
  isLedgerStorageErrorReason,
  isLedgerStorageMethod,
  isLedgerStorageRequest,
  isLedgerStorageResponse,
  isLedgerStorageStartupMessage,
  isLedgerStorageWorkerData,
  readLedgerStorageRequestId,
  toLedgerStorageJson,
  type LedgerStorageMethod,
} from '../storage-worker-contract';

class Point {
  x = 1;
}

function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level += 1) value = { level: value };
  return value;
}

function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = { name: 'loop' };
  value.self = value;
  return value;
}

function failure(details: unknown): unknown {
  return {
    id: 1,
    ok: false,
    error: { reason: 'INTERNAL', message: 'Failed', details },
  };
}

describe('isLedgerStorageErrorReason', () => {
  it.each([...LEDGER_ERROR_REASONS, 'INTERNAL'])('accepts %s', (reason) => {
    expect(isLedgerStorageErrorReason(reason)).toBe(true);
  });

  it.each(['internal', 'CONFLICT', '', null, 7])('rejects %p', (reason) => {
    expect(isLedgerStorageErrorReason(reason)).toBe(false);
  });
});

describe('isLedgerStorageResponse', () => {
  it('accepts a success, including one whose result is undefined', () => {
    expect(
      isLedgerStorageResponse({ id: 1, ok: true, result: { entryId: 'e' } }),
    ).toBe(true);
    expect(
      isLedgerStorageResponse({ id: 2, ok: true, result: undefined }),
    ).toBe(true);
  });

  it('accepts a failure with a Ledger reason and JSON details', () => {
    expect(
      isLedgerStorageResponse({
        id: 3,
        ok: false,
        error: {
          reason: 'REVISION_CONFLICT',
          message: 'The entry changed',
          details: {
            reason: 'REVISION_CONFLICT',
            revisions: [1, 2],
            current: { revision: 2, retired: false, owner: null },
          },
        },
      }),
    ).toBe(true);
    expect(
      isLedgerStorageResponse({
        id: 4,
        ok: false,
        error: { reason: 'INTERNAL', message: 'No details' },
      }),
    ).toBe(true);
  });

  it('accepts details built in another realm, as structured clone does', () => {
    const details: unknown = runInNewContext(
      '({ reason: "WRITER_UNAVAILABLE", attempts: [{ waitedMs: 50 }] })',
    );

    expect(isLedgerStorageResponse(failure(details))).toBe(true);
    expect(isLedgerStorageResponse(failure(Object.create(null)))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', [{ id: 1, ok: true, result: 1 }]],
    ['a zero id', { id: 0, ok: true, result: 1 }],
    ['a negative id', { id: -1, ok: true, result: 1 }],
    ['a fractional id', { id: 1.5, ok: true, result: 1 }],
    ['a string id', { id: '1', ok: true, result: 1 }],
    ['an unsafe id', { id: Number.MAX_SAFE_INTEGER + 1, ok: true, result: 1 }],
    ['a non-boolean ok', { id: 1, ok: 'yes', result: 1 }],
    ['a success without a result', { id: 1, ok: true, value: 1 }],
    ['a failure without an error', { id: 1, ok: false }],
    [
      'an unknown reason',
      { id: 1, ok: false, error: { reason: 'NOPE', message: 'Failed' } },
    ],
    ['a missing message', { id: 1, ok: false, error: { reason: 'INTERNAL' } }],
    ['date details', failure(new Date(0))],
    ['map details', failure(new Map([['a', 1]]))],
    ['class instance details', failure(new Point())],
    ['undefined detail values', failure({ field: undefined })],
    ['non-finite detail numbers', failure({ limit: Number.POSITIVE_INFINITY })],
    ['NaN details', failure(Number.NaN)],
    ['function details', failure((): number => 1)],
    ['cyclic details', failure(cyclic())],
    ['details nested too deeply', failure(nested(40))],
  ])('rejects %s', (_label, message) => {
    expect(isLedgerStorageResponse(message)).toBe(false);
  });
});

describe('isLedgerStorageError', () => {
  it('accepts moderately nested details', () => {
    expect(
      isLedgerStorageError({
        reason: 'NOT_FOUND',
        message: 'Missing',
        details: nested(20),
      }),
    ).toBe(true);
  });
});

describe('isLedgerStorageStartupMessage', () => {
  it('accepts ready and a failed open', () => {
    expect(isLedgerStorageStartupMessage({ type: 'ready' })).toBe(true);
    expect(
      isLedgerStorageStartupMessage({
        type: 'openFailed',
        error: {
          reason: 'WRITER_UNAVAILABLE',
          message: 'The Ledger database is in use',
          details: { lock: 'held' },
        },
      }),
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an unknown type', { type: 'started' }],
    ['a failed open without an error', { type: 'openFailed' }],
    [
      'a failed open with an invalid error',
      { type: 'openFailed', error: { reason: 'LOCKED', message: 'Locked' } },
    ],
    ['a response', { id: 1, ok: true, result: null }],
  ])('rejects %s', (_label, message) => {
    expect(isLedgerStorageStartupMessage(message)).toBe(false);
  });
});

describe('isLedgerStorageRequest', () => {
  it('accepts a request, including one whose arguments are undefined', () => {
    expect(
      isLedgerStorageRequest({ id: 1, method: 'addEntry', args: { a: 1 } }),
    ).toBe(true);
    expect(
      isLedgerStorageRequest({ id: 2, method: 'listChanges', args: undefined }),
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ['missing arguments', { id: 1, method: 'addEntry' }],
    ['an empty method', { id: 1, method: '', args: null }],
    ['a non-string method', { id: 1, method: 7, args: null }],
    ['a zero id', { id: 0, method: 'addEntry', args: null }],
  ])('rejects %s', (_label, request) => {
    expect(isLedgerStorageRequest(request)).toBe(false);
  });
});

describe('isLedgerStorageWorkerData', () => {
  it('accepts a database path', () => {
    expect(isLedgerStorageWorkerData({ dbPath: '/data/ledger.sqlite' })).toBe(
      true,
    );
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a missing path', {}],
    ['an empty path', { dbPath: '' }],
    ['a non-string path', { dbPath: 1 }],
  ])('rejects %s', (_label, data) => {
    expect(isLedgerStorageWorkerData(data)).toBe(false);
  });
});

describe('readLedgerStorageRequestId', () => {
  it('reads a usable request id', () => {
    expect(readLedgerStorageRequestId({ id: 4, method: 7 })).toBe(4);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', [4]],
    ['a missing id', { method: 'getScope' }],
    ['a zero id', { id: 0 }],
    ['a fractional id', { id: 1.5 }],
    ['a string id', { id: '4' }],
  ])('reads nothing from %s', (_label, message) => {
    expect(readLedgerStorageRequestId(message)).toBeUndefined();
  });
});

describe('isLedgerStorageMethod', () => {
  it.each([
    'listPendingTitles',
    'recordPendingTitleAttempt',
    'resolvePendingTitle',
  ])('accepts %s', (method) => {
    expect(isLedgerStorageMethod(method)).toBe(true);
  });

  it.each([
    'getAuthorityId',
    'bindScope',
    'findScope',
    'getScope',
    'registerActor',
    'listActors',
    'addEntry',
    'updateEntry',
    'publishSummary',
    'getEntry',
    'searchEntries',
    'listChanges',
    'getStorageCounts',
    'listScopes',
    'findContainerScopes',
    'setScopeLifecycle',
    'rebindScope',
    'purgeScope',
  ])('accepts %s', (method) => {
    expect(isLedgerStorageMethod(method)).toBe(true);
  });

  it.each([
    'close',
    'open',
    'authorityId',
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
    'getscope',
    '',
  ])('rejects %p', (method) => {
    expect(isLedgerStorageMethod(method)).toBe(false);
  });
});

describe('isLedgerStorageArguments', () => {
  it('accepts one positional argument of the listed kind per parameter', () => {
    expect(isLedgerStorageArguments('getAuthorityId', [])).toBe(true);
    expect(isLedgerStorageArguments('getStorageCounts', [])).toBe(true);
    expect(isLedgerStorageArguments('getScope', ['ledger-1'])).toBe(true);
    expect(isLedgerStorageArguments('listActors', [''])).toBe(true);
    expect(isLedgerStorageArguments('addEntry', [{ ledgerId: 'l' }])).toBe(
      true,
    );
    // The fields of an input are the repository's to validate.
    expect(isLedgerStorageArguments('bindScope', [{ unknown: 1 }])).toBe(true);
    expect(
      isLedgerStorageArguments('searchEntries', [
        runInNewContext('({ ledgerId: "l" })'),
      ]),
    ).toBe(true);
    expect(isLedgerStorageArguments('findScope', [Object.create(null)])).toBe(
      true,
    );
    expect(isLedgerStorageArguments('listScopes', [])).toBe(true);
    expect(
      isLedgerStorageArguments('findContainerScopes', [
        { kind: 'code_worktree', workspaceId: 'w', worktreeId: 't' },
      ]),
    ).toBe(true);
    expect(
      isLedgerStorageArguments('setScopeLifecycle', [
        { ledgerId: 'l', state: 'archived' },
      ]),
    ).toBe(true);
    expect(isLedgerStorageArguments('rebindScope', [{ ledgerId: 'l' }])).toBe(
      true,
    );
    expect(isLedgerStorageArguments('purgeScope', ['ledger-1'])).toBe(true);
  });

  it('accepts the pending-title method argument shapes', () => {
    expect(isLedgerStorageArguments('listPendingTitles', [])).toBe(true);
    expect(
      isLedgerStorageArguments('recordPendingTitleAttempt', [
        { entryId: 'entry-1' },
      ]),
    ).toBe(true);
    expect(
      isLedgerStorageArguments('resolvePendingTitle', [
        { entryId: 'entry-1', title: 'A resolved title' },
      ]),
    ).toBe(true);
    expect(
      isLedgerStorageArguments('resolvePendingTitle', [
        { entryId: 'entry-1', title: null },
      ]),
    ).toBe(true);
  });

  it.each<[string, LedgerStorageMethod, unknown]>([
    ['undefined arguments', 'getAuthorityId', undefined],
    ['an object for arguments', 'getStorageCounts', {}],
    ['an extra argument', 'getAuthorityId', ['extra']],
    ['a missing argument', 'getScope', []],
    ['two arguments for one', 'listActors', ['a', 'b']],
    ['a number for an id', 'getScope', [7]],
    ['an input for an id', 'listActors', [{ ledgerId: 'l' }]],
    ['an id for an input', 'addEntry', ['l']],
    ['null for an input', 'updateEntry', [null]],
    ['an array for an input', 'publishSummary', [[]]],
    ['a date for an input', 'getEntry', [new Date(0)]],
    ['a class instance for an input', 'listChanges', [new Point()]],
    ['an argument for no parameters', 'listScopes', [{}]],
    ['an argument for the pending-title list', 'listPendingTitles', [{}]],
    [
      'a string for a pending-title attempt input',
      'recordPendingTitleAttempt',
      ['entry-1'],
    ],
    ['no pending-title resolution input', 'resolvePendingTitle', []],
    ['an id for a container', 'findContainerScopes', ['worktree-1']],
    ['a state for a lifecycle input', 'setScopeLifecycle', ['archived']],
    ['null for a rebind input', 'rebindScope', [null]],
    ['an input for a purged ledger id', 'purgeScope', [{ ledgerId: 'l' }]],
  ])('rejects %s', (_label, method, args) => {
    expect(isLedgerStorageArguments(method, args)).toBe(false);
  });
});

describe('toLedgerStorageJson', () => {
  it('copies JSON data, dropping members whose value is undefined', () => {
    const details = {
      reason: 'REVISION_CONFLICT',
      field: undefined,
      currentEntry: {
        revision: 2,
        highlights: ['Store', 'Tests'],
        supersedesEntryId: undefined,
        owner: { actorId: 'actor-1', kind: 'chat' },
        startLine: null,
        open: false,
      },
    };

    const copy = toLedgerStorageJson(details);

    expect(copy).toEqual({
      reason: 'REVISION_CONFLICT',
      currentEntry: {
        revision: 2,
        highlights: ['Store', 'Tests'],
        owner: { actorId: 'actor-1', kind: 'chat' },
        startLine: null,
        open: false,
      },
    });
    expect(copy).not.toBe(details);
    expect(details).toHaveProperty('field', undefined);
    expect(
      isLedgerStorageError({
        reason: 'REVISION_CONFLICT',
        message: 'The entry changed',
        details: copy,
      }),
    ).toBe(true);
  });

  it('copies plain objects from another realm', () => {
    const foreign: unknown = runInNewContext(
      '({ reason: "NOT_FOUND", checked: [{ ok: true }], none: undefined })',
    );

    const copy = toLedgerStorageJson(foreign);

    expect(copy).toEqual({ reason: 'NOT_FOUND', checked: [{ ok: true }] });
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(toLedgerStorageJson(Object.create(null))).toEqual({});
  });

  it('keeps a __proto__ key as a data member', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"a":1}');

    const copy = toLedgerStorageJson(parsed);

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(true);
    expect(JSON.stringify(copy)).toBe('{"__proto__":{"polluted":true},"a":1}');
  });

  it('keeps nesting the error guard accepts and refuses deeper nesting', () => {
    expect(toLedgerStorageJson(nested(32))).toEqual(nested(32));
    expect(
      isLedgerStorageError({
        reason: 'INTERNAL',
        message: 'M',
        details: nested(32),
      }),
    ).toBe(true);
    expect(toLedgerStorageJson(nested(33))).toBeUndefined();
    expect(
      isLedgerStorageError({
        reason: 'INTERNAL',
        message: 'M',
        details: nested(33),
      }),
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['a function', (): number => 1],
    ['a symbol', Symbol('detail')],
    ['a bigint', BigInt(1)],
    ['NaN', Number.NaN],
    ['an infinite number', { limit: Number.POSITIVE_INFINITY }],
    ['an undefined array item', { revisions: [1, undefined] }],
    ['a class instance', { point: new Point() }],
    ['a date', { at: new Date(0) }],
    ['a map', new Map([['a', 1]])],
    ['a cycle', cyclic()],
    ['nesting that is too deep', nested(40)],
  ])('refuses %s', (_label, value) => {
    expect(toLedgerStorageJson(value)).toBeUndefined();
  });
});
