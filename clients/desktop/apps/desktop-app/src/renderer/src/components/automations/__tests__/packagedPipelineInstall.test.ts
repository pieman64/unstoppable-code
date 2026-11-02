import type { SharedAutomationDocument } from '@canopy/protocol/automations';
import {
  packagedPipelineFileChangeLines,
  packagedPipelineReviewRows,
  sharedPackagedPipelines,
  stagedActionPipelineId,
} from '../packagedPipelineInstall';

const promptDocument: SharedAutomationDocument = {
  version: 5,
  name: 'Journey specialist',
  description: '',
  trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
  hasRunCondition: false,
  action: {
    type: 'app_advisor_prompt',
    prompt: 'Run the pipelines.',
    plugins: [],
    pipelineDependencies: [
      {
        key: 'entry',
        pipeline: {
          source: 'packaged',
          key: 'entry',
          pipelineContentHash: 'a'.repeat(64),
          name: 'Entry',
        },
        promptSpans: [],
      },
      {
        key: 'worker',
        pipeline: {
          source: 'packaged',
          key: 'worker',
          pipelineContentHash: 'b'.repeat(64),
        },
        promptSpans: [],
      },
    ],
  },
};

describe('sharedPackagedPipelines', () => {
  it('lists prompt dependencies, naming an unnamed one by key', () => {
    expect(sharedPackagedPipelines(promptDocument)).toEqual([
      {
        key: 'entry',
        name: 'Entry',
        pipelineContentHash: 'a'.repeat(64),
        isActionPipeline: false,
      },
      {
        key: 'worker',
        name: 'worker',
        pipelineContentHash: 'b'.repeat(64),
        isActionPipeline: false,
      },
    ]);
  });

  it('lists a packaged action pipeline and ignores an inline one', () => {
    const packaged: SharedAutomationDocument = {
      ...promptDocument,
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: {
          source: 'packaged',
          key: 'action',
          pipelineContentHash: 'c'.repeat(64),
          name: 'Review',
        },
        inputKeys: [],
      },
    };
    expect(sharedPackagedPipelines(packaged)).toEqual([
      {
        key: 'action',
        name: 'Review',
        pipelineContentHash: 'c'.repeat(64),
        isActionPipeline: true,
      },
    ]);
    expect(
      sharedPackagedPipelines({
        ...packaged,
        version: 4,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'inline',
            rawPipeline: 'name: Review\n',
            pipelineContentHash: 'c'.repeat(64),
          },
          inputKeys: [],
        },
      }),
    ).toEqual([]);
  });
});

describe('packagedPipelineReviewRows', () => {
  const pipelines = sharedPackagedPipelines(promptDocument);

  it('reports the preview outcomes for a fresh install', () => {
    expect(
      packagedPipelineReviewRows({
        pipelines,
        preview: {
          pipelines: [
            {
              key: 'entry',
              pipelineContentHash: 'a'.repeat(64),
              outcome: 'created',
              rewrites: false,
              rawPipeline: 'name: Entry\n',
              assetChanges: [],
            },
            {
              key: 'worker',
              localPipelineId: 'local-worker',
              pipelineContentHash: 'b'.repeat(64),
              outcome: 'reused',
              rewrites: false,
              rawPipeline: 'name: Worker\n',
              assetChanges: [],
            },
          ],
        },
      }).map((row) => row.status),
    ).toEqual(['new', 'reused']);
    expect(
      packagedPipelineReviewRows({ pipelines, preview: null }).map(
        (row) => row.status,
      ),
    ).toEqual(['pending', 'pending']);
  });

  it('reports the update plan, including a pipeline the share dropped', () => {
    const rows = packagedPipelineReviewRows({
      pipelines,
      updatePlan: {
        existingPipelines: [
          {
            key: 'entry',
            localPipelineId: 'local-entry',
            expectedContentHash: 'a'.repeat(64),
          },
          {
            key: 'worker',
            localPipelineId: 'local-worker',
            expectedContentHash: 'f'.repeat(64),
          },
        ],
        dropped: [
          {
            key: 'old',
            localPipelineId: 'local-old',
            pipelineContentHash: 'e'.repeat(64),
          },
        ],
      },
      localPipelineName: (id) =>
        id === 'local-old' ? 'Old helper' : undefined,
    });
    expect(rows).toEqual([
      { key: 'entry', name: 'Entry', status: 'unchanged' },
      { key: 'worker', name: 'worker', status: 'update' },
      { key: 'old', name: 'Old helper', status: 'removed' },
    ]);
  });
});

describe('packagedPipelineReviewRows with the update preview', () => {
  const pipelines = sharedPackagedPipelines(promptDocument);
  const updatePlan = {
    existingPipelines: [
      {
        key: 'entry',
        localPipelineId: 'local-entry',
        expectedContentHash: 'f'.repeat(64),
      },
      {
        key: 'worker',
        localPipelineId: 'local-worker',
        expectedContentHash: 'b'.repeat(64),
      },
    ],
    dropped: [],
  };
  const assetChanges = {
    assetId: 'specialists',
    installMode: 'replace' as const,
    added: ['new.json'],
    updated: [],
    overwritten: ['mine.json'],
    kept: [],
  };

  it('prefers the preview: the YAML of a rewritten pipeline and its file changes', () => {
    const rows = packagedPipelineReviewRows({
      pipelines,
      updatePlan,
      preview: {
        pipelines: [
          {
            key: 'entry',
            localPipelineId: 'local-entry',
            pipelineContentHash: 'a'.repeat(64),
            outcome: 'reused',
            rewrites: true,
            rawPipeline: 'name: Entry v2\n',
            assetChanges: [assetChanges],
          },
          {
            // Deleted here since the last install, so Stage A creates it.
            key: 'worker',
            pipelineContentHash: 'b'.repeat(64),
            outcome: 'created',
            rewrites: false,
            rawPipeline: 'name: Worker\n',
            assetChanges: [{ ...assetChanges, added: [], overwritten: [] }],
          },
        ],
      },
    });
    expect(rows).toEqual([
      {
        key: 'entry',
        name: 'Entry',
        status: 'update',
        rawPipeline: 'name: Entry v2\n',
        fileChanges: [assetChanges],
      },
      { key: 'worker', name: 'worker', status: 'new' },
    ]);
  });

  it('falls back to the plan until the preview is in', () => {
    expect(
      packagedPipelineReviewRows({ pipelines, updatePlan, preview: null }).map(
        (row) => row.status,
      ),
    ).toEqual(['update', 'unchanged']);
  });
});

describe('packagedPipelineFileChangeLines', () => {
  it('warns about overwritten local edits under replace', () => {
    expect(
      packagedPipelineFileChangeLines([
        {
          assetId: 'specialists',
          installMode: 'replace',
          added: ['d.json'],
          updated: ['a.json', 'c.json'],
          overwritten: ['b.json'],
          kept: [],
        },
      ]),
    ).toEqual([
      {
        tone: 'warning',
        text: 'Overwrites 1 file you changed in “specialists”: b.json',
      },
      { tone: 'secondary', text: 'Updates 2 files in “specialists”' },
      { tone: 'secondary', text: 'Adds 1 file to “specialists”' },
    ]);
  });

  it('lists the files seed keeps', () => {
    expect(
      packagedPipelineFileChangeLines([
        {
          assetId: 'specialists',
          installMode: 'seed',
          added: [],
          updated: [],
          overwritten: [],
          kept: ['a.json', 'b.json'],
        },
      ]),
    ).toEqual([
      {
        tone: 'secondary',
        text: 'Keeps 2 files in “specialists” as they are on this computer: a.json, b.json',
      },
    ]);
  });
});

describe('stagedActionPipelineId', () => {
  it('finds the action pipeline Stage A installed', () => {
    expect(
      stagedActionPipelineId({
        pipelines: [
          {
            key: 'action',
            localPipelineId: 'local-action',
            pipelineContentHash: 'a'.repeat(64),
            outcome: 'kept',
          },
        ],
      }),
    ).toBe('local-action');
    expect(stagedActionPipelineId({ pipelines: [] })).toBeUndefined();
  });
});
