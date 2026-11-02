import type { EntryDetailReturnContext } from '@/stores/navigationStore';
import { resolveWorkflowEditBack, workflowEditBackLabel } from '../edit-back';
import type { WorkflowEditTarget } from '../edit-target';

const marketplace = { query: 'deploy', tab: 'workflow' as const };

describe('resolveWorkflowEditBack', () => {
  it.each<WorkflowEditTarget>([
    { kind: 'pipeline', pipelineId: 'deploy' },
    { kind: 'pipeline', pipelineId: null, draftKey: 'draft' },
    { kind: 'automation', activityId: 'act-1' },
    { kind: 'automation-draft', draftKey: 'draft' },
    { kind: 'shared-automation', remoteId: 'share-1' },
  ])('returns $kind with no origin to the Library', (target) => {
    expect(resolveWorkflowEditBack(target)).toEqual({ kind: 'library' });
    expect(workflowEditBackLabel(target)).toBe('Library');
  });

  it('reopens the source pipeline with its own return fields', () => {
    const target: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'similar',
      returnToPipeline: {
        pipelineId: 'source',
        cwd: '/repo',
        filePath: '/repo/source.yaml',
        source: 'user',
        returnToEntryId: 'skill:src:name',
        returnToMarketplace: marketplace,
      },
    };
    expect(resolveWorkflowEditBack(target)).toEqual({
      kind: 'edit',
      target: {
        kind: 'pipeline',
        pipelineId: 'source',
        cwd: '/repo',
        filePath: '/repo/source.yaml',
        source: 'user',
        returnToEntryId: 'skill:src:name',
        returnToMarketplace: marketplace,
      },
    });
    expect(workflowEditBackLabel(target)).toBe('Workflow');
  });

  it('restores the capability detail with its whole stack', () => {
    const context: EntryDetailReturnContext = {
      entryId: 'mkt:m/plugin',
      stack: ['curated:first'],
      pipelineReturn: { pipelineId: 'origin' },
      fromInstalled: true,
      managementReturn: 'skills',
      marketplace,
    };
    const target: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'deploy',
      returnToEntryContext: context,
      // The fuller context wins over the single entry id.
      returnToEntryId: 'ignored',
    };
    expect(resolveWorkflowEditBack(target)).toEqual({
      kind: 'plugins',
      intent: {
        kind: 'entry-detail',
        entryId: 'mkt:m/plugin',
        from: {
          kind: 'entry-context',
          stack: ['curated:first'],
          pipelineReturn: { pipelineId: 'origin' },
          fromInstalled: true,
          managementReturn: 'skills',
          marketplace,
        },
      },
    });
    expect(workflowEditBackLabel(target)).toBe('Customize');
  });

  it('restores a single capability detail', () => {
    expect(
      resolveWorkflowEditBack({
        kind: 'pipeline',
        pipelineId: 'deploy',
        returnToEntryId: 'skill:src:name',
        returnToMarketplace: marketplace,
      }),
    ).toEqual({
      kind: 'plugins',
      intent: { kind: 'entry-detail', entryId: 'skill:src:name' },
    });
  });

  it('restores Customize search', () => {
    const target: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'deploy',
      returnToMarketplace: marketplace,
    };
    expect(resolveWorkflowEditBack(target)).toEqual({
      kind: 'plugins',
      intent: { kind: 'marketplace-browse', ...marketplace },
    });
    expect(workflowEditBackLabel(target)).toBe('Customize');
  });

  it('prefers returnTo over a pipeline origin', () => {
    const target: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'deploy',
      returnToMarketplace: marketplace,
      returnTo: { kind: 'automation', activityId: 'act-1' },
    };
    expect(resolveWorkflowEditBack(target)).toEqual({
      kind: 'edit',
      target: { kind: 'automation', activityId: 'act-1' },
    });
    expect(workflowEditBackLabel(target)).toBe('Automation');
  });

  it('walks a returnTo chain one level per Back', () => {
    // Marketplace → pipeline → automation from its Trigger section.
    const pipeline: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'deploy',
      section: 'trigger',
      returnToMarketplace: marketplace,
    };
    const automation: WorkflowEditTarget = {
      kind: 'automation',
      activityId: 'act-1',
      returnTo: pipeline,
    };

    const first = resolveWorkflowEditBack(automation);
    expect(first).toEqual({ kind: 'edit', target: pipeline });
    expect(workflowEditBackLabel(automation)).toBe('Workflow');
    if (first.kind !== 'edit') throw new Error('expected an edit target');

    // The reopened pipeline keeps its section and its own origin.
    expect(first.target.section).toBe('trigger');
    expect(resolveWorkflowEditBack(first.target)).toEqual({
      kind: 'plugins',
      intent: { kind: 'marketplace-browse', ...marketplace },
    });
  });
});
