import {
  extractCommandPrefix,
  getSlashCommandInsertText,
} from '../hooks/useSlashCommands';

describe('useSlashCommands helpers', () => {
  it('treats leading slash as a command trigger', () => {
    expect(extractCommandPrefix('/branch')).toBe('branch');
    expect(extractCommandPrefix('/')).toBe('');
  });

  it('treats leading dollar sign as a command trigger', () => {
    expect(extractCommandPrefix('$ud-git:branch-naming')).toBe(
      'ud-git:branch-naming',
    );
    expect(extractCommandPrefix('$')).toBe('');
  });

  it('treats inline slash and dollar references as command triggers', () => {
    expect(extractCommandPrefix('run /branch')).toBe('branch');
    expect(extractCommandPrefix('use $ud-git:branch-naming')).toBe(
      'ud-git:branch-naming',
    );
  });

  it('respects the allowed trigger characters', () => {
    expect(extractCommandPrefix('run /branch', ['/'])).toBe('branch');
    expect(extractCommandPrefix('use $branch', ['/'])).toBeNull();
    expect(extractCommandPrefix('use /branch', ['/', '$'])).toBe('branch');
  });

  it('keeps Codex skill insertion text when slash triggered the menu', () => {
    expect(
      getSlashCommandInsertText(
        {
          name: 'ud-git:branch-naming',
          description: 'Branch naming',
          displayName: '$ud-git:branch-naming',
          insertText: '$ud-git:branch-naming ',
        },
        '/',
      ),
    ).toBe('$ud-git:branch-naming ');
  });

  it('ignores completed, embedded, or path-like content', () => {
    expect(extractCommandPrefix('/branch now')).toBeNull();
    expect(extractCommandPrefix('src/foo')).toBeNull();
    expect(extractCommandPrefix('https://example.com/path')).toBeNull();
  });
});
