import {
  getWorktreeBranchChoiceHint,
  getWorktreeDeleteLabels,
} from '../worktree-removal-labels';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';

const BRANCH = 'feature-x';

describe('getWorktreeDeleteLabels', () => {
  describe('delete mode (retained when a restorable archive can be created)', () => {
    it('uses Delete framing for both action labels', () => {
      const labels = getWorktreeDeleteLabels('delete', 7, BRANCH);
      expect(labels.archiveActionLabel).toBe('Delete feature-x');
      expect(labels.standaloneActionLabel).toBe('Delete feature-x');
      expect(labels.dialogTitle).toBe('Delete worktree?');
      expect(labels.dialogConfirmLabel).toBe('Delete worktree');
      expect(labels.dialogDestructive).toBe(true);
    });

    it('conditions the retention promise on creating a restorable archive', () => {
      const labels = getWorktreeDeleteLabels('delete', 5, BRANCH);
      expect(labels.retentionSummary).toBe(
        'Restorable for 5 days when an archive can be created.',
      );
      expect(labels.retentionDetail).toBe(
        'Deleting removes the worktree from disk and its chat from the ' +
          'sidebar. When a restorable archive can be created, its Git state, ' +
          'chats, and eligible workflow history are kept for 5 days. ' +
          'Otherwise, deletion is permanent.',
      );
      expect(labels.localWorkRetentionDetail).toBe(
        'Deleting removes the worktree from disk and its chat from the ' +
          'sidebar. When a restorable archive can be created, its commits, ' +
          'local changes, chats, and eligible workflow history are kept for ' +
          '5 days. Otherwise, deletion is permanent.',
      );
    });

    it('uses singular wording for a 1-day window', () => {
      const labels = getWorktreeDeleteLabels('delete', 1, BRANCH);
      expect(labels.retentionSummary).toContain('for 1 day ');
      expect(labels.retentionDetail).toContain('for 1 day.');
      expect(labels.localWorkRetentionDetail).toContain('for 1 day.');
    });

    it('warns that deletion is permanent when no restorable archive can be created', () => {
      const labels = getWorktreeDeleteLabels('delete', 7, BRANCH);
      expect(labels.retentionSummary).toContain(
        'when an archive can be created',
      );
      expect(labels.retentionDetail).toContain(
        'Otherwise, deletion is permanent.',
      );
      expect(labels.localWorkRetentionDetail).toContain(
        'Otherwise, deletion is permanent.',
      );
    });
  });

  describe('archive mode (kept until deleted)', () => {
    it('uses Archive framing for both action labels', () => {
      const labels = getWorktreeDeleteLabels('archive', 7, BRANCH);
      expect(labels.archiveActionLabel).toBe('Archive feature-x');
      expect(labels.standaloneActionLabel).toBe('Archive feature-x');
      expect(labels.dialogTitle).toBe('Archive worktree?');
      expect(labels.dialogConfirmLabel).toBe('Archive worktree');
      expect(labels.dialogDestructive).toBe(false);
    });

    it('conditions Git restoration on creating a restorable archive', () => {
      const labels = getWorktreeDeleteLabels('archive', 5, BRANCH);
      expect(labels.retentionSummary).toBe(
        'Kept until you delete the archive.',
      );
      expect(labels.retentionDetail).toBe(
        'Archiving removes the worktree from disk and keeps its chats and ' +
          'eligible workflow history until you delete the archive. When a ' +
          'restorable archive can be created, its Git state is kept too, and ' +
          'restoring recreates that state in a new worktree.',
      );
      expect(labels.localWorkRetentionDetail).toBe(
        'Archiving removes the worktree from disk and keeps its chats and ' +
          'eligible workflow history until you delete the archive. When a ' +
          'restorable archive can be created, its commits and local changes ' +
          'are kept too, and restoring recreates that state in a new worktree.',
      );
      expect(labels.retentionDetail).not.toContain('5 days');
      expect(labels.retentionDetail).not.toContain('missing');
      expect(labels.localWorkRetentionDetail).not.toContain('missing');
    });
  });

  describe('getWorktreeBranchChoiceHint', () => {
    it('adds no note without an App Advisor request', () => {
      expect(getWorktreeBranchChoiceHint()).toBeNull();
    });

    it('names the branch handling an App Advisor request asked for', () => {
      expect(getWorktreeBranchChoiceHint(true)).toBe(
        `${ORCHESTRATOR_LABEL} suggested deleting it.`,
      );
      expect(getWorktreeBranchChoiceHint(false)).toBe(
        `${ORCHESTRATOR_LABEL} suggested keeping it.`,
      );
    });
  });
});
