import {
  GIT_DEFAULT_BRANCH_HINT_TTL_MS,
  isGitDefaultBranchHintFresh,
  selectGitDefaultBranch,
  type GitDefaultBranchFacts,
} from '../default-branch';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function facts(overrides: Partial<GitDefaultBranchFacts> = {}): {
  facts: GitDefaultBranchFacts;
  calls: string[];
} {
  const calls: string[] = [];
  const read =
    (name: string, value: string | null) => (): Promise<string | null> => {
      calls.push(name);
      return Promise.resolve(value);
    };
  return {
    calls,
    facts: {
      readHint: (): Promise<null> => {
        calls.push('hint');
        return Promise.resolve(null);
      },
      readRemoteHead: read('remote', null),
      readLocalOriginHead: read('local', null),
      readConventional: read('conventional', null),
      ...overrides,
    },
  };
}

describe('isGitDefaultBranchHintFresh', () => {
  it('is fresh only inside the TTL and never from the future', () => {
    const hint = (
      resolvedAt: string,
    ): { defaultBranch: string; resolvedAt: string } => ({
      defaultBranch: 'main',
      resolvedAt,
    });
    expect(isGitDefaultBranchHintFresh(hint(at(-1_000)), NOW)).toBe(true);
    expect(isGitDefaultBranchHintFresh(hint(at(0)), NOW)).toBe(true);
    expect(
      isGitDefaultBranchHintFresh(
        hint(at(-GIT_DEFAULT_BRANCH_HINT_TTL_MS)),
        NOW,
      ),
    ).toBe(false);
    expect(isGitDefaultBranchHintFresh(hint(at(1_000)), NOW)).toBe(false);
    expect(isGitDefaultBranchHintFresh(hint('not a date'), NOW)).toBe(false);
  });
});

describe('selectGitDefaultBranch', () => {
  it('serves a fresh hint without any other read', async () => {
    const { facts: input, calls } = facts({
      readHint: () =>
        Promise.resolve({ defaultBranch: 'trunk', resolvedAt: at(-1_000) }),
    });
    await expect(selectGitDefaultBranch(input, { now: NOW })).resolves.toEqual({
      defaultBranch: 'trunk',
      source: 'hint',
    });
    expect(calls).toEqual([]);
  });

  it('prefers the live remote over a stale hint', async () => {
    const { facts: input, calls } = facts({
      readHint: () =>
        Promise.resolve({
          defaultBranch: 'old',
          resolvedAt: at(-GIT_DEFAULT_BRANCH_HINT_TTL_MS - 1),
        }),
      readRemoteHead: () => Promise.resolve('main'),
    });
    await expect(selectGitDefaultBranch(input, { now: NOW })).resolves.toEqual({
      defaultBranch: 'main',
      source: 'remote',
    });
    expect(calls).toEqual([]);
  });

  it('falls back to local origin/HEAD, then a stale hint, then conventional names', async () => {
    const local = facts({ readLocalOriginHead: () => Promise.resolve('dev') });
    await expect(
      selectGitDefaultBranch(local.facts, { now: NOW }),
    ).resolves.toEqual({ defaultBranch: 'dev', source: 'local-origin-head' });
    expect(local.calls).toEqual(['hint', 'remote']);

    const stale = facts({
      readHint: () =>
        Promise.resolve({
          defaultBranch: 'old',
          resolvedAt: at(-GIT_DEFAULT_BRANCH_HINT_TTL_MS - 1),
        }),
    });
    await expect(
      selectGitDefaultBranch(stale.facts, { now: NOW }),
    ).resolves.toEqual({ defaultBranch: 'old', source: 'stale-hint' });
    expect(stale.calls).toEqual(['remote', 'local']);

    const conventional = facts({
      readConventional: () => Promise.resolve('master'),
    });
    await expect(
      selectGitDefaultBranch(conventional.facts, { now: NOW }),
    ).resolves.toEqual({ defaultBranch: 'master', source: 'conventional' });
    expect(conventional.calls).toEqual(['hint', 'remote', 'local']);
  });

  it('answers null with no fact and treats a failed read as no answer', async () => {
    const failing = (): Promise<never> => Promise.reject(new Error('git'));
    await expect(
      selectGitDefaultBranch(
        {
          readHint: failing,
          readRemoteHead: failing,
          readLocalOriginHead: failing,
          readConventional: failing,
        },
        { now: NOW },
      ),
    ).resolves.toEqual({ defaultBranch: null, source: null });
  });

  it('skips the network without remote lookup and trusts a hint of any age', async () => {
    const offline = facts({
      readHint: () =>
        Promise.resolve({
          defaultBranch: 'old',
          resolvedAt: at(-GIT_DEFAULT_BRANCH_HINT_TTL_MS - 1),
        }),
      readRemoteHead: () => Promise.reject(new Error('must not run')),
    });
    await expect(
      selectGitDefaultBranch(offline.facts, {
        now: NOW,
        allowRemoteLookup: false,
      }),
    ).resolves.toEqual({ defaultBranch: 'old', source: 'stale-hint' });

    const noHint = facts({
      readLocalOriginHead: () => Promise.resolve('main'),
    });
    await expect(
      selectGitDefaultBranch(noHint.facts, {
        now: NOW,
        allowRemoteLookup: false,
      }),
    ).resolves.toEqual({ defaultBranch: 'main', source: 'local-origin-head' });
    // The overridden local read is unrecorded; no remote read happened.
    expect(noHint.calls).toEqual(['hint']);
  });
});
