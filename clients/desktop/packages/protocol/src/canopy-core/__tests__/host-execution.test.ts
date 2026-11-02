import { z } from 'zod';

import {
  CANOPY_HOST_EXECUTION_LIMITS,
  CANOPY_HOST_EXECUTION_OPERATIONS,
  CanopyHostExecutionSchema,
  WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
  composeCanopyOperationEnvelopes,
} from '..';

const execution = { childEnvironment: { PATH: '/usr/bin', HOME: '/home/u' } };

function request(method: string, params: Record<string, unknown>): unknown {
  return { jsonrpc: '2.0', id: 1, method, params };
}

describe('host execution carrier (CAN-5496)', () => {
  it('admits _execution only on the opted-in worker.git operations', () => {
    expect([...CANOPY_HOST_EXECUTION_OPERATIONS].sort()).toEqual([
      'worker.git.branch.create',
      'worker.git.branch.delete',
      'worker.git.branch.list',
      'worker.git.branch.rename',
      'worker.git.checkout',
      'worker.git.fetch',
      'worker.git.pull',
      'worker.git.remote.get',
      'worker.git.worktree.health.get',
    ]);
    const branchList = composeCanopyOperationEnvelopes(
      'worker.git.branch.list',
      WORKER_QUERY_DEFINITIONS['worker.git.branch.list'],
    );
    const params = {
      scope: { workspaceId: 'w', worktreeId: 't' },
      repository: { kind: 'checkout' },
    };
    expect(
      branchList.request.safeParse(request('worker.git.branch.list', params))
        .success,
    ).toBe(true);
    expect(
      branchList.request.safeParse(
        request('worker.git.branch.list', { ...params, _execution: execution }),
      ).success,
    ).toBe(true);
    // Selection keeps the daemon's own environment, so executable.get refuses it.
    const executable = composeCanopyOperationEnvelopes(
      'worker.git.executable.get',
      WORKER_QUERY_DEFINITIONS['worker.git.executable.get'],
    );
    const executableParams = { scope: {}, recheck: false };
    expect(
      executable.request.safeParse(
        request('worker.git.executable.get', executableParams),
      ).success,
    ).toBe(true);
    expect(
      executable.request.safeParse(
        request('worker.git.executable.get', {
          ...executableParams,
          _execution: execution,
        }),
      ).success,
    ).toBe(false);
    // Change-set reads keep the daemon's own environment (CAN-4729).
    const diff = composeCanopyOperationEnvelopes(
      'worker.git.diff.get',
      WORKER_QUERY_DEFINITIONS['worker.git.diff.get'],
    );
    const diffParams = {
      scope: { workspaceId: 'w', worktreeId: 't' },
      repoId: '__workspace_root__',
      base: 'HEAD',
      head: 'WORKTREE',
    };
    expect(
      diff.request.safeParse(request('worker.git.diff.get', diffParams))
        .success,
    ).toBe(true);
    expect(
      diff.request.safeParse(
        request('worker.git.diff.get', {
          ...diffParams,
          _execution: execution,
        }),
      ).success,
    ).toBe(false);
  });

  it('admits _execution on the branch writes, which never replay (CAN-4108)', () => {
    const checkout = composeCanopyOperationEnvelopes(
      'worker.git.checkout',
      WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS['worker.git.checkout'],
    );
    const params = {
      scope: { workspaceId: 'w', worktreeId: 't' },
      branch: 'main',
    };
    expect(
      checkout.request.safeParse(
        request('worker.git.checkout', { ...params, _execution: execution }),
      ).success,
    ).toBe(true);
    expect(
      checkout.request.safeParse(
        request('worker.git.checkout', {
          ...params,
          _meta: { idempotencyKey: 'k' },
        }),
      ).success,
    ).toBe(false);
    // A keyed instruction could be replayed from its receipt with a stale
    // environment, so every opted-in instruction is idempotency `none`.
    const instructions: Record<string, { idempotency: string }> = {
      ...WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
      ...WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
      ...WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
    };
    for (const name of CANOPY_HOST_EXECUTION_OPERATIONS)
      if (name in instructions)
        expect(instructions[name]?.idempotency).toBe('none');
  });

  it('admits _execution on the branch rename and delete, whose reference-transaction hooks it reaches (CAN-5516)', () => {
    for (const [name, params] of [
      [
        'worker.git.branch.rename',
        { scope: { workspaceId: 'w', worktreeId: 't' }, name: 'renamed' },
      ],
      [
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'w' },
          branch: 'old',
          deletion: { kind: 'merged' },
        },
      ],
    ] as const) {
      const envelopes = composeCanopyOperationEnvelopes(
        name,
        WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS[name],
      );
      expect(
        envelopes.request.safeParse(
          request(name, { ...params, _execution: execution }),
        ).success,
      ).toBe(true);
      expect(
        envelopes.request.safeParse(
          request(name, { ...params, _meta: { idempotencyKey: 'k' } }),
        ).success,
      ).toBe(false);
    }
  });

  it('keeps _execution out of _meta', () => {
    const envelopes = composeCanopyOperationEnvelopes(
      'worker.git.remote.get',
      WORKER_QUERY_DEFINITIONS['worker.git.remote.get'],
    );
    expect(
      envelopes.request.safeParse(
        request('worker.git.remote.get', {
          scope: { workspaceId: 'w' },
          repository: { kind: 'recorded' },
          _meta: { execution },
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses keys and values a child environment cannot hold', () => {
    const parse = (childEnvironment: unknown): boolean =>
      CanopyHostExecutionSchema.safeParse({ childEnvironment }).success;
    expect(parse({ PATH: '/usr/bin', EMPTY: '' })).toBe(true);
    expect(parse({ '': 'x' })).toBe(false);
    expect(parse({ 'A=B': 'x' })).toBe(false);
    expect(parse({ 'A\0': 'x' })).toBe(false);
    expect(parse({ A: 'x\0y' })).toBe(false);
    expect(parse({ A: 1 })).toBe(false);
    expect(parse(['PATH=/usr/bin'])).toBe(false);
    expect(
      CanopyHostExecutionSchema.safeParse({ childEnvironment: {}, extra: 1 })
        .success,
    ).toBe(false);
  });

  it('bounds the entry count and encoded size', () => {
    const parse = (childEnvironment: Record<string, string>): boolean =>
      CanopyHostExecutionSchema.safeParse({ childEnvironment }).success;
    const entries = (count: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`K${index}`, '']),
      );
    expect(parse(entries(CANOPY_HOST_EXECUTION_LIMITS.entries))).toBe(true);
    expect(parse(entries(CANOPY_HOST_EXECUTION_LIMITS.entries + 1))).toBe(
      false,
    );
    // `K=value` plus a terminator: exactly at the byte bound, then one over.
    const fill = CANOPY_HOST_EXECUTION_LIMITS.bytes - 3;
    expect(parse({ K: 'v'.repeat(fill) })).toBe(true);
    expect(parse({ K: 'v'.repeat(fill + 1) })).toBe(false);
    // Bytes are UTF-8, not UTF-16 code units.
    expect(parse({ K: 'é'.repeat(Math.ceil(fill / 2) + 1) })).toBe(false);
    // The bound agrees with TextEncoder, unpaired surrogates included.
    const samples = ['aé€😀', '\ud800x\udc00', 'z\ud83d'];
    for (const sample of samples) {
      const padding = fill - new TextEncoder().encode(sample).length;
      expect(parse({ K: sample + 'v'.repeat(padding) })).toBe(true);
      expect(parse({ K: sample + 'v'.repeat(padding + 1) })).toBe(false);
    }
  });

  it('refuses a params schema that declares the reserved member', () => {
    const definition = {
      ...WORKER_QUERY_DEFINITIONS['worker.git.executable.get'],
      params: z.strictObject({ _execution: z.string() }),
    };
    expect(() =>
      composeCanopyOperationEnvelopes('worker.example.get', definition),
    ).toThrow('_execution');
    expect(() =>
      composeCanopyOperationEnvelopes('worker.git.branch.list', definition),
    ).toThrow('_execution');
  });
});
