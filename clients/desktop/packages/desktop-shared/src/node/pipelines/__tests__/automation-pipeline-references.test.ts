import {
  automationPipelineKey,
  automationPipelineResourceId,
  fileAssetResourceId,
  resolveAutomationPipelineReferences,
  type AutomationPipelineInventoryEntry,
} from '../automation-pipeline-references';

const ENTRY_ID = '3f2b8c1e-9d4a-4e6b-8f1c-2a7d5e9b0c13';
const WORKER_ID = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

function userPipeline(
  pipelineId: string,
  name: string,
  overrides: Partial<AutomationPipelineInventoryEntry> = {},
): AutomationPipelineInventoryEntry {
  return {
    key: pipelineId,
    pipelineId,
    name,
    source: 'user',
    path: `/data/pipelines/${pipelineId}.yaml`,
    hasInstalledPackage: false,
    ...overrides,
  };
}

function projectPipeline(
  fileName: string,
  name: string,
): AutomationPipelineInventoryEntry {
  const filePath = `/repo/.canopy/pipelines/${fileName}`;
  return {
    key: automationPipelineKey({
      source: 'project',
      pipelineId: `project:${fileName}`,
      path: filePath,
    }),
    pipelineId: `project:${fileName}`,
    name,
    source: 'project',
    path: filePath,
    hasInstalledPackage: false,
  };
}

describe('automationPipelineKey', () => {
  it('uses the author id for a user pipeline', () => {
    expect(
      automationPipelineKey({
        source: 'user',
        pipelineId: ENTRY_ID,
        path: `/data/pipelines/${ENTRY_ID}.yaml`,
      }),
    ).toBe(ENTRY_ID);
  });

  it.each([
    ['Nightly Build.yaml', 'project-nightly-build'],
    ['--Weird__Name!!.yml', 'project-weird-name'],
    ['release.v2.yaml', 'project-release-v2'],
    ['action.yaml', 'project-action'],
  ])('slugifies the project file stem %s', (fileName, key) => {
    expect(
      automationPipelineKey({
        source: 'project',
        pipelineId: fileName,
        path: `/repo/pipelines/${fileName}`,
      }),
    ).toBe(key);
  });

  it('falls back to a path hash when the stem has no usable characters', () => {
    expect(
      automationPipelineKey({
        source: 'project',
        pipelineId: '!!!',
        path: '/repo/pipelines/!!!.yaml',
      }),
    ).toMatch(/^project-[0-9a-f]{12}$/);
  });

  it('names resources after the key', () => {
    expect(automationPipelineResourceId(ENTRY_ID)).toBe(
      `automation-pipeline-${ENTRY_ID}`,
    );
    expect(fileAssetResourceId('project-x', 'specialists')).toBe(
      'file-asset-project-x-specialists',
    );
  });
});

describe('resolveAutomationPipelineReferences', () => {
  const inventory = [
    userPipeline(ENTRY_ID, 'Entry'),
    userPipeline(WORKER_ID, 'Worker'),
  ];

  it('requires UUID matches and records every span', () => {
    const promptText = `\u{1F680} Run ${ENTRY_ID}, then ${ENTRY_ID.toUpperCase()}.`;
    const result = resolveAutomationPipelineReferences({
      promptText,
      inventory,
    });
    expect(result.blockers).toEqual([]);
    expect(result.pipelines).toEqual([
      expect.objectContaining({
        key: ENTRY_ID,
        required: true,
        selected: true,
        promptSpans: [
          { textStart: 7, text: ENTRY_ID },
          { textStart: 50, text: ENTRY_ID.toUpperCase() },
        ],
      }),
    ]);
    for (const span of result.pipelines[0]?.promptSpans ?? []) {
      expect(
        promptText.slice(span.textStart, span.textStart + span.text.length),
      ).toBe(span.text);
    }
  });

  it('offers an exact name match as an unselected suggestion', () => {
    const result = resolveAutomationPipelineReferences({
      promptText: 'Use the Worker pipeline.',
      inventory,
    });
    expect(result.pipelines).toEqual([
      expect.objectContaining({
        key: WORKER_ID,
        required: false,
        selected: false,
        promptSpans: [],
      }),
    ]);
    expect(
      resolveAutomationPipelineReferences({
        promptText: 'Use the Worker pipeline.',
        inventory,
        selections: [WORKER_ID],
      }).pipelines,
    ).toEqual([expect.objectContaining({ key: WORKER_ID, selected: true })]);
  });

  it('ignores UUIDs and names that match nothing', () => {
    expect(
      resolveAutomationPipelineReferences({
        promptText: `See 11111111-2222-4333-8444-555555555555 and Workers.`,
        inventory,
      }),
    ).toEqual({ pipelines: [], blockers: [], dismissedReferences: [] });
  });

  it('blocks a name shared by a user and a project pipeline until dismissed', () => {
    const shared = [
      userPipeline(ENTRY_ID, 'Review'),
      projectPipeline('review.yaml', 'Review'),
    ];
    const blocked = resolveAutomationPipelineReferences(
      { promptText: 'Run Review daily.', inventory: shared },
      { jobId: 'automation', stepId: 'action' },
    );
    expect(blocked.pipelines).toEqual([]);
    expect(blocked.blockers).toEqual([
      expect.objectContaining({
        code: 'AMBIGUOUS_PIPELINE_REFERENCE',
        subject: 'Review',
        occurrences: [{ jobId: 'automation', stepId: 'action' }],
        referenceDismissal: { kind: 'pipeline_reference', token: 'Review' },
      }),
    ]);
    const dismissed = resolveAutomationPipelineReferences({
      promptText: 'Run Review daily.',
      inventory: shared,
      dismissedReferences: [{ kind: 'pipeline_reference', token: 'Review' }],
    });
    expect(dismissed.blockers).toEqual([]);
    expect(dismissed.dismissedReferences).toEqual([
      { kind: 'pipeline_reference', token: 'Review' },
    ]);
  });

  it('lets a structured request win over prompt detection', () => {
    const shared = [
      userPipeline(ENTRY_ID, 'Review'),
      projectPipeline('review.yaml', 'Review'),
      userPipeline(WORKER_ID, 'Worker'),
    ];
    const result = resolveAutomationPipelineReferences({
      promptText: 'Run Review, then Worker.',
      inventory: shared,
      requests: [
        { pipelineId: ENTRY_ID, source: 'user' },
        { pipelineId: WORKER_ID.toUpperCase(), source: 'user' },
      ],
    });
    expect(result.blockers).toEqual([]);
    expect(
      result.pipelines.map(({ key, required, selected }) => ({
        key,
        required,
        selected,
      })),
    ).toEqual([
      { key: WORKER_ID, required: true, selected: true },
      { key: ENTRY_ID, required: true, selected: true },
    ]);
  });

  it('reports a stored dependency that no longer resolves', () => {
    const result = resolveAutomationPipelineReferences({
      inventory,
      requests: [{ pipelineId: 'gone', source: 'project' }],
    });
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: 'MISSING_DEPENDENCY_SOURCE',
        subject: 'gone',
      }),
    ]);
  });

  it('blocks a selected pipeline that has its own installed package', () => {
    const result = resolveAutomationPipelineReferences({
      promptText: `Run ${ENTRY_ID} or Worker.`,
      inventory: [
        userPipeline(ENTRY_ID, 'Entry', { hasInstalledPackage: true }),
        userPipeline(WORKER_ID, 'Worker', { hasInstalledPackage: true }),
      ],
    });
    // The unselected suggestion does not block.
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: 'DEPENDENCY_HAS_INSTALLED_PACKAGE',
        subject: 'Entry',
      }),
    ]);
  });

  it('blocks two project pipelines that share a key', () => {
    const first = projectPipeline('Nightly Build.yaml', 'Nightly');
    const second = projectPipeline('nightly-build.yaml', 'Nightly two');
    expect(first.key).toBe(second.key);
    const result = resolveAutomationPipelineReferences({
      inventory: [first, second],
      requests: [{ pipelineId: first.pipelineId, source: 'project' }],
    });
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_PIPELINE_KEY',
        subject: 'project-nightly-build',
      }),
    ]);
  });
});
