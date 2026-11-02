/**
 * @jest-environment jsdom
 */
import {
  CANOPY_HOST_EXECUTION_LIMITS,
  CanopyHostExecutionSchema,
  WORKER_QUERY_DEFINITIONS,
  composeCanopyOperationEnvelopes,
} from '..';

// The renderer's jsdom suites import `@canopy/protocol/canopy-core` and have
// no `TextEncoder`; the carrier must load and enforce its bounds there.
describe('host execution carrier without TextEncoder (CAN-5496)', () => {
  it('runs in an environment that has no TextEncoder', () => {
    expect(typeof globalThis.TextEncoder).toBe('undefined');
  });

  it('validates a request carrying _execution', () => {
    const branchList = composeCanopyOperationEnvelopes(
      'worker.git.branch.list',
      WORKER_QUERY_DEFINITIONS['worker.git.branch.list'],
    );
    expect(
      branchList.request.safeParse({
        jsonrpc: '2.0',
        id: 1,
        method: 'worker.git.branch.list',
        params: {
          scope: { workspaceId: 'w', worktreeId: 't' },
          repository: { kind: 'checkout' },
          _execution: { childEnvironment: { PATH: '/usr/bin' } },
        },
      }).success,
    ).toBe(true);
  });

  it('bounds the encoded size in UTF-8 bytes', () => {
    const parse = (value: string): boolean =>
      CanopyHostExecutionSchema.safeParse({ childEnvironment: { K: value } })
        .success;
    // `K=value` plus a terminator leaves this many bytes for the value.
    const fill = CANOPY_HOST_EXECUTION_LIMITS.bytes - 3;
    // `unit` repeated, padded with ASCII to exactly the bound.
    const atBound = (unit: string, unitBytes: number): string =>
      unit.repeat(Math.floor(fill / unitBytes)) + 'v'.repeat(fill % unitBytes);
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['v', 1],
      ['é', 2],
      ['€', 3],
      ['😀', 4],
      // Unpaired surrogates are sent as U+FFFD: three bytes each.
      ['\ud800', 3],
      ['\udc00', 3],
      ['\ud800v', 4],
    ];
    for (const [unit, unitBytes] of cases) {
      expect(parse(atBound(unit, unitBytes))).toBe(true);
      expect(parse(atBound(unit, unitBytes) + 'v')).toBe(false);
    }
    // A low surrogate before a high one, then a trailing high: no pairs.
    expect(parse('v'.repeat(fill - 6) + '\udc00\ud800')).toBe(true);
    expect(parse('v'.repeat(fill - 5) + '\udc00\ud800')).toBe(false);
  });
});
