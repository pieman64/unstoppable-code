import type { ExternalProjectCandidate } from '@canopy/desktop-shared/types';
import { collectChatHistoryProfileInput } from '../chat-history-titles';
import type { DiscoveredRoot, DiscoveredSession } from '../types';

function session(
  id: string,
  overrides: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    id,
    provider: 'claude',
    surface: 'claude-code',
    kind: 'claude-jsonl',
    cwd: '/Users/me/app',
    sourcePath: `/store/${id}.jsonl`,
    title: `Title ${id}`,
    startedAt: '2026-09-01T10:00:00.000Z',
    lastActivityAt: '2026-09-01T11:00:00.000Z',
    sizeBytes: 1,
    native: true,
    ...overrides,
  };
}

function root(rootPath: string, sessions: DiscoveredSession[]): DiscoveredRoot {
  return {
    provider: 'claude',
    surface: 'claude-code',
    rootPath,
    lastActivityAt: null,
    sessions,
  };
}

function candidate(
  id: string,
  displayName: string,
  overrides: Partial<ExternalProjectCandidate> = {},
): ExternalProjectCandidate {
  return {
    id,
    providers: ['claude'],
    surfaces: ['claude-code'],
    displayName,
    rootPath: `/Users/me/${displayName}`,
    kind: 'git',
    status: 'available',
    linkedWorktreePaths: [],
    lastActivityAt: null,
    sessions: [],
    sessionCount: 0,
    importableSessionCount: 0,
    ...overrides,
  };
}

describe('collectChatHistoryProfileInput', () => {
  it('excludes private checkout titles and ambiguous parent paths', () => {
    const privateChat = session('private', { cwd: '/Users/me/app' });
    const ambiguousChat = session('ambiguous', { cwd: '/Users/me' });
    const otherChat = session('other', { cwd: '/Users/me/other' });
    const input = collectChatHistoryProfileInput({
      roots: [root('/Users/me', [privateChat, ambiguousChat, otherChat])],
      candidates: [
        candidate('private', 'app', { sessionCount: 1 }),
        candidate('other', 'other', { sessionCount: 1 }),
      ],
      sessionsByCandidate: new Map([
        ['private', [privateChat]],
        ['other', [otherChat]],
      ]),
      excludedRoots: [],
      privateRoots: ['/Users/me/app'],
    });
    expect(input.chats.map((chat) => chat.title)).toEqual(['Title other']);
    expect(input.projects).toEqual([{ name: 'other', chatCount: 1 }]);
  });
  it('keeps native chat titles, tagged with the project that holds them', () => {
    const inApp = session('a', { title: 'Fix the login redirect' });
    const input = collectChatHistoryProfileInput({
      roots: [root('/Users/me/app', [inApp])],
      candidates: [candidate('ext-app', 'app', { sessionCount: 1 })],
      sessionsByCandidate: new Map([['ext-app', [inApp]]]),
      excludedRoots: [],
    });
    expect(input.chats).toEqual([
      {
        title: 'Fix the login redirect',
        project: 'app',
        lastActivityAt: '2026-09-01T11:00:00.000Z',
      },
    ]);
    expect(input.projects).toEqual([{ name: 'app', chatCount: 1 }]);
  });

  it('drops SDK-driven sessions, untitled sessions, and the app’s own footprint', () => {
    const input = collectChatHistoryProfileInput({
      roots: [
        root('/Users/me/app', [
          session('sdk', { native: false, title: 'Generate a branch name' }),
          session('untitled', { title: null }),
          session('kept', { title: 'Plan the Q3 roadmap' }),
        ]),
        root('/Users/me/.canopy/workspaces/w/worktrees/t', [
          session('own', {
            cwd: '/Users/me/.canopy/workspaces/w/worktrees/t',
            title: 'A chat the app ran itself',
          }),
        ]),
      ],
      candidates: [],
      sessionsByCandidate: new Map(),
      excludedRoots: ['/Users/me/.canopy'],
    });
    expect(input.chats.map((chat) => chat.title)).toEqual([
      'Plan the Q3 roadmap',
    ]);
  });

  it('keeps chats whose folder is not an importable project, such as the home directory', () => {
    const input = collectChatHistoryProfileInput({
      roots: [
        root('/Users/me', [
          session('home', {
            cwd: '/Users/me',
            title: 'Update my resume for a staff engineer role',
          }),
        ]),
      ],
      candidates: [],
      sessionsByCandidate: new Map(),
      excludedRoots: ['/Users/me/.canopy'],
    });
    expect(input.chats).toEqual([
      {
        title: 'Update my resume for a staff engineer role',
        lastActivityAt: '2026-09-01T11:00:00.000Z',
      },
    ]);
  });

  it('counts a session reported by two roots once', () => {
    const shared = session('shared', { title: 'Review the release notes' });
    const input = collectChatHistoryProfileInput({
      roots: [root('/Users/me/app', [shared]), root('/Users/me/app', [shared])],
      candidates: [],
      sessionsByCandidate: new Map(),
      excludedRoots: [],
    });
    expect(input.chats).toHaveLength(1);
  });

  it('lists projects with provider evidence only, counted by their native chats', () => {
    const first = session('one');
    const second = session('two');
    const input = collectChatHistoryProfileInput({
      roots: [root('/Users/me/app', [first, second])],
      candidates: [
        candidate('ext-app', 'app', { sessionCount: 2 }),
        candidate('ext-picked', 'picked-folder', {
          providers: [],
          surfaces: ['custom-folder'],
        }),
      ],
      sessionsByCandidate: new Map([
        ['ext-app', [first, second]],
        ['ext-picked', []],
      ]),
      excludedRoots: [],
    });
    expect(input.projects).toEqual([{ name: 'app', chatCount: 2 }]);
  });

  it('leaves out a project whose only history is SDK-driven', () => {
    const input = collectChatHistoryProfileInput({
      roots: [root('/Users/me/tool', [session('sdk', { native: false })])],
      candidates: [candidate('ext-tool', 'tool', { sessionCount: 0 })],
      sessionsByCandidate: new Map([['ext-tool', []]]),
      excludedRoots: [],
    });
    expect(input.projects).toEqual([]);
  });

  it('counts the chats of a folder that no longer exists', () => {
    const input = collectChatHistoryProfileInput({
      roots: [],
      candidates: [
        candidate('ext-gone', 'old-app', {
          status: 'unavailable',
          sessionCount: 3,
        }),
      ],
      // Missing folders are not importable, so the scan keeps no sessions
      // for them.
      sessionsByCandidate: new Map(),
      excludedRoots: [],
    });
    expect(input.projects).toEqual([{ name: 'old-app', chatCount: 3 }]);
  });
});
