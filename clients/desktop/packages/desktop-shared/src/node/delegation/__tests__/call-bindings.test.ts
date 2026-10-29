import { parseAgentDelegationSpawnRequest } from '@canopy/protocol/delegation';
import {
  DelegationCallBindings,
  type DelegationParentOwner,
} from '../call-bindings';

export function parentFixture(
  overrides: Partial<DelegationParentOwner> = {},
): DelegationParentOwner {
  return {
    harnessId: 'third-parent',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    sessionKey: 'session',
    turnId: 'turn',
    runtimeGeneration: 1,
    depth: 0,
    ...overrides,
  };
}

function task(): ReturnType<typeof parseAgentDelegationSpawnRequest> & {
  ok: true;
} {
  const parsed = parseAgentDelegationSpawnRequest({
    modelId: 'logical-review-model',
    description: 'review',
    prompt: 'same task',
  });
  if (!parsed.ok) throw new Error('Invalid fixture');
  return parsed;
}

describe('host-bound delegation caller identity', () => {
  it('keeps identical parallel calls distinct and retries the same provider id stably', () => {
    const owner = parentFixture();
    const bindings = new DelegationCallBindings(
      owner,
      new AbortController().signal,
    );
    try {
      const first = bindings.bind('toolu_first', task().value);
      const second = bindings.bind('toolu_second', task().value);
      if (!first.ok || !second.ok) throw new Error('Expected caller binding');
      expect(first.value).not.toBe(second.value);
      expect(bindings.bind('toolu_first', task().value)).toEqual(first);
      expect(bindings.resolve(second.value, task().value, owner)).toEqual({
        ok: true,
        value: { ...owner, toolCallId: 'toolu_second' },
      });
      expect(bindings.resolve(first.value, task().value, owner)).toEqual({
        ok: true,
        value: { ...owner, toolCallId: 'toolu_first' },
      });
    } finally {
      bindings.dispose();
    }
  });

  it.each([
    'chatId',
    'turnId',
    'worktreeId',
    'sessionKey',
    'harnessId',
    'projectId',
    'runtimeGeneration',
    'depth',
  ] as const)(
    'rejects a different host %s without trusting a supplied identity',
    (field) => {
      const owner = parentFixture();
      const bindings = new DelegationCallBindings(
        owner,
        new AbortController().signal,
      );
      try {
        const bound = bindings.bind('toolu_first', task().value);
        if (!bound.ok) throw new Error('Expected caller binding');
        const foreign =
          field === 'runtimeGeneration' || field === 'depth'
            ? parentFixture({ [field]: 2 })
            : parentFixture({ [field]: 'foreign' });
        expect(bindings.resolve(bound.value, task().value, foreign).ok).toBe(
          false,
        );
      } finally {
        bindings.dispose();
      }
    },
  );

  it('rejects forged tokens, changed arguments, recursion, and expired owners', () => {
    const controller = new AbortController();
    const owner = parentFixture();
    const bindings = new DelegationCallBindings(owner, controller.signal);
    const bound = bindings.bind('toolu_first', task().value);
    if (!bound.ok) throw new Error('Expected caller binding');
    expect(bindings.resolve('forged', task().value, owner).ok).toBe(false);
    expect(
      bindings.resolve(
        bound.value,
        { ...task().value, prompt: 'changed' },
        owner,
      ).ok,
    ).toBe(false);
    expect(
      bindings.bind('toolu_first', { ...task().value, prompt: 'changed' }).ok,
    ).toBe(false);
    controller.abort();
    expect(bindings.resolve(bound.value, task().value, owner).ok).toBe(false);
    expect(bindings.bind('toolu_next', task().value).ok).toBe(false);
    const recursive = new DelegationCallBindings(
      parentFixture({ depth: 1 }),
      new AbortController().signal,
    );
    try {
      expect(recursive.bind('toolu_first', task().value).ok).toBe(false);
    } finally {
      recursive.dispose();
    }
  });
});
