import {
  formatPipelinePackageBytes,
  formatPipelinePackageExecutableFiles,
  formatPipelinePackageFileSummary,
  formatPipelinePackageInstalledStatus,
  formatPipelinePackageSteps,
  formatPipelinePackageTransferLabel,
  isEmptyPipelinePackageSummary,
  pipelinePackageKindLabel,
  pipelinePackageRequirementKindLabel,
  PIPELINE_PACKAGE_DEFINITION_ONLY_WARNING,
  AUTOMATION_PACKAGE_BUNDLED_NOTE,
  AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE,
  PIPELINE_PACKAGE_EMPTY_DEPENDENCIES,
  PIPELINE_PACKAGE_NOT_INCLUDED_HEADING,
  PIPELINE_PACKAGE_PUBLISHER_NOTE,
} from '../pipeline-package-display';

describe('shared package copy', () => {
  it('describes emptiness in recipient-neutral words', () => {
    // "local" is meaningless on a recipient surface and "detected" is
    // machine-speak; both surfaces render this same sentence.
    expect(PIPELINE_PACKAGE_EMPTY_DEPENDENCIES).toBe(
      'No dependency files are included.',
    );
  });

  it('labels what the publisher deliberately left out', () => {
    expect(PIPELINE_PACKAGE_NOT_INCLUDED_HEADING).toBe('Not included');
    expect(PIPELINE_PACKAGE_PUBLISHER_NOTE).toBe(
      'The publisher marked these as not commands, so they are not copied.',
    );
  });
});

describe('formatPipelinePackageBytes', () => {
  it.each([
    [0, '0 B'],
    [-1, '0 B'],
    [512, '512 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [4 * 1024 * 1024, '4 MB'],
    [32 * 1024 * 1024, '32 MB'],
  ])('formats %p as %p', (bytes, expected) => {
    expect(formatPipelinePackageBytes(bytes)).toBe(expected);
  });

  it('stays deterministic regardless of host locale', () => {
    // Desktop, web SSR, and web hydration must agree on the same string.
    expect(formatPipelinePackageBytes(1_234_567)).toBe(
      formatPipelinePackageBytes(1_234_567),
    );
    expect(formatPipelinePackageBytes(1_234_567)).toBe('1.2 MB');
  });
});

describe('file and step summaries', () => {
  it('singularizes a one-file resource', () => {
    expect(formatPipelinePackageFileSummary(1, 1024)).toBe('1 file · 1 KB');
  });

  it('pluralizes multi-file resources', () => {
    expect(formatPipelinePackageFileSummary(3, 3072)).toBe('3 files · 3 KB');
  });

  it('renders affected steps as job.step pairs', () => {
    expect(
      formatPipelinePackageSteps([
        { jobId: 'ship', stepId: 'open_pr' },
        { jobId: 'review', stepId: 'review_loop' },
      ]),
    ).toBe('ship.open_pr, review.review_loop');
  });
});

describe('install status copy', () => {
  it('matches the specified terminal status wording', () => {
    expect(formatPipelinePackageInstalledStatus(5)).toBe(
      'Installed with 5 dependencies.',
    );
    expect(formatPipelinePackageInstalledStatus(1)).toBe(
      'Installed with 1 dependency.',
    );
  });

  it('matches the specified transfer wording', () => {
    expect(formatPipelinePackageTransferLabel(2, 5)).toBe(
      'Installing 2 of 5 dependencies…',
    );
  });
});

describe('kind labels', () => {
  it('collapses both skill kinds to one user-facing word', () => {
    expect(pipelinePackageKindLabel('standalone_skill')).toBe('Skill');
    expect(pipelinePackageKindLabel('plugin_skill')).toBe('Skill');
    expect(pipelinePackageKindLabel('plugin_command')).toBe('Command');
    expect(pipelinePackageKindLabel('plugin_agent')).toBe('Agent');
  });

  it('names workflow kinds as workflows, never pipelines (CAN-4651)', () => {
    expect(pipelinePackageKindLabel('pipeline_action')).toBe('Workflow action');
    expect(pipelinePackageKindLabel('child_pipeline')).toBe('Child workflow');
    expect(pipelinePackageKindLabel('pipeline_definition')).toBe('Workflow');
    for (const copy of [
      PIPELINE_PACKAGE_DEFINITION_ONLY_WARNING,
      AUTOMATION_PACKAGE_BUNDLED_NOTE,
      AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE,
    ]) {
      expect(copy).not.toMatch(/pipeline/i);
      expect(copy).toContain('workflow');
    }
  });

  it('labels every environment requirement kind', () => {
    expect(pipelinePackageRequirementKindLabel('connector')).toBe('Connection');
    expect(pipelinePackageRequirementKindLabel('mcp')).toBe('MCP server');
    expect(pipelinePackageRequirementKindLabel('model')).toBe('Model');
    expect(pipelinePackageRequirementKindLabel('command')).toBe('Command');
    expect(pipelinePackageRequirementKindLabel('runtime')).toBe('Runtime');
  });
});

describe('isEmptyPipelinePackageSummary', () => {
  it('is empty only when there is nothing at all to review', () => {
    expect(
      isEmptyPipelinePackageSummary({
        resources: [],
        environmentRequirements: [],
      }),
    ).toBe(true);
    expect(
      isEmptyPipelinePackageSummary({
        resources: [],
        environmentRequirements: [
          {
            id: 'github',
            kind: 'connector',
            displayName: 'GitHub',
            required: true,
            affectedSteps: [],
            setupHint: 'Connect GitHub.',
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('formatPipelinePackageExecutableFiles', () => {
  it('names each runnable script on its own line of copy', () => {
    expect(formatPipelinePackageExecutableFiles(['scripts/zip.sh'])).toBe(
      'Runnable scripts: scripts/zip.sh',
    );
  });

  it('keeps a long list readable', () => {
    expect(
      formatPipelinePackageExecutableFiles([
        'a.sh',
        'b.sh',
        'c.sh',
        'd.sh',
        'e.sh',
        'f.sh',
        'g.sh',
      ]),
    ).toBe('Runnable scripts: a.sh, b.sh, c.sh, d.sh, e.sh, and 2 more');
  });

  it('says nothing when there are none', () => {
    expect(formatPipelinePackageExecutableFiles([])).toBeNull();
  });
});
