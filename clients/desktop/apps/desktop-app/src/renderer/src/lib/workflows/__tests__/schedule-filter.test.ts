import type { AutomationAction } from '@canopy/desktop-shared/types';
import { WORKFLOW_NO_PROJECT } from '@canopy/ui-app/workflows';
import {
  automationProjectId,
  matchesScheduleProject,
} from '../schedule-filter';

const ADVISOR: AutomationAction = {
  type: 'app_advisor_prompt',
  prompt: 'Summarize',
};
const COWORK: AutomationAction = {
  type: 'standalone_prompt',
  chatProjectId: 'cowork-1',
  prompt: 'Draft',
};
const WORKTREE: AutomationAction = {
  type: 'worktree_prompt',
  workspaceId: 'project-1',
  prompt: 'Triage',
};

describe('automationProjectId', () => {
  it('reads the project each action type runs in', () => {
    expect(automationProjectId(ADVISOR)).toBeUndefined();
    expect(automationProjectId(COWORK)).toBe('cowork-1');
    expect(automationProjectId(WORKTREE)).toBe('project-1');
  });
});

describe('matchesScheduleProject', () => {
  it('passes everything with no Project filter', () => {
    for (const action of [ADVISOR, COWORK, WORKTREE]) {
      expect(matchesScheduleProject({ action }, null)).toBe(true);
    }
  });

  it('narrows to one project', () => {
    expect(matchesScheduleProject({ action: WORKTREE }, 'project-1')).toBe(
      true,
    );
    expect(matchesScheduleProject({ action: COWORK }, 'project-1')).toBe(false);
    expect(matchesScheduleProject({ action: ADVISOR }, 'project-1')).toBe(
      false,
    );
  });

  it('narrows to automations with no project', () => {
    expect(
      matchesScheduleProject({ action: ADVISOR }, WORKFLOW_NO_PROJECT),
    ).toBe(true);
    expect(
      matchesScheduleProject({ action: WORKTREE }, WORKFLOW_NO_PROJECT),
    ).toBe(false);
  });
});
