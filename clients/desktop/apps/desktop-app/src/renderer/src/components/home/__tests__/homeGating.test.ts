/**
 * @jest-environment jsdom
 */
import type {
  CoworkSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  getHomeSlashTriggerCharacters,
  hasWorkspaceChoice,
  hasNoCodeWorkspaces,
  hasNoSelectableWorkspaces,
  homeHeadingComposerGap,
  homeWorkspaceSelectedState,
  shouldRenderWorkspaceReadiness,
} from '../homeGating';

describe('getHomeSlashTriggerCharacters', () => {
  it('enables slash and dollar triggers for Codex', () => {
    expect(getHomeSlashTriggerCharacters(true)).toEqual(['/', '$']);
  });

  it('keeps non-Codex providers slash-only', () => {
    expect(getHomeSlashTriggerCharacters(false)).toEqual(['/']);
  });
});

function makeCoworkWorkspace(id = 'cowork-default'): CoworkSidebarItem {
  return {
    id,
    name: 'Default',
    type: 'cowork',
    color: '#7c3aed',
    collapsed: false,
    order: 0,
  };
}

function makeSingleRepoWorkspace(id = 'repo-1'): SingleRepoSidebarItem {
  return {
    id,
    name: 'Repo One',
    type: 'single-repo',
    repoPath: '/tmp/repo-one',
    color: '#16a34a',
    worktrees: [],
    collapsed: false,
    order: 1,
  };
}

// Pins the split between the two Home-surface gates: the "Add a project"
// CTA keys on zero CODE workspaces (cowork excluded — the default Cowork
// workspace always exists), while the composer only disables when there is
// no selectable send target of ANY kind (cowork included — it is a fully
// supported send target via dispatchHomeSend's cowork route).
describe('homeGating', () => {
  it.each([
    [null, 'false'],
    ['cowork-default', 'true'],
  ] as const)(
    'exposes project selection %p as the stable Home automation state %p',
    (workspaceId, expected) => {
      const homeSurface = document.createElement('div');
      homeSurface.dataset.workspaceSelected =
        homeWorkspaceSelectedState(workspaceId);

      expect(homeSurface.getAttribute('data-workspace-selected')).toBe(
        expected,
      );
    },
  );

  describe('project choice', () => {
    it('has no real choice when the sole sidebar project is selected', () => {
      const projects: SidebarItem[] = [makeCoworkWorkspace()];

      expect(hasWorkspaceChoice(projects, 'cowork-default')).toBe(false);
    });

    it('counts cowork and code entries as choices when there is more than one', () => {
      const projects: SidebarItem[] = [
        makeCoworkWorkspace(),
        makeSingleRepoWorkspace(),
      ];

      expect(hasWorkspaceChoice(projects, 'cowork-default')).toBe(true);
    });

    it('keeps the picker available until the sole project is selected', () => {
      expect(hasWorkspaceChoice([makeCoworkWorkspace()], null)).toBe(true);
    });
  });

  describe('zero projects of any kind (transient hydration state)', () => {
    const projects: SidebarItem[] = [];

    it('shows the Add-a-workspace CTA', () => {
      expect(hasNoCodeWorkspaces(projects)).toBe(true);
    });

    it('disables the composer (no selectable send target)', () => {
      expect(hasNoSelectableWorkspaces(projects)).toBe(true);
    });

    it('reserves readiness only while the empty inventory is hydrating', () => {
      expect(shouldRenderWorkspaceReadiness(projects, false)).toBe(true);
      expect(shouldRenderWorkspaceReadiness(projects, true)).toBe(false);
    });
  });

  describe('cowork-only install (the real fresh-install state)', () => {
    const projects: SidebarItem[] = [makeCoworkWorkspace()];

    it('still shows the Add-a-workspace CTA (no code project yet)', () => {
      expect(hasNoCodeWorkspaces(projects)).toBe(true);
    });

    it('keeps the composer ENABLED (cowork is a valid send target)', () => {
      expect(hasNoSelectableWorkspaces(projects)).toBe(false);
    });

    it('does not reserve readiness after a cowork-only inventory hydrates', () => {
      expect(shouldRenderWorkspaceReadiness(projects, true)).toBe(false);
    });
  });

  describe('code project present', () => {
    const projects: SidebarItem[] = [
      makeCoworkWorkspace(),
      makeSingleRepoWorkspace(),
    ];

    it('hides the Add-a-workspace CTA', () => {
      expect(hasNoCodeWorkspaces(projects)).toBe(false);
    });

    it('keeps the composer enabled', () => {
      expect(hasNoSelectableWorkspaces(projects)).toBe(false);
    });

    it('renders readiness after the inventory hydrates', () => {
      expect(shouldRenderWorkspaceReadiness(projects, true)).toBe(true);
    });
  });

  describe('code project only (no cowork — defensive)', () => {
    const projects: SidebarItem[] = [makeSingleRepoWorkspace()];

    it('hides the Add-a-workspace CTA', () => {
      expect(hasNoCodeWorkspaces(projects)).toBe(false);
    });

    it('keeps the composer enabled', () => {
      expect(hasNoSelectableWorkspaces(projects)).toBe(false);
    });
  });
});

describe('homeHeadingComposerGap', () => {
  it('always uses the plain 64px headline-to-stack gap', () => {
    expect(homeHeadingComposerGap()).toBe('mb-16');
  });
});
