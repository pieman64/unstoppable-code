import {
  getWorkspaceExternalPath,
  getWorkspaceType,
  isCoworkWorkspace,
  isWorkEntryWorkspace,
  isMultiRepoWorkspace,
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../lib/workspace-registry';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';

describe('workspace-registry cowork alias', () => {
  beforeEach(() => registerWorkspaceTypes(new Map()));

  it('treats the standalone-chat sentinel as cowork-capable without registration', () => {
    expect(isCoworkWorkspace(STANDALONE_CHAT_PROJECT_ID)).toBe(true);
    // getWorkspaceType must NOT alias the sentinel — ordering in resolveWorktreeCwd depends on null here
    expect(getWorkspaceType(STANDALONE_CHAT_PROJECT_ID)).toBeNull();
  });

  it('treats a registered cowork project id as cowork-capable', () => {
    registerWorkspaceTypes(new Map([['cw-1', 'cowork']]));
    expect(isCoworkWorkspace('cw-1')).toBe(true);
    expect(getWorkspaceType('cw-1')).toBe('cowork');
  });

  it('classifies App Advisor as Work Entry capable without treating it as cowork', () => {
    expect(isWorkEntryWorkspace(APP_ADVISOR_PROJECT_ID)).toBe(true);
    expect(isCoworkWorkspace(APP_ADVISOR_PROJECT_ID)).toBe(false);
    expect(getWorkspaceType(APP_ADVISOR_PROJECT_ID)).toBeNull();
  });

  it('does not treat single/multi-repo ids as cowork', () => {
    registerWorkspaceTypes(
      new Map([
        ['s1', 'single-repo'],
        ['m1', 'multi-repo'],
      ]),
    );
    expect(isCoworkWorkspace('s1')).toBe(false);
    expect(isCoworkWorkspace('m1')).toBe(false);
    expect(isMultiRepoWorkspace('m1')).toBe(true);
  });

  it('survives registry clear/rebuild (alias is accessor-level, not a stored entry)', () => {
    registerWorkspaceTypes(new Map([['cw-1', 'cowork']]));
    registerWorkspaceTypes(new Map()); // clears
    expect(isCoworkWorkspace(STANDALONE_CHAT_PROJECT_ID)).toBe(true); // still aliased
    expect(isCoworkWorkspace('cw-1')).toBe(false); // cleared
  });
});

describe('workspace-registry external paths', () => {
  beforeEach(() => registerWorkspaceExternalPaths(new Map()));

  it('round-trips a registered external path', () => {
    registerWorkspaceExternalPaths(
      new Map([['cw-ext', '/Users/me/attached-folder']]),
    );
    expect(getWorkspaceExternalPath('cw-ext')).toBe(
      '/Users/me/attached-folder',
    );
  });

  it('returns null for an unregistered project id', () => {
    expect(getWorkspaceExternalPath('cw-managed')).toBeNull();
  });

  it('clears stale entries on rebuild', () => {
    registerWorkspaceExternalPaths(
      new Map([['cw-ext', '/Users/me/attached-folder']]),
    );
    registerWorkspaceExternalPaths(new Map()); // rebuild without the entry
    expect(getWorkspaceExternalPath('cw-ext')).toBeNull();
  });
});
