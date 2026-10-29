import { WORKFLOW_EDIT_SECTIONS as SHARED_SECTIONS } from '@canopy/desktop-shared/types';
import { WORKFLOW_EDIT_SECTIONS as SHELL_SECTIONS } from '@canopy/ui-app/workflows';
import {
  isSameWorkflowEditItem,
  isWorkflowEditDraft,
  newWorkflowDraftKey,
  withWorkflowDraftKey,
  workflowEditKey,
  type WorkflowEditTarget,
} from '../edit-target';

describe('workflowEditKey', () => {
  const pipeline: WorkflowEditTarget = {
    kind: 'pipeline',
    pipelineId: 'deploy',
    source: 'user',
  };

  it.each<WorkflowEditTarget>([
    pipeline,
    { kind: 'automation', activityId: 'act-1' },
    { kind: 'automation-draft', draftKey: 'draft-1' },
    { kind: 'shared-automation', remoteId: 'share-1' },
    { kind: 'pipeline', pipelineId: null, draftKey: 'draft-2' },
  ])('ignores section and returnTo for $kind', (target) => {
    const key = workflowEditKey(target);
    expect(workflowEditKey({ ...target, section: 'runs' })).toBe(key);
    expect(
      workflowEditKey({
        ...target,
        section: 'trigger',
        returnTo: { kind: 'automation', activityId: 'elsewhere' },
      }),
    ).toBe(key);
  });

  it('tells every kind apart, even with the same id', () => {
    const keys = [
      workflowEditKey({ kind: 'automation', activityId: 'same' }),
      workflowEditKey({ kind: 'automation-draft', draftKey: 'same' }),
      workflowEditKey({ kind: 'shared-automation', remoteId: 'same' }),
      workflowEditKey({ kind: 'pipeline', pipelineId: 'same' }),
      workflowEditKey({ kind: 'pipeline', pipelineId: null, draftKey: 'same' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys a pipeline by its whole locator', () => {
    const key = workflowEditKey(pipeline);
    expect(workflowEditKey({ ...pipeline })).toBe(key);
    expect(workflowEditKey({ ...pipeline, source: 'bundled' })).not.toBe(key);
    expect(workflowEditKey({ ...pipeline, cwd: '/repo' })).not.toBe(key);
    expect(workflowEditKey({ ...pipeline, filePath: '/repo/p.yaml' })).not.toBe(
      key,
    );
    expect(workflowEditKey({ ...pipeline, pipelineId: 'other' })).not.toBe(key);
    expect(
      workflowEditKey({
        kind: 'pipeline',
        pipelineId: null,
        sharedRemoteId: 'remote-1',
      }),
    ).not.toBe(
      workflowEditKey({
        kind: 'pipeline',
        pipelineId: null,
        sharedRemoteId: 'remote-2',
      }),
    );
  });

  it('keys two pipeline drafts apart by their draft keys', () => {
    expect(
      workflowEditKey({ kind: 'pipeline', pipelineId: null, draftKey: 'a' }),
    ).not.toBe(
      workflowEditKey({ kind: 'pipeline', pipelineId: null, draftKey: 'b' }),
    );
  });
});

describe('isSameWorkflowEditItem', () => {
  const library: WorkflowEditTarget = {
    kind: 'pipeline',
    pipelineId: 'deploy',
    source: 'user',
  };

  it('matches a pipeline named only by its id to the one shown', () => {
    const bare: WorkflowEditTarget = { kind: 'pipeline', pipelineId: 'deploy' };
    expect(isSameWorkflowEditItem(library, bare)).toBe(true);
    expect(isSameWorkflowEditItem(bare, library)).toBe(true);
    expect(isSameWorkflowEditItem(library, { ...bare, section: 'runs' })).toBe(
      true,
    );
  });

  it('matches a shared pipeline by its remote id', () => {
    expect(
      isSameWorkflowEditItem(
        {
          kind: 'pipeline',
          pipelineId: 'shared:canopy-cloud:remote-1',
          sharedRemoteId: 'remote-1',
        },
        { kind: 'pipeline', pipelineId: null, sharedRemoteId: 'remote-1' },
      ),
    ).toBe(true);
  });

  it('tells apart pipelines whose locations differ', () => {
    const project: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'deploy',
      cwd: '/repo',
      filePath: '/repo/.canopy/pipelines/deploy.yml',
    };
    expect(isSameWorkflowEditItem(library, project)).toBe(false);
    expect(
      isSameWorkflowEditItem(library, { ...library, source: 'bundled' }),
    ).toBe(false);
    expect(
      isSameWorkflowEditItem(library, {
        kind: 'pipeline',
        pipelineId: 'other',
      }),
    ).toBe(false);
    expect(
      isSameWorkflowEditItem(
        { kind: 'pipeline', pipelineId: null, draftKey: 'a' },
        { kind: 'pipeline', pipelineId: null, draftKey: 'b' },
      ),
    ).toBe(false);
  });
});

describe('newWorkflowDraftKey', () => {
  it('returns a fresh key on every call', () => {
    const keys = Array.from({ length: 50 }, () => newWorkflowDraftKey());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('withWorkflowDraftKey', () => {
  it('gives a new pipeline draft its own key', () => {
    const first = withWorkflowDraftKey({ kind: 'pipeline', pipelineId: null });
    const second = withWorkflowDraftKey({ kind: 'pipeline', pipelineId: null });
    expect(first.kind === 'pipeline' && first.draftKey).toEqual(
      expect.any(String),
    );
    expect(workflowEditKey(first)).not.toBe(workflowEditKey(second));
  });

  it('leaves every other target as it is', () => {
    const targets: WorkflowEditTarget[] = [
      { kind: 'pipeline', pipelineId: null, draftKey: 'kept' },
      { kind: 'pipeline', pipelineId: null, sharedRemoteId: 'remote' },
      { kind: 'pipeline', pipelineId: 'saved' },
      { kind: 'automation', activityId: 'act-1' },
    ];
    for (const target of targets) {
      expect(withWorkflowDraftKey(target)).toBe(target);
    }
  });
});

describe('isWorkflowEditDraft', () => {
  it.each<[WorkflowEditTarget, boolean]>([
    [{ kind: 'automation-draft', draftKey: 'd' }, true],
    [{ kind: 'pipeline', pipelineId: null, draftKey: 'd' }, true],
    [{ kind: 'pipeline', pipelineId: null, sharedRemoteId: 'remote' }, false],
    [{ kind: 'pipeline', pipelineId: 'saved' }, false],
    [{ kind: 'automation', activityId: 'act-1' }, false],
    [{ kind: 'shared-automation', remoteId: 'share-1' }, false],
  ])('%j is a draft: %s', (target, expected) => {
    expect(isWorkflowEditDraft(target)).toBe(expected);
  });
});

describe('WORKFLOW_EDIT_SECTIONS', () => {
  // ui-app can't import desktop-shared, so the shell keeps its own list.
  it('matches the shell’s section list', () => {
    expect([...SHARED_SECTIONS]).toEqual([...SHELL_SECTIONS]);
  });
});
