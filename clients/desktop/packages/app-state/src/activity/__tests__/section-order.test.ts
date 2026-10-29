import type { CanopyCapabilities } from '@canopy/app-core';
import {
  CODE_ONLY_ACTIVITY_SECTION_IDS,
  DEFAULT_ACTIVITY_SECTION_ORDER,
  isActivitySectionId,
  isActivitySectionInteractive,
  isActivitySectionVisibleForTarget,
  isActivitySectionVisibleForWorkspaceType,
  isWorkActivitySection,
  mergeVisibleActivitySectionOrder,
  resolveActivitySectionOrder,
  visibleActivitySectionIds,
  WORK_ACTIVITY_SECTION_IDS,
} from '../section-order';

const DESKTOP_CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

// Mirrors the real HttpCanopyClient web relay capabilities.
const WEB_CAPS: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
};

describe('resolveActivitySectionOrder', () => {
  it('returns the full default order for empty/absent input', () => {
    expect(resolveActivitySectionOrder(undefined)).toEqual([
      ...DEFAULT_ACTIVITY_SECTION_ORDER,
    ]);
    expect(resolveActivitySectionOrder([])).toEqual([
      ...DEFAULT_ACTIVITY_SECTION_ORDER,
    ]);
  });

  it('preserves unknown ids in place while de-duplicating', () => {
    const result = resolveActivitySectionOrder([
      'hooks',
      'notes',
      'hooks',
      'summary',
    ]);
    expect(result.slice(0, 3)).toEqual(['hooks', 'notes', 'summary']);
    expect(result).toHaveLength(DEFAULT_ACTIVITY_SECTION_ORDER.length + 1);
    expect(new Set(result).size).toBe(result.length);
  });

  it('appends any default ids missing from the persisted order', () => {
    const result = resolveActivitySectionOrder(['scripts']);
    expect(result[0]).toBe('scripts');
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      expect(result).toContain(id);
    }
  });

  it('inserts Cost after pipeline runs in orders saved before Cost existed', () => {
    const result = resolveActivitySectionOrder([
      'summary',
      'pipeline-runs',
      'scripts',
    ]);

    expect(result.indexOf('cost')).toBe(result.indexOf('pipeline-runs') + 1);
  });
});

describe('mergeVisibleActivitySectionOrder', () => {
  it('moves visible ids without displacing an unknown hidden id', () => {
    const current = resolveActivitySectionOrder([
      'summary',
      'notes',
      'scripts',
      'hooks',
    ]);
    const visible = current.filter((id) => id !== 'notes');
    const reordered = [...visible];
    const scriptsIndex = reordered.indexOf('scripts');
    const hooksIndex = reordered.indexOf('hooks');
    reordered[scriptsIndex] = 'hooks';
    reordered[hooksIndex] = 'scripts';

    const result = mergeVisibleActivitySectionOrder(current, reordered);

    expect(result.indexOf('notes')).toBe(current.indexOf('notes'));
    expect(result.indexOf('hooks')).toBeLessThan(result.indexOf('scripts'));
  });

  it('keeps a hidden terminals section in its previous slot', () => {
    const current = resolveActivitySectionOrder([
      'summary',
      'terminals',
      'scripts',
      'hooks',
    ]);
    const visible = current.filter((id) => id !== 'terminals');
    const scriptsIndex = visible.indexOf('scripts');
    const hooksIndex = visible.indexOf('hooks');
    const reordered = [...visible];
    reordered[scriptsIndex] = 'hooks';
    reordered[hooksIndex] = 'scripts';

    const result = mergeVisibleActivitySectionOrder(current, reordered);

    expect(result.indexOf('terminals')).toBe(current.indexOf('terminals'));
    expect(result.indexOf('hooks')).toBeLessThan(result.indexOf('scripts'));
  });
});

describe('isActivitySectionId', () => {
  it('recognizes known ids and rejects others', () => {
    expect(isActivitySectionId('scripts')).toBe(true);
    expect(isActivitySectionId('mcp-servers')).toBe(true);
    expect(isActivitySectionId('cost')).toBe(true);
    expect(isActivitySectionId('nope')).toBe(false);
  });
});

describe('isActivitySectionInteractive', () => {
  it('treats display-only sections as never interactive', () => {
    expect(isActivitySectionInteractive('summary', DESKTOP_CAPS)).toBe(false);
    expect(isActivitySectionInteractive('todo', DESKTOP_CAPS)).toBe(false);
  });

  it('enables local-execution sections on desktop, disables on the web relay', () => {
    for (const id of ['plans', 'scripts', 'hooks', 'pull-request'] as const) {
      expect(isActivitySectionInteractive(id, DESKTOP_CAPS)).toBe(true);
      expect(isActivitySectionInteractive(id, WEB_CAPS)).toBe(false);
    }
  });

  it('gates changed-files on write access and pipeline-runs on execute', () => {
    expect(isActivitySectionInteractive('changed-files', DESKTOP_CAPS)).toBe(
      true,
    );
    expect(isActivitySectionInteractive('changed-files', WEB_CAPS)).toBe(false);
    expect(isActivitySectionInteractive('pipeline-runs', DESKTOP_CAPS)).toBe(
      true,
    );
    expect(isActivitySectionInteractive('pipeline-runs', WEB_CAPS)).toBe(false);
  });
});

describe('isActivitySectionVisibleForWorkspaceType', () => {
  it('hides every repo-bound section for a repoless cowork workspace', () => {
    expect([...CODE_ONLY_ACTIVITY_SECTION_IDS].sort()).toEqual([
      'changed-files',
      'hooks',
      'plans',
      'pull-request',
      'scripts',
    ]);
    for (const id of CODE_ONLY_ACTIVITY_SECTION_IDS) {
      expect(isActivitySectionVisibleForWorkspaceType(id, 'cowork')).toBe(
        false,
      );
    }
  });

  it('keeps the repo-independent sections for a cowork workspace', () => {
    for (const id of [
      'summary',
      'pipeline-runs',
      'background-processes',
      'mcp-servers',
      'terminals',
      'todo',
    ] as const) {
      expect(isActivitySectionVisibleForWorkspaceType(id, 'cowork')).toBe(true);
    }
  });

  it('keeps every section for repo-backed and unknown workspace types', () => {
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      expect(isActivitySectionVisibleForWorkspaceType(id, 'single-repo')).toBe(
        true,
      );
      expect(isActivitySectionVisibleForWorkspaceType(id, 'multi-repo')).toBe(
        true,
      );
      // An un-projected workspace type must not hide anything.
      expect(isActivitySectionVisibleForWorkspaceType(id, undefined)).toBe(
        true,
      );
    }
  });

  it('leaves host-only ids owned by another client visible', () => {
    // Desktop registers `notes`/`prompts`/`attachments`, which this neutral
    // union does not know; they are repo-independent and must stay visible.
    expect(isActivitySectionVisibleForWorkspaceType('notes', 'cowork')).toBe(
      true,
    );
    expect(
      isActivitySectionVisibleForWorkspaceType('attachments', 'cowork'),
    ).toBe(true);
  });
});

describe('isActivitySectionVisibleForTarget', () => {
  // What the cloud repository adapter reports: the sections it has readers
  // for. Diff, pull request, plans, scripts and hooks are not among them.
  const REPOSITORY_ALLOWLIST: readonly string[] = [
    'summary',
    'background-processes',
    'mcp-servers',
    'pipeline-runs',
    'terminals',
    'todo',
  ];
  const REPOSITORY_CAPS: CanopyCapabilities = {
    ...WEB_CAPS,
    activitySectionIds: REPOSITORY_ALLOWLIST,
  };
  const WORKSPACE_TYPES = [
    'single-repo',
    'multi-repo',
    'cowork',
    undefined,
  ] as const;

  it('enables the repository type but hides the controls its allowlist omits', () => {
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      // The type alone keeps every section for a repository project...
      expect(isActivitySectionVisibleForWorkspaceType(id, 'single-repo')).toBe(
        true,
      );
      // ...and the capability narrows that set to what is implemented.
      expect(
        isActivitySectionVisibleForTarget(id, 'single-repo', REPOSITORY_CAPS),
      ).toBe(REPOSITORY_ALLOWLIST.includes(id));
    }
    for (const id of [
      'changed-files',
      'pull-request',
      'plans',
      'scripts',
      'hooks',
    ]) {
      expect(
        isActivitySectionVisibleForTarget(id, 'single-repo', REPOSITORY_CAPS),
      ).toBe(false);
    }
  });

  it('keeps every section its type shows when no allowlist is reported (desktop, Remote Control)', () => {
    for (const capabilities of [DESKTOP_CAPS, WEB_CAPS]) {
      expect(capabilities.activitySectionIds).toBeUndefined();
      for (const type of WORKSPACE_TYPES) {
        for (const id of [
          ...DEFAULT_ACTIVITY_SECTION_ORDER,
          'notes',
          'attachments',
        ]) {
          expect(
            isActivitySectionVisibleForTarget(id, type, capabilities),
          ).toBe(isActivitySectionVisibleForWorkspaceType(id, type));
        }
      }
    }
  });

  it('leaves Cowork exactly as the type decides when no allowlist is reported', () => {
    for (const id of CODE_ONLY_ACTIVITY_SECTION_IDS) {
      expect(isActivitySectionVisibleForTarget(id, 'cowork', WEB_CAPS)).toBe(
        false,
      );
    }
    for (const id of ['summary', 'pipeline-runs', 'terminals', 'todo']) {
      expect(isActivitySectionVisibleForTarget(id, 'cowork', WEB_CAPS)).toBe(
        true,
      );
    }
  });

  it('never lets an allowlist widen what the workspace type hides', () => {
    const everything: CanopyCapabilities = {
      ...WEB_CAPS,
      activitySectionIds: [...DEFAULT_ACTIVITY_SECTION_ORDER],
    };
    for (const id of CODE_ONLY_ACTIVITY_SECTION_IDS) {
      expect(isActivitySectionVisibleForTarget(id, 'cowork', everything)).toBe(
        false,
      );
      expect(
        isActivitySectionVisibleForTarget(id, 'single-repo', everything),
      ).toBe(true);
    }
  });

  it('treats the allowlist as exact: an empty list hides everything and host ids need naming', () => {
    const none: CanopyCapabilities = { ...WEB_CAPS, activitySectionIds: [] };
    for (const id of [...DEFAULT_ACTIVITY_SECTION_ORDER, 'notes']) {
      expect(isActivitySectionVisibleForTarget(id, 'single-repo', none)).toBe(
        false,
      );
    }
    expect(
      isActivitySectionVisibleForTarget(
        'notes',
        'single-repo',
        REPOSITORY_CAPS,
      ),
    ).toBe(false);
    expect(
      isActivitySectionVisibleForTarget('notes', 'single-repo', {
        ...WEB_CAPS,
        activitySectionIds: ['notes'],
      }),
    ).toBe(true);
  });

  it('reads only the allowlist, so a host can pass just that slice', () => {
    expect(
      isActivitySectionVisibleForTarget('summary', 'single-repo', {
        activitySectionIds: ['summary'],
      }),
    ).toBe(true);
    expect(
      isActivitySectionVisibleForTarget('plans', 'single-repo', {
        activitySectionIds: undefined,
      }),
    ).toBe(true);
  });
});

describe('visibleActivitySectionIds', () => {
  it('drops the code-only ids from a cowork order while preserving position', () => {
    expect(
      visibleActivitySectionIds(
        ['summary', 'pull-request', 'notes', 'scripts', 'pipeline-runs'],
        'cowork',
      ),
    ).toEqual(['summary', 'notes', 'pipeline-runs']);
  });

  it('returns the order untouched for a repo-backed workspace', () => {
    const order = [...DEFAULT_ACTIVITY_SECTION_ORDER];
    expect(visibleActivitySectionIds(order, 'multi-repo')).toEqual(order);
  });
});

describe('WORK_ACTIVITY_SECTION_IDS', () => {
  it('admits only sections this worktree produced', () => {
    expect([...WORK_ACTIVITY_SECTION_IDS].sort()).toEqual(
      [
        'attachments',
        'background-processes',
        'changed-files',
        'cost',
        'pipeline-runs',
        'plans',
        'pull-request',
        'summary',
        'todo',
      ].sort(),
    );
  });

  it.each([
    'plugins',
    'scripts',
    'hooks',
    'mcp-servers',
    'notes',
    'prompts',
    'memory',
    'terminals',
  ])('excludes the ambient section %s', (sectionId) => {
    // These are true on a brand-new worktree in any configured workspace —
    // treating them as work would reopen the rail on every new chat and
    // neuter the CAN-2836 default collapse outright.
    expect(isWorkActivitySection(sectionId)).toBe(false);
  });

  it.each(WORK_ACTIVITY_SECTION_IDS)(
    'reports %s as work',
    (sectionId: string) => {
      expect(isWorkActivitySection(sectionId)).toBe(true);
    },
  );

  it('answers false for an unknown section id', () => {
    expect(isWorkActivitySection('not-a-section')).toBe(false);
  });

  it('treats attachments as work in a code workspace but not in Cowork', () => {
    // `resolveAgentAttachmentsDir` ignores `worktreeId` for cowork and returns
    // one workspace-level directory, so a cowork workspace holding any
    // attachment reports content on the first paint of every NEW Work Entry.
    // Counting that as work would reopen the rail on every new entry — the
    // same false positive notes/prompts/memory are excluded for.
    expect(isWorkActivitySection('attachments')).toBe(true);
    expect(isWorkActivitySection('attachments', 'cowork')).toBe(false);
  });

  it('keeps genuinely per-entry work sections as work in Cowork', () => {
    for (const sectionId of ['summary', 'changed-files', 'todo']) {
      expect(isWorkActivitySection(sectionId, 'cowork')).toBe(true);
    }
  });

  it('lists only real section ids, so a rename cannot silently disable it', () => {
    // `WORK_ACTIVITY_SECTION_IDS` is typed `readonly string[]` to accommodate
    // the desktop-only `attachments` id, which gives up the compile-time link
    // to `ActivitySectionId`. Without this check, renaming `todo`, `plans`, or
    // `pipeline-runs` would leave a stale entry here that simply stops
    // matching — the rail would quietly stop reopening with no failing test,
    // because the exact-list assertions above only pin the array against
    // itself.
    const DESKTOP_ONLY_SECTION_IDS: ReadonlySet<string> = new Set([
      'attachments',
    ]);
    for (const sectionId of WORK_ACTIVITY_SECTION_IDS) {
      if (DESKTOP_ONLY_SECTION_IDS.has(sectionId)) continue;
      expect(isActivitySectionId(sectionId)).toBe(true);
    }
  });
});
