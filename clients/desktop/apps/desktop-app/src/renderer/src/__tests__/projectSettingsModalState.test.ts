import {
  projectSettingsPageForTab,
  canSubmitProjectSourceDraft,
  hasProjectSourceDraft,
  hasProjectSourceHookDraft,
  shouldResetProjectSettingsModalState,
} from '../lib/projectSettingsModalState';
import type { WorkspaceSettingsDataResponse } from '@canopy/desktop-shared/types';
import { createEditableHooks } from '../lib/editableHooks';
import {
  createEditableScripts,
  setEditableScriptValue,
  setEditableScriptTimeoutSeconds,
  toScriptInputMap,
} from '../lib/editableScripts';

function createWorkspaceSettingsDataResponse(): WorkspaceSettingsDataResponse {
  return {
    manifest: null,
    localConfig: {
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
    },
    effectiveRepos: [],
    suppressedManifestRepos: [],
    unresolvedManifestRepoIds: [],
    driftIssues: [],
    driftTargetPath: '/repo/canopy.json',
  };
}

describe('shouldResetProjectSettingsModalState', () => {
  it('resets when the modal opens', () => {
    expect(
      shouldResetProjectSettingsModalState(
        true,
        false,
        'project-1',
        'project-1',
      ),
    ).toBe(true);
  });

  it('does not reset for same-project prop refreshes while already open', () => {
    expect(
      shouldResetProjectSettingsModalState(
        true,
        true,
        'project-1',
        'project-1',
      ),
    ).toBe(false);
  });

  it('resets when the open modal switches to a different project', () => {
    expect(
      shouldResetProjectSettingsModalState(
        true,
        true,
        'project-1',
        'project-2',
      ),
    ).toBe(true);
  });
});

describe('canSubmitProjectSourceDraft', () => {
  it('blocks submission until project settings finish loading', () => {
    expect(canSubmitProjectSourceDraft(false, null)).toBe(false);
  });

  it('blocks submission when project settings failed to load', () => {
    expect(canSubmitProjectSourceDraft(true, null)).toBe(false);
  });

  it('allows submission after project settings load completes', () => {
    expect(
      canSubmitProjectSourceDraft(true, createWorkspaceSettingsDataResponse()),
    ).toBe(true);
  });
});

describe('hasProjectSourceDraft', () => {
  it('returns false when source scripts match the canonical manifest (string)', () => {
    expect(
      hasProjectSourceDraft(createEditableScripts({ setup: 'npm install' }), {
        ...createWorkspaceSettingsDataResponse(),
        manifest: {
          version: 1,
          scripts: {
            setup: 'npm install',
          },
        },
      }),
    ).toBe(false);
  });

  it('returns false when source scripts match the canonical manifest (object with timeout)', () => {
    expect(
      hasProjectSourceDraft(
        createEditableScripts({
          setup: { command: 'npm install', timeoutSeconds: 900 },
        }),
        {
          ...createWorkspaceSettingsDataResponse(),
          manifest: {
            version: 1,
            scripts: {
              setup: { command: 'npm install', timeoutSeconds: 900 },
            },
          },
        },
      ),
    ).toBe(false);
  });

  it('returns true when only the timeout differs between draft and manifest', () => {
    expect(
      hasProjectSourceDraft(
        createEditableScripts({
          setup: { command: 'npm install', timeoutSeconds: 900 },
        }),
        {
          ...createWorkspaceSettingsDataResponse(),
          manifest: {
            version: 1,
            scripts: {
              setup: 'npm install',
            },
          },
        },
      ),
    ).toBe(true);
  });

  it('returns false after toggling Default → Custom → Default with no other edits', () => {
    // Simulate the UI flipping the timeout control through Custom (900s) and
    // Disabled (null) before landing back on Default (timeoutSeconds
    // undefined). The resulting editable model must canonicalize back to the
    // baseline, or save-button dirty-detection would light up on a no-op.
    const baseline = createEditableScripts({ setup: 'npm install' });
    const draftAfterCustom = setEditableScriptTimeoutSeconds(
      baseline,
      'setup',
      900,
    );
    const draftAfterDisabled = setEditableScriptTimeoutSeconds(
      draftAfterCustom,
      'setup',
      null,
    );
    const draftAfterRevert = setEditableScriptTimeoutSeconds(
      draftAfterDisabled,
      'setup',
      undefined,
    );

    expect(
      hasProjectSourceDraft(draftAfterRevert, {
        ...createWorkspaceSettingsDataResponse(),
        manifest: {
          version: 1,
          scripts: {
            setup: 'npm install',
          },
        },
      }),
    ).toBe(false);
  });

  it('ignores timeout-only lifecycle drafts until a command is set', () => {
    const timeoutOnlyDraft = setEditableScriptTimeoutSeconds({}, 'setup', 900);

    expect(toScriptInputMap(timeoutOnlyDraft)).toEqual({});
    expect(
      hasProjectSourceDraft(timeoutOnlyDraft, {
        ...createWorkspaceSettingsDataResponse(),
        manifest: {
          version: 1,
        },
      }),
    ).toBe(false);

    const draftWithCommand = setEditableScriptValue(
      timeoutOnlyDraft,
      'setup',
      'npm install',
    );

    expect(toScriptInputMap(draftWithCommand)).toEqual({
      setup: { command: 'npm install', timeoutSeconds: 900 },
    });
    expect(
      hasProjectSourceDraft(draftWithCommand, {
        ...createWorkspaceSettingsDataResponse(),
        manifest: {
          version: 1,
        },
      }),
    ).toBe(true);
  });

  it('does not serialize interactive mode for teardown lifecycles', () => {
    expect(
      toScriptInputMap({
        teardown: {
          command: 'npm run clean',
          interactive: true,
          timeoutSeconds: 120,
        },
        'before-teardown': {
          command: 'npm run before-clean',
          interactive: true,
        },
        'after-teardown': {
          command: 'npm run after-clean',
          interactive: true,
        },
      }),
    ).toEqual({
      teardown: { command: 'npm run clean', timeoutSeconds: 120 },
      'before-teardown': 'npm run before-clean',
      'after-teardown': 'npm run after-clean',
    });
  });

  it('returns true when source scripts still differ from the canonical manifest', () => {
    expect(
      hasProjectSourceDraft(
        createEditableScripts({
          setup: 'npm install',
          launch: 'npm run dev',
        }),
        {
          ...createWorkspaceSettingsDataResponse(),
          manifest: {
            version: 1,
            scripts: {
              setup: 'npm install',
            },
          },
        },
      ),
    ).toBe(true);
  });
});

describe('hasProjectSourceHookDraft', () => {
  it('returns false when source hooks match the canonical manifest', () => {
    expect(
      hasProjectSourceHookDraft(
        createEditableHooks({
          'pr:create': [{ type: 'command', command: 'echo hello' }],
        }),
        {
          ...createWorkspaceSettingsDataResponse(),
          manifest: {
            version: 1,
            hooks: {
              'pr:create': [{ type: 'command', command: 'echo hello' }],
            },
          },
        },
      ),
    ).toBe(false);
  });

  it('returns true when source hooks differ from the canonical manifest', () => {
    expect(
      hasProjectSourceHookDraft(
        createEditableHooks({
          'pr:create': [{ type: 'command', command: 'echo hello' }],
          'pr:merged': [{ type: 'command', command: 'cleanup' }],
        }),
        {
          ...createWorkspaceSettingsDataResponse(),
          manifest: {
            version: 1,
            hooks: {
              'pr:create': [{ type: 'command', command: 'echo hello' }],
            },
          },
        },
      ),
    ).toBe(true);
  });

  it('returns false for empty hooks when manifest has no hooks', () => {
    expect(
      hasProjectSourceHookDraft({}, createWorkspaceSettingsDataResponse()),
    ).toBe(false);
  });
});

describe('projectSettingsPageForTab', () => {
  it('opens each old tab on the page that now holds it', () => {
    expect(projectSettingsPageForTab(undefined)).toBe('general');
    expect(projectSettingsPageForTab('details')).toBe('general');
    expect(projectSettingsPageForTab('danger')).toBe('general');
    expect(projectSettingsPageForTab('scripts')).toBe('scripts');
    expect(projectSettingsPageForTab('hooks')).toBe('scripts');
    expect(projectSettingsPageForTab('plan-detection')).toBe('plans');
    expect(projectSettingsPageForTab('plugins')).toBe('plugins');
    expect(projectSettingsPageForTab('environment')).toBe('environment');
    expect(projectSettingsPageForTab('code-graph')).toBe('code-graph');
    expect(projectSettingsPageForTab('start-page')).toBe('start-page');
  });
});
