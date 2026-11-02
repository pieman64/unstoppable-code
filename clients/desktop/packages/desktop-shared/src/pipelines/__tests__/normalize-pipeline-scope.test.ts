import {
  ALL_PIPELINE_EXECUTION_SCOPES,
  DEFAULT_PIPELINE_SCOPES,
  executionContextSatisfies,
  isPipelineExecutionScope,
  normalizeActionScopes,
  normalizePipelineScopes,
  reachableExecutionContexts,
  scopesOverlap,
} from '../scope';
import { normalizePipelineRunTarget } from '../target';
import type { PipelineExecutionScope } from '../../types/pipeline';

describe('normalizePipelineScopes', () => {
  it('defaults a missing pipeline scope to ["directory"]', () => {
    expect(normalizePipelineScopes(undefined, 'Pipeline')).toEqual([
      'directory',
    ]);
    expect(normalizePipelineScopes(null, 'Pipeline')).toEqual(['directory']);
    expect(DEFAULT_PIPELINE_SCOPES).toEqual(['directory']);
  });

  it('accepts a single string scope', () => {
    expect(normalizePipelineScopes('worktree', 'Pipeline')).toEqual([
      'worktree',
    ]);
    expect(normalizePipelineScopes('global', 'Pipeline')).toEqual(['global']);
  });

  it('accepts an array of scopes preserving order', () => {
    expect(
      normalizePipelineScopes(['directory', 'worktree'], 'Pipeline'),
    ).toEqual(['directory', 'worktree']);
  });

  it('rejects duplicate scopes', () => {
    expect(() =>
      normalizePipelineScopes(['directory', 'directory'], 'Pipeline'),
    ).toThrow('Pipeline scope contains duplicate value "directory"');
  });

  it('rejects an empty array', () => {
    expect(() => normalizePipelineScopes([], 'Pipeline')).toThrow(
      'Pipeline scope must contain at least one scope',
    );
  });

  it('rejects the unsupported chat-project scope with a location-specific message', () => {
    expect(() => normalizePipelineScopes('chat-project', 'Pipeline')).toThrow(
      'Pipeline scope "chat-project" is not supported. Supported values: global, directory, worktree',
    );
    expect(() =>
      normalizePipelineScopes(['directory', 'chat-project'], 'Pipeline'),
    ).toThrow(
      'Pipeline scope "chat-project" is not supported. Supported values: global, directory, worktree',
    );
  });

  it('rejects non-string, non-array values', () => {
    expect(() => normalizePipelineScopes(123, 'Pipeline')).toThrow(
      'Pipeline scope must be a string or string array',
    );
  });
});

describe('normalizeActionScopes', () => {
  it('defaults a missing action scope to all scopes', () => {
    expect(normalizeActionScopes(undefined, 'Action "/x/action.yml"')).toEqual([
      'global',
      'directory',
      'worktree',
    ]);
    expect(ALL_PIPELINE_EXECUTION_SCOPES).toEqual([
      'global',
      'directory',
      'worktree',
    ]);
  });

  it('accepts string and array forms like pipeline scopes', () => {
    expect(normalizeActionScopes('worktree', 'Action "/x"')).toEqual([
      'worktree',
    ]);
    expect(
      normalizeActionScopes(['global', 'directory'], 'Action "/x"'),
    ).toEqual(['global', 'directory']);
  });

  it('uses the action location prefix in error messages', () => {
    expect(() =>
      normalizeActionScopes(123, 'Action "/abs/path/action.yml"'),
    ).toThrow(
      'Action "/abs/path/action.yml" scope must be a string or string array',
    );
  });
});

describe('isPipelineExecutionScope', () => {
  it('recognizes valid scopes and rejects everything else', () => {
    expect(isPipelineExecutionScope('global')).toBe(true);
    expect(isPipelineExecutionScope('directory')).toBe(true);
    expect(isPipelineExecutionScope('worktree')).toBe(true);
    expect(isPipelineExecutionScope('inherit')).toBe(false);
    expect(isPipelineExecutionScope('chat-project')).toBe(false);
    expect(isPipelineExecutionScope(undefined)).toBe(false);
    expect(isPipelineExecutionScope(42)).toBe(false);
  });
});

describe('executionContextSatisfies (capability truth table)', () => {
  const contexts: PipelineExecutionScope[] = [
    'global',
    'directory',
    'worktree',
  ];

  it('a worktree context satisfies directory requirements (worktree ⊇ directory)', () => {
    expect(executionContextSatisfies(['directory'], 'worktree')).toBe(true);
    expect(executionContextSatisfies(['directory'], 'directory')).toBe(true);
    expect(executionContextSatisfies(['directory'], 'global')).toBe(false);
  });

  it('a worktree-only pipeline does NOT run in a plain directory or global context', () => {
    expect(executionContextSatisfies(['worktree'], 'worktree')).toBe(true);
    expect(executionContextSatisfies(['worktree'], 'directory')).toBe(false);
    expect(executionContextSatisfies(['worktree'], 'global')).toBe(false);
  });

  it('a global-only pipeline only runs in a global context', () => {
    expect(executionContextSatisfies(['global'], 'global')).toBe(true);
    expect(executionContextSatisfies(['global'], 'directory')).toBe(false);
    expect(executionContextSatisfies(['global'], 'worktree')).toBe(false);
  });

  it('directory/global contexts never provide a worktree', () => {
    for (const declared of [['directory'], ['global']] as const) {
      expect(executionContextSatisfies(declared, 'worktree')).toBe(
        declared[0] === 'directory',
      );
    }
    // exhaustively reference all contexts so the table is explicit
    expect(contexts).toHaveLength(3);
  });
});

describe('reachableExecutionContexts', () => {
  it('expands directory to include worktree', () => {
    expect(reachableExecutionContexts(['directory'])).toEqual([
      'directory',
      'worktree',
    ]);
  });

  it('keeps worktree as worktree-only', () => {
    expect(reachableExecutionContexts(['worktree'])).toEqual(['worktree']);
  });

  it('keeps global as global-only', () => {
    expect(reachableExecutionContexts(['global'])).toEqual(['global']);
  });

  it('unions across declared scopes', () => {
    expect(reachableExecutionContexts(['global', 'directory'])).toEqual([
      'global',
      'directory',
      'worktree',
    ]);
  });
});

describe('scopesOverlap (over reachable contexts)', () => {
  it('a directory pipeline overlaps a worktree action (backwards compatible)', () => {
    // directory -> {directory, worktree}; worktree -> {worktree}; overlap on worktree.
    expect(scopesOverlap(['directory'], ['worktree'])).toBe(true);
  });

  it('global does not overlap worktree or directory', () => {
    expect(scopesOverlap(['global'], ['worktree'])).toBe(false);
    expect(scopesOverlap(['global'], ['directory'])).toBe(false);
  });

  it('identical scopes overlap', () => {
    expect(scopesOverlap(['global'], ['global'])).toBe(true);
    expect(scopesOverlap(['worktree'], ['worktree'])).toBe(true);
  });
});

describe('normalizePipelineRunTarget', () => {
  it('returns undefined for an undefined target', () => {
    expect(normalizePipelineRunTarget(undefined, 'step "a"')).toBeUndefined();
    expect(normalizePipelineRunTarget(null, 'step "a"')).toBeUndefined();
  });

  it('accepts inherit', () => {
    expect(normalizePipelineRunTarget({ scope: 'inherit' }, 'step')).toEqual({
      scope: 'inherit',
    });
  });

  it('accepts global', () => {
    expect(normalizePipelineRunTarget({ scope: 'global' }, 'step')).toEqual({
      scope: 'global',
    });
  });

  it('accepts directory with and without a path', () => {
    expect(normalizePipelineRunTarget({ scope: 'directory' }, 'step')).toEqual({
      scope: 'directory',
    });
    expect(
      normalizePipelineRunTarget(
        { scope: 'directory', path: './sub/dir' },
        'step',
      ),
    ).toEqual({ scope: 'directory', path: './sub/dir' });
  });

  it('accepts an absolute directory path', () => {
    expect(
      normalizePipelineRunTarget(
        { scope: 'directory', path: '/abs/path' },
        'step',
      ),
    ).toEqual({ scope: 'directory', path: '/abs/path' });
  });

  it('accepts an existing worktree target', () => {
    expect(
      normalizePipelineRunTarget(
        { scope: 'worktree', workspace_id: 'ws1', worktree: { id: 'wt1' } },
        'step',
      ),
    ).toEqual({
      scope: 'worktree',
      workspace_id: 'ws1',
      worktree: { id: 'wt1' },
    });
  });

  it('rejects camelCase target fields as unexpected', () => {
    expect(() =>
      normalizePipelineRunTarget(
        {
          scope: 'worktree',
          workspaceId: 'ws1',
          worktree: { id: 'wt1' },
        },
        'step',
      ),
    ).toThrow(/unexpected field\(s\): workspaceId/);
  });

  it('rejects camelCase worktree creation fields as unexpected', () => {
    expect(() =>
      normalizePipelineRunTarget(
        {
          scope: 'worktree',
          workspace_id: 'ws1',
          worktree: { id: 'wt1' },
          baseBranch: 'develop',
        },
        'step',
      ),
    ).toThrow(/unexpected field\(s\): baseBranch/);
  });

  it('requires worktree.id for worktree targets', () => {
    expect(() =>
      normalizePipelineRunTarget(
        { scope: 'worktree', workspace_id: 'ws1', worktree: {} },
        'step',
      ),
    ).toThrow('target.worktree.id must be a non-empty string');
  });

  it('rejects worktree.new', () => {
    expect(() =>
      normalizePipelineRunTarget(
        {
          scope: 'worktree',
          workspace_id: 'ws1',
          worktree: { new: true },
        },
        'step',
      ),
    ).toThrow('target.worktree.new is no longer supported');
    expect(() =>
      normalizePipelineRunTarget(
        { scope: 'worktree', workspace_id: 'ws1', worktree: { new: false } },
        'step',
      ),
    ).toThrow('target.worktree.new is no longer supported');
  });

  it('requires workspace_id for worktree targets', () => {
    expect(() =>
      normalizePipelineRunTarget(
        { scope: 'worktree', worktree: { id: 'wt1' } },
        'step',
      ),
    ).toThrow('target.workspace_id');
  });

  it('rejects removed worktree creation fields on run-pipeline targets', () => {
    expect(() =>
      normalizePipelineRunTarget(
        {
          scope: 'worktree',
          workspace_id: 'ws1',
          worktree: { id: 'wt1' },
          branch: 'feature',
        },
        'step',
      ),
    ).toThrow(/no longer supports worktree creation field\(s\): branch/);
    expect(() =>
      normalizePipelineRunTarget(
        {
          scope: 'worktree',
          workspace_id: 'ws1',
          worktree: { id: 'wt1' },
          repair: true,
        },
        'step',
      ),
    ).toThrow(/no longer supports worktree creation field\(s\): repair/);
  });

  it('rejects path/workspace fields on global and inherit targets', () => {
    expect(() =>
      normalizePipelineRunTarget({ scope: 'global', path: '/abs' }, 'step'),
    ).toThrow(/unexpected field\(s\): path/);
    expect(() =>
      normalizePipelineRunTarget(
        { scope: 'inherit', workspace_id: 'ws1' },
        'step',
      ),
    ).toThrow(/unexpected field\(s\): workspace_id/);
  });

  it('requires a scope and rejects an unsupported scope', () => {
    expect(() => normalizePipelineRunTarget({ path: '/abs' }, 'step')).toThrow(
      'target.scope is required',
    );
    expect(() =>
      normalizePipelineRunTarget({ scope: 'chat-project' }, 'step'),
    ).toThrow(/target\.scope "chat-project" is not supported/);
  });

  it('rejects non-object targets', () => {
    expect(() => normalizePipelineRunTarget('global', 'step')).toThrow(
      'target must be an object',
    );
  });
});
