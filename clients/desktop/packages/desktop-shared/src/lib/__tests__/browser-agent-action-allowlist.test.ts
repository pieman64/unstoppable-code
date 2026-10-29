import {
  BROWSER_AGENT_PARENT_REMOVED_ACTIONS,
  BROWSER_AGENT_PARENT_RETAINED_ACTIONS,
  BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS,
} from '@canopy/protocol/delegation/browser-agent';
import { APP_ADVISOR_ACTION_CATALOG } from '../app-advisor-actions';
import { BROWSER_ACTION_TYPES } from '@canopy/agent-actions/families/browser/schemas';

// Phase A only: pin the complete current catalog without activating its proposed
// worktree-chat policy. Cowork and App Advisor retain their current tools.
function plannedActions(): string[] {
  return [
    ...BROWSER_AGENT_PARENT_RETAINED_ACTIONS,
    ...BROWSER_AGENT_PARENT_REMOVED_ACTIONS,
    ...BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS,
  ].sort();
}

describe('browser-agent parent action policy coverage', () => {
  it('classifies every current Canopy browser action exactly once', () => {
    const actions = [...BROWSER_ACTION_TYPES].sort();
    expect(actions).toHaveLength(42);
    expect(plannedActions()).toEqual(actions);
    expect(new Set(plannedActions()).size).toBe(plannedActions().length);
  });

  it('keeps transfer management unchanged for parents', () => {
    expect(BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS).toEqual(
      expect.arrayContaining([
        'browser.list_transfers',
        'browser.cancel_transfer',
        'browser.save_download',
      ]),
    );
  });

  it('classifies page interactions as removed actions', () => {
    expect(BROWSER_AGENT_PARENT_REMOVED_ACTIONS).toEqual(
      expect.arrayContaining([
        'browser.set_checked',
        'browser.select_option',
        'browser.type',
        'browser.focus',
        'browser.wait_for',
        'browser.hover',
        'browser.scroll',
        'browser.drag',
      ]),
    );
  });

  it('classifies every current App Advisor browser action', () => {
    const actions = APP_ADVISOR_ACTION_CATALOG.map((entry) => entry.type)
      .filter((type) => type.startsWith('browser.'))
      .sort();
    expect(actions).toEqual(plannedActions());
  });
});
