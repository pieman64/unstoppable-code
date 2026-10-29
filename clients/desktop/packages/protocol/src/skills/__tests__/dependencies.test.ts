import {
  validatePipelinePackageManifest,
  type PipelinePackageManifestV1,
} from '../../pipelines/package';
import {
  extractSkillDependencies,
  skillDependenciesToEnvironmentRequirements,
} from '../dependencies';

describe('skill dependency extraction (environment-neutral)', () => {
  it('treats an injected namespace as built in rather than as a requirement', () => {
    const raw = '# Skill\n\nCall mcp__acme__do_thing then mcp__slack__send.\n';

    expect(extractSkillDependencies(raw)).toEqual([
      { kind: 'mcp', name: 'Acme' },
      { kind: 'mcp', name: 'Slack' },
    ]);
    expect(
      extractSkillDependencies(raw, { builtinToolNamespaces: ['acme'] }),
    ).toEqual([{ kind: 'mcp', name: 'Slack' }]);
  });

  it('always treats the legacy namespace as built in', () => {
    expect(
      extractSkillDependencies('# Skill\n\nUse mcp__canopy_ui__ask_user.\n'),
    ).toEqual([]);
  });

  it('reads declared dependencies from host-parsed frontmatter', () => {
    const raw = '# Skill\n\nNothing referenced inline.\n';

    expect(extractSkillDependencies(raw)).toEqual([]);
    expect(
      extractSkillDependencies(raw, {
        frontmatter: { 'mcp-servers': ['linear'] },
      }),
    ).toEqual([{ kind: 'mcp', name: 'Linear' }]);
  });
});

describe('skill dependencies as environment requirements', () => {
  it('produces requirements a manifest accepts, bound to no step', () => {
    const requirements = skillDependenciesToEnvironmentRequirements([
      { kind: 'mcp', name: 'Google Drive' },
      { kind: 'plugin', name: 'ud-linear' },
    ]);

    expect(requirements).toEqual([
      {
        id: 'mcp-google-drive',
        kind: 'mcp',
        displayName: 'Google Drive',
        required: false,
        affectedSteps: [],
        setupHint: 'Connect the Google Drive MCP server in Settings.',
      },
      {
        id: 'runtime-ud-linear',
        kind: 'runtime',
        displayName: 'ud-linear',
        required: false,
        affectedSteps: [],
        setupHint: 'Install the ud-linear plugin.',
      },
    ]);

    const manifest: PipelinePackageManifestV1 = {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [{ target: 'subject', resourceIds: [] }],
      environmentRequirements: requirements,
      totalFiles: 0,
      totalBytes: 0,
    };
    expect(validatePipelinePackageManifest(manifest)).toEqual({ ok: true });
  });

  it('never marks an extracted requirement as blocking', () => {
    expect(
      skillDependenciesToEnvironmentRequirements([
        { kind: 'mcp', name: 'Slack' },
      ]).every((requirement) => requirement.required === false),
    ).toBe(true);
  });

  it('keeps a punctuation-only name inside the manifest identifier pattern', () => {
    const [requirement] = skillDependenciesToEnvironmentRequirements([
      { kind: 'mcp', name: '///' },
    ]);

    expect(requirement?.id).toBe('mcp-unnamed');
  });
});

describe('requirement id collisions', () => {
  // Extraction dedupes case-insensitively on the display NAME, but ids are
  // slugified from it — so two spellings of one dependency survive extraction
  // and then collide on id, which the manifest validator rejects outright.
  it('does not emit two requirements with the same id', () => {
    const dependencies = extractSkillDependencies('# Skill\n\nBody.\n', {
      frontmatter: { plugins: ['Foo Bar', 'foo-bar'] },
    });
    expect(dependencies.length).toBeGreaterThan(1);

    const requirements =
      skillDependenciesToEnvironmentRequirements(dependencies);
    const ids = requirements.map((requirement) => requirement.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces a manifest the validator accepts', () => {
    const manifest: PipelinePackageManifestV1 = {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [{ target: 'subject', resourceIds: [] }],
      environmentRequirements: skillDependenciesToEnvironmentRequirements(
        extractSkillDependencies('# Skill\n\nBody.\n', {
          frontmatter: { plugins: ['Foo Bar', 'foo-bar'] },
        }),
      ),
      totalFiles: 0,
      totalBytes: 0,
    };

    expect(validatePipelinePackageManifest(manifest)).toEqual({ ok: true });
  });
});
