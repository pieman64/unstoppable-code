import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import {
  checkScriptInvocation,
  createScriptInvocation,
  scriptInvocationArguments,
  scriptInvocationContextMatches,
  scriptInvocationDraft,
  scriptInvocationHint,
  scriptInvocationSubmission,
  SINGLE_REPOSITORY_TARGET_ID,
  type ScriptInvocationContext,
} from '../invocation';
import { scriptAction, scriptSnapshot } from './fixtures';

const context: ScriptInvocationContext = {
  projectId: 'p1',
  worktreeId: 'w1',
  selectedRepoId: null,
};

describe('script invocation state', () => {
  const dev = scriptAction('dev', {
    command: 'pnpm run dev',
    packagePath: 'apps/web',
  });
  const invocation = createScriptInvocation(dev, context);

  it('records the picked definition separately from the draft', () => {
    expect(invocation).toMatchObject({
      actionId: 'dev',
      revision: 'dev-v1',
      target: { kind: 'repository', repoId: 'web' },
      repoId: 'web',
      packagePath: 'apps/web',
      command: 'pnpm run dev',
    });
    expect(scriptInvocationDraft(invocation)).toBe('!pnpm run dev');
  });

  it('keeps appended arguments only at a whitespace boundary', () => {
    expect(scriptInvocationArguments(invocation, '!pnpm run dev')).toBe('');
    expect(
      scriptInvocationArguments(invocation, '!pnpm run dev --port 3'),
    ).toBe(' --port 3');
    expect(scriptInvocationArguments(invocation, '!pnpm run devx')).toBeNull();
    expect(scriptInvocationArguments(invocation, '!pnpm run de')).toBeNull();
    expect(scriptInvocationArguments(invocation, '!pnpm build')).toBeNull();
    expect(scriptInvocationArguments(invocation, '')).toBeNull();
    expect(scriptInvocationArguments(invocation, 'pnpm run dev')).toBeNull();
    // A new line of input ends the invocation; trailing blank lines do not.
    expect(
      scriptInvocationArguments(invocation, '!pnpm run dev\nrm -rf x'),
    ).toBeNull();
    expect(scriptInvocationArguments(invocation, '!pnpm run dev\n')).toBe('');
  });

  it('sends the full multiline body plus appended text, in its package', () => {
    const setup = createScriptInvocation(
      scriptAction('setup', {
        command: 'pnpm install\npnpm build',
        multiline: true,
        packagePath: 'apps/web',
      }),
      context,
    );
    expect(scriptInvocationDraft(setup)).toBe('!pnpm install\npnpm build');
    expect(
      scriptInvocationSubmission(setup, '!pnpm install\npnpm build --filter x'),
    ).toEqual({
      command: 'pnpm install\npnpm build --filter x',
      selectedRepoId: 'web',
      relativeCwd: 'apps/web',
    });
    expect(
      scriptInvocationSubmission(setup, '!pnpm install\npnpm buil'),
    ).toBeNull();
  });

  it('targets the repository, the workspace root or the selected repository', () => {
    const root = createScriptInvocation(
      scriptAction('root', {
        target: { kind: 'workspace-root' },
        repoId: null,
      }),
      { ...context, selectedRepoId: 'api' },
    );
    expect(scriptInvocationSubmission(root, '!pnpm run root')).toEqual({
      command: 'pnpm run root',
      selectedRepoId: WORKSPACE_ROOT_REPO_ID,
    });
    const alias = createScriptInvocation(
      scriptAction('gs', {
        kind: 'alias',
        command: 'git status',
        target: { kind: 'selected-repository' },
      }),
      { ...context, selectedRepoId: 'api' },
    );
    expect(scriptInvocationSubmission(alias, '!git status -s')).toEqual({
      command: 'git status -s',
      selectedRepoId: 'api',
    });
    const single = createScriptInvocation(
      scriptAction('dev', {
        target: { kind: 'repository', repoId: SINGLE_REPOSITORY_TARGET_ID },
      }),
      context,
    );
    // A single repository runs in the checkout an omitted id resolves to.
    expect(scriptInvocationSubmission(single, '!pnpm run dev')).toEqual({
      command: 'pnpm run dev',
    });
  });

  it('is invalidated by a project, worktree or repository switch', () => {
    expect(scriptInvocationContextMatches(invocation, context)).toBe(true);
    expect(
      scriptInvocationContextMatches(invocation, {
        ...context,
        worktreeId: 'w2',
      }),
    ).toBe(false);
    expect(
      scriptInvocationContextMatches(invocation, {
        ...context,
        projectId: 'p2',
      }),
    ).toBe(false);
    expect(
      scriptInvocationContextMatches(invocation, {
        ...context,
        selectedRepoId: 'api',
      }),
    ).toBe(false);
  });

  it('goes stale when approval, availability or the revision changes', () => {
    expect(checkScriptInvocation(invocation, scriptSnapshot([dev])).ok).toBe(
      true,
    );
    expect(checkScriptInvocation(invocation, scriptSnapshot([]))).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      checkScriptInvocation(
        invocation,
        scriptSnapshot([{ ...dev, revision: 'dev-v2' }]),
      ),
    ).toEqual({ ok: false, reason: 'changed' });
    expect(
      checkScriptInvocation(
        invocation,
        scriptSnapshot([{ ...dev, status: 'pending' }]),
      ),
    ).toEqual({ ok: false, reason: 'not-approved' });
    expect(
      checkScriptInvocation(
        invocation,
        scriptSnapshot([{ ...dev, unavailableReason: 'Source missing' }]),
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('names the directory when it is not the composer’s own', () => {
    expect(scriptInvocationHint(invocation, true)).toBe('Runs in web/apps/web');
    const plain = createScriptInvocation(scriptAction('lint'), {
      ...context,
      selectedRepoId: 'web',
    });
    expect(scriptInvocationHint(plain, true)).toBeNull();
    const elsewhere = createScriptInvocation(scriptAction('lint'), context);
    expect(scriptInvocationHint(elsewhere, true)).toBe('Runs in web');
    expect(scriptInvocationHint(elsewhere, false)).toBeNull();
  });
});
