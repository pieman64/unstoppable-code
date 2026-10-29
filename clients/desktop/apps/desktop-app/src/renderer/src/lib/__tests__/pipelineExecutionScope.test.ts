import {
  pipelineSupportsExecutionScope,
  readPipelineInfoScopes,
  readPipelineScopeSelection,
  toPipelineScopeValue,
} from '../pipelineExecutionScope';

describe('pipelineSupportsExecutionScope', () => {
  it('treats a missing scopes field as ["directory"]', () => {
    // Legacy/no-scope pipelines appear on directory surfaces...
    expect(pipelineSupportsExecutionScope({}, 'directory')).toBe(true);
    // ...AND on worktree surfaces (a worktree provides a directory cwd).
    expect(pipelineSupportsExecutionScope({}, 'worktree')).toBe(true);
    // ...but not on a global surface.
    expect(pipelineSupportsExecutionScope({}, 'global')).toBe(false);
  });

  it('keeps directory-declared pipelines visible on worktree surfaces', () => {
    expect(
      pipelineSupportsExecutionScope({ scopes: ['directory'] }, 'worktree'),
    ).toBe(true);
  });

  it('hides worktree-only pipelines from directory and global surfaces', () => {
    expect(
      pipelineSupportsExecutionScope({ scopes: ['worktree'] }, 'directory'),
    ).toBe(false);
    expect(
      pipelineSupportsExecutionScope({ scopes: ['worktree'] }, 'global'),
    ).toBe(false);
    expect(
      pipelineSupportsExecutionScope({ scopes: ['worktree'] }, 'worktree'),
    ).toBe(true);
  });

  it('matches global only on global surfaces', () => {
    expect(
      pipelineSupportsExecutionScope({ scopes: ['global'] }, 'global'),
    ).toBe(true);
    expect(
      pipelineSupportsExecutionScope({ scopes: ['global'] }, 'directory'),
    ).toBe(false);
    expect(
      pipelineSupportsExecutionScope({ scopes: ['global'] }, 'worktree'),
    ).toBe(false);
  });
});

describe('readPipelineInfoScopes', () => {
  it('returns the implicit directory scope for legacy rows with no scopes field', () => {
    expect(readPipelineInfoScopes({})).toEqual(['directory']);
  });

  it('returns declared pipeline info scopes', () => {
    expect(readPipelineInfoScopes({ scopes: ['global', 'worktree'] })).toEqual([
      'global',
      'worktree',
    ]);
  });
});

describe('readPipelineScopeSelection', () => {
  it('defaults a missing declaration to ["directory"]', () => {
    expect(readPipelineScopeSelection(undefined)).toEqual(['directory']);
  });

  it('reads a single string scope', () => {
    expect(readPipelineScopeSelection('worktree')).toEqual(['worktree']);
  });

  it('reads an array of scopes', () => {
    expect(readPipelineScopeSelection(['global', 'worktree'])).toEqual([
      'global',
      'worktree',
    ]);
  });

  it('drops unknown/duplicate values and falls back when empty', () => {
    expect(readPipelineScopeSelection(['directory', 'directory'])).toEqual([
      'directory',
    ]);
    expect(readPipelineScopeSelection('chat-project')).toEqual(['directory']);
  });
});

describe('toPipelineScopeValue', () => {
  it('writes a single selected scope as a bare string', () => {
    expect(toPipelineScopeValue(['directory'])).toBe('directory');
    expect(toPipelineScopeValue(['worktree'])).toBe('worktree');
  });

  it('writes multiple selected scopes as a canonically ordered array', () => {
    expect(toPipelineScopeValue(['worktree', 'global'])).toEqual([
      'global',
      'worktree',
    ]);
    expect(toPipelineScopeValue(['worktree', 'directory', 'global'])).toEqual([
      'global',
      'directory',
      'worktree',
    ]);
  });
});
