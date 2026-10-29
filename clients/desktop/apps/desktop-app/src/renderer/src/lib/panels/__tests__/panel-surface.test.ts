import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { panelSurfaceForWorktreeKey } from '../panel-surface';

describe('panelSurfaceForWorktreeKey', () => {
  afterEach(() => {
    registerCoworkWorkspaceIds([]);
  });

  it('maps ordinary worktree keys to the code surface', () => {
    expect(panelSurfaceForWorktreeKey('project-1/worktree-1')).toBe('code');
  });

  it('maps registered cowork project keys to the cowork surface', () => {
    registerCoworkWorkspaceIds(['cowork-ws-1']);
    expect(
      panelSurfaceForWorktreeKey(`cowork-ws-1/${COWORK_HOME_WORKTREE_ID}`),
    ).toBe('cowork');
    // An unregistered id with the same shape stays code.
    expect(
      panelSurfaceForWorktreeKey(`other-ws/${COWORK_HOME_WORKTREE_ID}`),
    ).toBe('code');
  });

  it('maps the legacy standalone-chat sentinel to the cowork surface', () => {
    expect(
      panelSurfaceForWorktreeKey(`${STANDALONE_CHAT_PROJECT_ID}/chat-1`),
    ).toBe('cowork');
  });

  it('maps App Advisor entry keys to the cowork surface without registry help', () => {
    registerCoworkWorkspaceIds([]);
    expect(
      panelSurfaceForWorktreeKey(`${APP_ADVISOR_PROJECT_ID}/entry-1`),
    ).toBe('cowork');
    expect(
      panelSurfaceForWorktreeKey(
        `${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}`,
      ),
    ).toBe('cowork');
    // A foreign project whose worktreeId happens to be the legacy 'global'
    // slot is NOT App Advisor.
    expect(
      panelSurfaceForWorktreeKey(`other-project/${APP_ADVISOR_WORKTREE_ID}`),
    ).toBe('code');
  });
});
