import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { createEditableScripts } from '../lib/editableScripts';
import {
  applySingleRepoWorktreeSourceScripts,
  getSingleRepoWorktreeEffectiveScripts,
} from '../lib/projectWorktreeScripts';

function createProject(
  overrides: Partial<SingleRepoSidebarItem> = {},
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Project',
    repoPath: '/repo',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
    effectiveScripts: {
      launch: 'npm run launch',
      legacy: 'npm run legacy',
      setup: 'npm run setup',
    },
    ...overrides,
  };
}

describe('applySingleRepoWorktreeSourceScripts', () => {
  it('adds newly applied source scripts to the effective worktree set', () => {
    expect(
      applySingleRepoWorktreeSourceScripts(
        {
          launch: 'npm run launch',
        },
        undefined,
        {},
        createEditableScripts({
          setup: 'npm run setup',
        }),
      ),
    ).toEqual({
      launch: 'npm run launch',
      setup: 'npm run setup',
    });
  });

  it('removes deleted source scripts and reapplies local overrides', () => {
    expect(
      applySingleRepoWorktreeSourceScripts(
        {
          launch: 'npm run launch',
          setup: 'npm run setup',
        },
        {
          launch: null,
        },
        createEditableScripts({
          launch: 'npm run launch',
          setup: 'npm run setup',
        }),
        createEditableScripts({
          setup: 'pnpm install',
        }),
      ),
    ).toEqual({
      launch: null,
      setup: 'pnpm install',
    });
  });

  it('round-trips a string-only source script entry as a plain string', () => {
    // Plain `setup: 'pnpm install'` should never be silently rewritten to
    // `{ command: 'pnpm install' }` on apply — legacy `canopy.json` files
    // would otherwise show as dirty diffs after a no-op apply.
    expect(
      applySingleRepoWorktreeSourceScripts(
        undefined,
        undefined,
        {},
        createEditableScripts({
          setup: 'pnpm install',
        }),
      ),
    ).toEqual({
      setup: 'pnpm install',
    });
  });

  it('preserves custom timeoutSeconds metadata when applying source overrides', () => {
    expect(
      applySingleRepoWorktreeSourceScripts(
        undefined,
        undefined,
        {},
        createEditableScripts({
          setup: { command: 'pnpm install', timeoutSeconds: 900 },
        }),
      ),
    ).toEqual({
      setup: { command: 'pnpm install', timeoutSeconds: 900 },
    });
  });

  it('preserves a disabled timeout (null) when applying source overrides', () => {
    expect(
      applySingleRepoWorktreeSourceScripts(
        undefined,
        undefined,
        {},
        createEditableScripts({
          setup: { command: 'pnpm install', timeoutSeconds: null },
        }),
      ),
    ).toEqual({
      setup: { command: 'pnpm install', timeoutSeconds: null },
    });
  });

  it('preserves interactive metadata through the shared local/source editor model', () => {
    expect(
      applySingleRepoWorktreeSourceScripts(
        undefined,
        undefined,
        {},
        createEditableScripts({
          setup: { command: 'pnpm run wizard', interactive: true },
        }),
      ),
    ).toEqual({
      setup: { command: 'pnpm run wizard', interactive: true },
    });
  });

  it('lets local overrides supersede source-controlled timeout metadata', () => {
    expect(
      applySingleRepoWorktreeSourceScripts(
        undefined,
        {
          setup: { command: 'pnpm install', timeoutSeconds: 120 },
        },
        {},
        createEditableScripts({
          setup: { command: 'pnpm install', timeoutSeconds: 900 },
        }),
      ),
    ).toEqual({
      setup: { command: 'pnpm install', timeoutSeconds: 120 },
    });
  });
});

describe('getSingleRepoWorktreeEffectiveScripts', () => {
  it('prefers the applied worktree overlay when present', () => {
    const project = createProject();

    expect(
      getSingleRepoWorktreeEffectiveScripts(project, 'wt-1', {
        'project-1/wt-1': {
          launch: 'pnpm start',
        },
      }),
    ).toEqual({
      launch: 'pnpm start',
    });
  });

  it('falls back to the project effective scripts when no overlay exists', () => {
    const project = createProject();

    expect(getSingleRepoWorktreeEffectiveScripts(project, 'wt-1', {})).toEqual(
      project.effectiveScripts,
    );
  });

  it('falls back to the project effective scripts when the applied worktree overlay is empty', () => {
    const project = createProject();

    expect(
      getSingleRepoWorktreeEffectiveScripts(project, 'wt-1', {
        'project-1/wt-1': {},
      }),
    ).toEqual(project.effectiveScripts);
  });
});
