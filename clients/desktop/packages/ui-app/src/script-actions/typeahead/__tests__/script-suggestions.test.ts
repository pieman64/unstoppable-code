import {
  buildScriptSuggestions,
  PERSONAL_ALIASES_GROUP,
  reviewScriptsLabel,
  SCRIPT_SUGGESTION_LIMIT,
} from '../script-suggestions';
import { scriptAction } from './fixtures';

describe('buildScriptSuggestions', () => {
  it('offers only approved, available actions, in snapshot order for an empty query', () => {
    const suggestions = buildScriptSuggestions(
      [
        scriptAction('build'),
        scriptAction('lint', { status: 'pending' }),
        scriptAction('dev'),
        scriptAction('gone', { unavailableReason: 'Source missing' }),
        scriptAction('old', { status: 'dismissed' }),
        scriptAction('test'),
      ],
      '',
    );
    expect(suggestions.map((row) => row.action.id)).toEqual([
      'build',
      'dev',
      'test',
    ]);
  });

  it('ranks over name, command, repository and package path', () => {
    const actions = [
      scriptAction('serve', { command: 'vite preview' }),
      scriptAction('start', { command: 'node server.js' }),
      scriptAction('docs', {
        repoName: 'api',
        repoId: 'api',
        target: { kind: 'repository', repoId: 'api' },
        command: 'typedoc',
      }),
      scriptAction('storybook', { packagePath: 'apps/ui', command: 'sb' }),
    ];
    expect(buildScriptSuggestions(actions, 'start')[0]?.action.id).toBe(
      'start',
    );
    expect(
      buildScriptSuggestions(actions, 'vite').map((row) => row.action.id),
    ).toEqual(['serve']);
    expect(
      buildScriptSuggestions(actions, 'api').map((row) => row.action.id),
    ).toContain('docs');
    expect(
      buildScriptSuggestions(actions, 'apps/ui').map((row) => row.action.id),
    ).toEqual(['storybook']);
  });

  it('groups by repository/package and keeps personal aliases apart', () => {
    const suggestions = buildScriptSuggestions(
      [
        scriptAction('dev'),
        scriptAction('gs', {
          kind: 'alias',
          command: 'git status',
          repoId: null,
          repoName: null,
          target: { kind: 'selected-repository' },
          source: {
            kind: 'shell-alias',
            file: '~/.zshrc',
            entry: 'gs',
            line: 3,
          },
        }),
        scriptAction('web-dev', { packagePath: 'apps/web' }),
        scriptAction('build'),
        scriptAction('root', { target: { kind: 'workspace-root' } }),
      ],
      '',
    );
    expect(suggestions.map((row) => [row.group, row.action.id])).toEqual([
      ['web', 'dev'],
      ['web', 'build'],
      [PERSONAL_ALIASES_GROUP, 'gs'],
      ['web/apps/web', 'web-dev'],
      ['Project root', 'root'],
    ]);
  });

  it('tells same-named scripts apart by package and source', () => {
    const suggestions = buildScriptSuggestions(
      [
        scriptAction('a', {
          name: 'dev',
          packagePath: 'apps/web',
          source: {
            kind: 'package-json',
            file: 'package.json',
            entry: 'dev',
            line: 2,
          },
        }),
        scriptAction('b', {
          name: 'dev',
          packagePath: 'apps/web',
          source: { kind: 'makefile', file: 'Makefile', entry: 'dev', line: 4 },
        }),
        scriptAction('c', { name: 'lint' }),
      ],
      '',
    );
    const detail = new Map(
      suggestions.map((row) => [row.action.id, row.detail]),
    );
    expect(detail.get('a')).toBe('apps/web · package.json');
    expect(detail.get('b')).toBe('apps/web · Makefile');
    expect(detail.get('c')).toBeNull();
  });

  it('caps the list at 50', () => {
    const actions = Array.from({ length: 80 }, (_, index) =>
      scriptAction(`task-${index}`),
    );
    const suggestions = buildScriptSuggestions(actions, '');
    expect(SCRIPT_SUGGESTION_LIMIT).toBe(50);
    expect(suggestions).toHaveLength(50);
    expect(suggestions[49]?.action.id).toBe('task-49');
  });

  it('previews a multiline command by its first line', () => {
    const [row] = buildScriptSuggestions(
      [
        scriptAction('setup', {
          command: 'pnpm i\npnpm build',
          multiline: true,
        }),
      ],
      '',
    );
    expect(row?.preview).toBe('pnpm i …');
  });
});

describe('reviewScriptsLabel', () => {
  it('counts the detected scripts waiting for review', () => {
    expect(reviewScriptsLabel(1)).toBe('Review 1 detected script');
    expect(reviewScriptsLabel(3)).toBe('Review 3 detected scripts');
  });
});
