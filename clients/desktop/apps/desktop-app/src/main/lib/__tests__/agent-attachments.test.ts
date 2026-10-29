import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { resolveAgentAttachmentsDir } from '../agent-attachments';
import {
  getAppAdvisorHomeDir,
  getCoworkWorkspaceRootDir,
  getWorktreeAttachmentsDir,
} from '../paths';
import {
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../workspace-registry';

/**
 * The attachments directory is resolved independently by `resolveAgentAttachmentsDir`
 * and by the chat turn path (`worktree-chat-turn.ts`, which picks between the
 * cowork managed subdir and `getWorktreeAttachmentsDir`). These assertions pin
 * this resolver to the same two destinations, so a divergence shows up here
 * rather than as an attachment written where the agent never looks.
 */
describe('resolveAgentAttachmentsDir', () => {
  afterEach(() => {
    registerWorkspaceTypes(new Map());
    registerWorkspaceExternalPaths(new Map());
  });

  it('uses the per-worktree attachments dir for a code workspace', () => {
    registerWorkspaceTypes(new Map([['workspace-1', 'single-repo']]));

    expect(resolveAgentAttachmentsDir('workspace-1', 'worktree-1')).toBe(
      getWorktreeAttachmentsDir('workspace-1', 'worktree-1'),
    );
  });

  it('uses the managed attachments subdir of the resolved root for a cowork workspace', () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));

    expect(resolveAgentAttachmentsDir('cowork-1', 'entry-1')).toBe(
      getCoworkManagedSubdir(
        getCoworkWorkspaceRootDir('cowork-1'),
        'attachments',
      ),
    );
  });

  it('honors an attached external folder for a cowork workspace', () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    registerWorkspaceExternalPaths(new Map([['cowork-1', '/tmp/attached']]));

    expect(resolveAgentAttachmentsDir('cowork-1', 'entry-1')).toBe(
      getCoworkManagedSubdir('/tmp/attached', 'attachments'),
    );
  });

  it('uses the App Advisor home for the App Advisor scope', () => {
    expect(resolveAgentAttachmentsDir(APP_ADVISOR_PROJECT_ID, 'entry-1')).toBe(
      getCoworkManagedSubdir(getAppAdvisorHomeDir(), 'attachments'),
    );
  });
});
