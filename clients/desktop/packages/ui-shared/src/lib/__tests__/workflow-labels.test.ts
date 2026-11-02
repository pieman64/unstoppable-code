import { MARKETPLACE_TYPE_TABS } from '../marketplace-type-tabs';
import {
  WORKFLOW_ITEM_LABEL,
  WORKFLOW_ITEM_LABEL_PLURAL,
  WORKFLOW_KIND_LABELS,
  WORKFLOW_TYPE_TAB_LABELS,
  workflowSearchAlias,
} from '../workflow-labels';

describe('workflow labels (CAN-4651)', () => {
  it('never names a workflow a pipeline', () => {
    const labels = [
      WORKFLOW_ITEM_LABEL,
      WORKFLOW_ITEM_LABEL_PLURAL,
      ...Object.values(WORKFLOW_KIND_LABELS),
      ...Object.values(WORKFLOW_TYPE_TAB_LABELS),
    ];
    for (const label of labels) {
      expect(label).not.toMatch(/pipeline/i);
    }
  });

  it('names the item a workflow', () => {
    expect(WORKFLOW_ITEM_LABEL).toBe('Workflow');
    expect(WORKFLOW_ITEM_LABEL_PLURAL).toBe('Workflows');
  });

  it('tells the kinds apart by how they start', () => {
    expect(WORKFLOW_KIND_LABELS).toEqual({
      automation: 'Scheduled',
      pipeline: 'On demand',
      watcher: 'Watcher',
    });
  });

  it('names the type tabs Workflows and Scheduled workflows', () => {
    expect(WORKFLOW_TYPE_TAB_LABELS).toEqual({
      pipeline: 'Workflows',
      automation: 'Scheduled workflows',
    });
  });

  it('keeps the tab and kind ids', () => {
    expect(Object.keys(WORKFLOW_KIND_LABELS)).toEqual([
      'automation',
      'pipeline',
      'watcher',
    ]);
    // Pipelines and automations share one Workflows type tab (CAN-4261).
    const workflowTabs = MARKETPLACE_TYPE_TABS.filter(
      (tab) => tab.id === 'workflow',
    );
    expect(workflowTabs).toEqual([{ id: 'workflow', label: 'Workflows' }]);
  });

  it('keeps the former names as hidden search aliases', () => {
    expect(workflowSearchAlias('pipeline')).toBe('pipeline');
    expect(workflowSearchAlias('automation')).toBe('automation');
    expect(workflowSearchAlias('skill')).toBeUndefined();
  });
});
