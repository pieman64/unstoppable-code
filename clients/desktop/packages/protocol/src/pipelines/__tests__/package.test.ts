import {
  CAPABILITY_PACKAGE_CLIENT_VERSION,
  CAPABILITY_PACKAGE_VERSION,
  CAPABILITY_PACKAGE_VERSION_HEADER,
  PIPELINE_PACKAGE_CLIENT_VERSION,
  PIPELINE_PACKAGE_VERSION,
  PIPELINE_PACKAGE_VERSION_HEADER,
  canonicalizeCapabilityPackageManifest,
  canonicalizePipelinePackageManifest,
  computeCapabilityPackageDigest,
  computePipelinePackageDigest,
  detectPipelinePackageNativeExecutable,
  countCapabilityPackageDistinctFiles,
  groupCapabilityPackageProviderTwins,
  isCapabilityPackageSubjectBinding,
  listCapabilityPackageExecutablePaths,
  requiredCapabilityPackageClientVersion,
  validateCapabilityPackageManifest,
  validatePipelinePackageManifest,
  type CapabilityPackageManifestV1,
  type PipelinePackageManifestV1,
  type PipelinePackageFileEntry,
  type PipelinePackageResource,
} from '../package';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function manifest(): PipelinePackageManifestV1 {
  return {
    version: 1,
    pipelineContentHash: HASH_A,
    resources: [
      {
        id: 'resource-b',
        kind: 'plugin_command',
        displayName: 'Command B',
        sourceLabel: 'plugin-b',
        sourceVisibility: 'private',
        invocationKeys: ['/b'],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'plugin_fragment',
            rootName: 'plugin-b',
            entries: [
              { path: 'commands/b.md', sha256: HASH_B, size: 4, mode: 'read' },
            ],
          },
        ],
      },
      {
        id: 'resource-a',
        kind: 'standalone_skill',
        displayName: 'Skill A',
        sourceLabel: 'skill-a',
        sourceVisibility: 'local',
        invocationKeys: ['$skill-a'],
        dependencyResourceIds: ['resource-b'],
        trees: [
          {
            provider: 'codex',
            runtimeKind: 'standalone_skill',
            rootName: 'skill-a',
            entries: [
              { path: 'SKILL.md', sha256: HASH_A, size: 3, mode: 'read' },
            ],
          },
        ],
      },
    ],
    bindings: [
      { jobId: 'job-b', stepId: 'step-b', resourceIds: ['resource-b'] },
      { jobId: 'job-a', stepId: 'step-a', resourceIds: ['resource-a'] },
    ],
    environmentRequirements: [],
    totalFiles: 2,
    totalBytes: 7,
  };
}

function firstResource(
  value: PipelinePackageManifestV1,
): PipelinePackageResource {
  const resource = value.resources[0];
  if (!resource) throw new Error('Fixture resource is missing');
  return resource;
}

function firstEntry(
  value: PipelinePackageManifestV1,
): PipelinePackageFileEntry {
  const entry = firstResource(value).trees[0]?.entries[0];
  if (!entry) throw new Error('Fixture entry is missing');
  return entry;
}

describe('pipeline package protocol', () => {
  it.each([
    ['FAT_MAGIC_64', [0xca, 0xfe, 0xba, 0xbf]],
    ['FAT_CIGAM_64', [0xbf, 0xba, 0xfe, 0xca]],
  ])('detects %s as a native Mach-O executable', (_label, magic) => {
    expect(detectPipelinePackageNativeExecutable(Uint8Array.from(magic))).toBe(
      'Mach-O',
    );
  });

  it('pins version constants and produces a stable canonical digest', async () => {
    expect(PIPELINE_PACKAGE_VERSION).toBe(1);
    expect(PIPELINE_PACKAGE_CLIENT_VERSION).toBe(6);
    expect(PIPELINE_PACKAGE_VERSION_HEADER).toBe('X-Pipeline-Package-Version');

    const first = manifest();
    const second = manifest();
    second.resources.reverse();
    second.bindings.reverse();

    expect(canonicalizePipelinePackageManifest(first)).toBe(
      canonicalizePipelinePackageManifest(second),
    );
    expect(await computePipelinePackageDigest(first)).toBe(
      await computePipelinePackageDigest(second),
    );
    expect(await computePipelinePackageDigest(first)).toMatch(
      /^pp:v1:[A-Za-z0-9_-]{43}$/,
    );
  });

  it('keeps the digest of installed-item refs stable across a jsonb key reorder', async () => {
    const sent = manifest();
    firstResource(sent).installedItemRef = {
      kind: 'plugin',
      marketplaceId: 'market',
      pluginName: 'plugin',
    };
    const secondResource = sent.resources[1];
    if (!secondResource) throw new Error('Fixture resource is missing');
    secondResource.installedItemRef = {
      kind: 'skill',
      sourceId: 'source',
      skillName: 'skill',
    };
    // Postgres jsonb stores object keys shortest first, so a stored manifest
    // comes back with its refs reordered.
    const stored = structuredClone(sent);
    firstResource(stored).installedItemRef = {
      kind: 'plugin',
      pluginName: 'plugin',
      marketplaceId: 'market',
    };

    expect(canonicalizePipelinePackageManifest(stored)).toBe(
      canonicalizePipelinePackageManifest(sent),
    );
    expect(await computePipelinePackageDigest(stored)).toBe(
      await computePipelinePackageDigest(sent),
    );
    // Already-published packages were hashed in the client's key order.
    expect(canonicalizePipelinePackageManifest(stored)).toContain(
      '"installedItemRef":{"kind":"plugin","marketplaceId":"market","pluginName":"plugin"}',
    );
  });

  it.each([
    'pipeline_definition',
    'automation_definition',
    'agent_definition',
    'hook_definition',
  ] as const)(
    'accepts a canonical %s document and requires version 5',
    (kind) => {
      const input = manifest();
      firstResource(input).kind = kind;
      expect(validatePipelinePackageManifest(input)).toEqual({ ok: true });
      expect(requiredCapabilityPackageClientVersion(input)).toBe(5);
      firstEntry(input).mode = 'execute';
      expect(validatePipelinePackageManifest(input).ok).toBe(false);
    },
  );

  it.each([{}, null, { entries: null }, { entries: [null] }])(
    'rejects malformed definition trees without throwing',
    (tree) => {
      const input = manifest();
      const malformed = {
        ...input,
        resources: [
          { ...firstResource(input), kind: 'agent_definition', trees: [tree] },
        ],
      };
      expect(validatePipelinePackageManifest(malformed).ok).toBe(false);
    },
  );

  it.each(['child_pipeline', 'pipeline_action'] as const)(
    'preserves version 4 for %s',
    (kind) => {
      const input = manifest();
      firstResource(input).kind = kind;
      expect(requiredCapabilityPackageClientVersion(input)).toBe(4);
    },
  );

  it('accepts a valid manifest without mutating it', () => {
    const input = manifest();
    const snapshot = structuredClone(input);
    expect(validatePipelinePackageManifest(input)).toEqual({ ok: true });
    expect(input).toEqual(snapshot);
  });

  it('validates publisher not-a-command notes without accepting paths', () => {
    const input = manifest();
    const note = {
      id: 'not-a-command-1',
      kind: 'not_a_command' as const,
      label: '/collect.py',
      affectedSteps: [{ jobId: 'job-a', stepId: 'step-a' }],
    };
    input.publisherNotes = [note];
    expect(validatePipelinePackageManifest(input)).toEqual({ ok: true });

    note.label = '/a:b:c';
    expect(validatePipelinePackageManifest(input)).toEqual({ ok: true });

    note.label = '/usr/bin/env';
    expect(validatePipelinePackageManifest(input)).toMatchObject({ ok: false });
  });

  it.each([
    '../secret',
    '/absolute',
    './dot',
    'nested/../escape',
    'nested\\windows',
    'scripts/build:release.sh',
    'scripts/build?.sh',
    'CON',
    'folder/aux.txt',
  ])('rejects unsafe package path %s', (path) => {
    const input = manifest();
    firstEntry(input).path = path;
    expect(validatePipelinePackageManifest(input)).toMatchObject({ ok: false });
  });

  it('rejects Windows-invalid materialized resource and root directory names', () => {
    const invalidResource = manifest();
    firstResource(invalidResource).id = 'resource:bad';
    expect(validatePipelinePackageManifest(invalidResource)).toMatchObject({
      ok: false,
    });

    const invalidRoot = manifest();
    const tree = firstResource(invalidRoot).trees[0];
    if (!tree) throw new Error('Fixture tree is missing');
    tree.rootName = 'plugin:bad';
    expect(validatePipelinePackageManifest(invalidRoot)).toMatchObject({
      ok: false,
    });
  });

  it('rejects duplicate and case-fold-colliding paths', () => {
    for (const path of ['commands/b.md', 'COMMANDS/B.MD']) {
      const input = manifest();
      firstResource(input).trees[0]?.entries.push({
        path,
        sha256: HASH_A,
        size: 1,
        mode: 'execute',
      });
      input.totalFiles = 3;
      input.totalBytes = 8;
      expect(validatePipelinePackageManifest(input)).toMatchObject({
        ok: false,
      });
    }
  });

  it('enforces per-file, total-file, total-byte, and canonical-size limits', () => {
    const oversizedFile = manifest();
    firstEntry(oversizedFile).size = 4 * 1024 * 1024 + 1;
    oversizedFile.totalBytes = 4 * 1024 * 1024 + 4;
    expect(validatePipelinePackageManifest(oversizedFile)).toMatchObject({
      ok: false,
    });

    const tooMany = manifest();
    const firstTree = firstResource(tooMany).trees[0];
    if (!firstTree) throw new Error('Fixture tree is missing');
    firstTree.entries = Array.from({ length: 1_025 }, (_, index) => ({
      path: `commands/${index}.md`,
      sha256: HASH_A,
      size: 1,
      mode: 'read' as const,
    }));
    tooMany.totalFiles = 1_026;
    tooMany.totalBytes = 1_028;
    expect(validatePipelinePackageManifest(tooMany)).toMatchObject({
      ok: false,
    });

    const tooLarge = manifest();
    firstEntry(tooLarge).size = 4 * 1024 * 1024;
    const secondEntry = tooLarge.resources[1]?.trees[0]?.entries[0];
    if (!secondEntry) throw new Error('Second fixture entry is missing');
    secondEntry.size = 4 * 1024 * 1024;
    tooLarge.totalBytes = 32 * 1024 * 1024 + 1;
    expect(validatePipelinePackageManifest(tooLarge)).toMatchObject({
      ok: false,
    });

    const hugeManifest = manifest();
    firstResource(hugeManifest).displayName = 'x'.repeat(8 * 1024 * 1024);
    expect(validatePipelinePackageManifest(hugeManifest)).toMatchObject({
      ok: false,
    });
  });

  it('rejects malformed hashes, totals, modes, and dangling references', () => {
    const cases: Array<(input: PipelinePackageManifestV1) => void> = [
      (input: PipelinePackageManifestV1): void => {
        input.pipelineContentHash = 'bad';
      },
      (input: PipelinePackageManifestV1): void => {
        input.totalBytes += 1;
      },
      (input: PipelinePackageManifestV1): void => {
        firstEntry(input).mode = 'write' as 'read';
      },
      (input: PipelinePackageManifestV1): void => {
        const binding = input.bindings[0];
        if (!binding) throw new Error('Fixture binding is missing');
        binding.resourceIds = ['missing'];
      },
    ];

    for (const mutate of cases) {
      const input = manifest();
      mutate(input);
      expect(validatePipelinePackageManifest(input)).toMatchObject({
        ok: false,
      });
    }
  });
});

describe('capability package subject bindings', () => {
  function subjectManifest(): CapabilityPackageManifestV1 {
    const input: CapabilityPackageManifestV1 = manifest();
    input.bindings = [
      { target: 'subject', resourceIds: ['resource-a', 'resource-b'] },
    ];
    return input;
  }

  it('re-exports the pipeline names as neutral capability aliases', () => {
    expect(CAPABILITY_PACKAGE_VERSION).toBe(PIPELINE_PACKAGE_VERSION);
    expect(CAPABILITY_PACKAGE_VERSION_HEADER).toBe(
      PIPELINE_PACKAGE_VERSION_HEADER,
    );
    expect(CAPABILITY_PACKAGE_CLIENT_VERSION).toBe(
      PIPELINE_PACKAGE_CLIENT_VERSION,
    );
    expect(canonicalizeCapabilityPackageManifest).toBe(
      canonicalizePipelinePackageManifest,
    );
    expect(computeCapabilityPackageDigest).toBe(computePipelinePackageDigest);
    expect(validateCapabilityPackageManifest).toBe(
      validatePipelinePackageManifest,
    );
  });

  it('accepts a whole-share binding inside manifest version 1', () => {
    const input = subjectManifest();
    expect(input.version).toBe(1);
    expect(validateCapabilityPackageManifest(input)).toEqual({ ok: true });
  });

  it('canonicalizes subject and step bindings to one stable digest', async () => {
    const first = manifest();
    first.bindings = [
      { target: 'subject', resourceIds: ['resource-b', 'resource-a'] },
      { jobId: 'job-a', stepId: 'step-a', resourceIds: ['resource-a'] },
    ];
    const second = manifest();
    second.bindings = [
      { jobId: 'job-a', stepId: 'step-a', resourceIds: ['resource-a'] },
      { target: 'subject', resourceIds: ['resource-a', 'resource-b'] },
    ];
    expect(canonicalizeCapabilityPackageManifest(first)).toBe(
      canonicalizeCapabilityPackageManifest(second),
    );
    expect(await computeCapabilityPackageDigest(first)).toBe(
      await computeCapabilityPackageDigest(second),
    );
    expect(await computeCapabilityPackageDigest(first)).toMatch(
      /^pp:v1:[A-Za-z0-9_-]{43}$/,
    );
  });

  it('keeps a step-bound manifest digest unchanged by the additive field', async () => {
    // A REAL pin, not a self-comparison. Comparing
    // `computeCapabilityPackageDigest` to `computePipelinePackageDigest` proves
    // nothing: the assertion above pins them as the same function object, so
    // that form reduces to `f(x) === f(x)` and would stay green through any
    // canonicalization change — stranding every already-uploaded package.
    //
    // This literal is the digest the PRE-change implementation produced for this
    // fixture. Verified by running this exact fixture through the base revision's
    // `canonicalizePipelinePackageManifest` and this revision's
    // `canonicalizeCapabilityPackageManifest` side by side: the canonical strings
    // are byte-identical, which is what makes the value below a genuine pin
    // rather than a restatement of current behavior. (Consistent with the
    // structural reason: the step-binding branch still emits exactly
    // `{jobId, stepId, resourceIds}` and still sorts on `${jobId}\0${stepId}`,
    // because the subject branch fires only when `target` is present.)
    //
    // If this assertion ever fails, the canonical form moved and every
    // already-uploaded package is stranded. Do NOT update the literal — bump the
    // package wire version instead.
    expect(await computeCapabilityPackageDigest(manifest())).toBe(
      'pp:v1:cjPDmUGfmLLgCPYME1fvzwDafifHhKghYFWcup_i-6o',
    );
    expect(canonicalizeCapabilityPackageManifest(manifest())).not.toContain(
      'subject',
    );
  });

  it('rejects a malformed or duplicated subject binding', () => {
    const duplicated = subjectManifest();
    duplicated.bindings = [
      { target: 'subject', resourceIds: ['resource-a'] },
      { target: 'subject', resourceIds: ['resource-b'] },
    ];
    expect(validateCapabilityPackageManifest(duplicated)).toMatchObject({
      ok: false,
    });

    const unknownTarget = subjectManifest();
    unknownTarget.bindings = [
      { target: 'whole', resourceIds: ['resource-a'] } as unknown as {
        target: 'subject';
        resourceIds: string[];
      },
    ];
    expect(validateCapabilityPackageManifest(unknownTarget)).toMatchObject({
      ok: false,
    });

    const mixedShape = subjectManifest();
    mixedShape.bindings = [
      {
        target: 'subject',
        jobId: 'job-a',
        resourceIds: ['resource-a'],
      } as unknown as { target: 'subject'; resourceIds: string[] },
    ];
    expect(validateCapabilityPackageManifest(mixedShape)).toMatchObject({
      ok: false,
    });

    const dangling = subjectManifest();
    dangling.bindings = [{ target: 'subject', resourceIds: ['missing'] }];
    expect(validateCapabilityPackageManifest(dangling)).toMatchObject({
      ok: false,
    });
  });

  it('narrows a binding to its target', () => {
    expect(
      isCapabilityPackageSubjectBinding({
        target: 'subject',
        resourceIds: [],
      }),
    ).toBe(true);
    expect(
      isCapabilityPackageSubjectBinding({
        jobId: 'job-a',
        stepId: 'step-a',
        resourceIds: [],
      }),
    ).toBe(false);
  });

  it('requires newer clients for additive manifest features', () => {
    expect(requiredCapabilityPackageClientVersion(manifest())).toBe(1);
    const noted = manifest();
    noted.publisherNotes = [];
    expect(requiredCapabilityPackageClientVersion(noted)).toBe(2);
    expect(requiredCapabilityPackageClientVersion(subjectManifest())).toBe(3);
    const portableAction = manifest();
    const resource = portableAction.resources[0];
    if (!resource) throw new Error('Fixture resource is missing');
    resource.kind = 'pipeline_action';
    expect(requiredCapabilityPackageClientVersion(portableAction)).toBe(4);
    expect(CAPABILITY_PACKAGE_CLIENT_VERSION).toBe(6);
    const pinned = manifest();
    const pinnedResource = pinned.resources[0];
    if (!pinnedResource) throw new Error('Fixture resource is missing');
    pinnedResource.installedItemRef = {
      kind: 'plugin',
      marketplaceId: 'market',
      pluginName: 'plugin',
    };
    expect(requiredCapabilityPackageClientVersion(pinned)).toBe(5);
  });

  it('requires client version 6 for automation pipelines and file assets, over version 5', () => {
    const packaged = automationPipelineManifest();
    expect(requiredCapabilityPackageClientVersion(packaged)).toBe(6);
    const pinnedResource = packaged.resources[0];
    if (!pinnedResource) throw new Error('Fixture resource is missing');
    pinnedResource.installedItemRef = {
      kind: 'plugin',
      marketplaceId: 'market',
      pluginName: 'plugin',
    };
    expect(requiredCapabilityPackageClientVersion(packaged)).toBe(6);
    const assetOnly = manifest();
    assetOnly.resources.push({ ...assetResource(), pipelineKey: 'missing' });
    expect(requiredCapabilityPackageClientVersion(assetOnly)).toBe(6);
  });
});

function pipelineResource(key = 'action'): PipelinePackageResource {
  return {
    id: `automation-pipeline-${key}`,
    kind: 'automation_pipeline',
    displayName: `Pipeline ${key}`,
    sourceLabel: key,
    sourceVisibility: 'local',
    invocationKeys: [],
    dependencyResourceIds: [],
    pipelineKey: key,
    pipelineContentHash: HASH_C,
    trees: [
      {
        provider: 'claude',
        runtimeKind: 'automation_pipeline',
        rootName: key,
        entries: [
          { path: 'pipeline.yaml', sha256: HASH_C, size: 5, mode: 'read' },
        ],
      },
    ],
  };
}

function assetResource(key = 'action'): PipelinePackageResource {
  return {
    id: `file-asset-${key}-specialists`,
    kind: 'file_asset',
    displayName: 'specialists',
    sourceLabel: key,
    sourceVisibility: 'local',
    invocationKeys: [],
    dependencyResourceIds: [],
    pipelineKey: key,
    assetId: 'specialists',
    installMode: 'seed',
    required: true,
    trees: [
      {
        provider: 'claude',
        runtimeKind: 'pipeline_asset',
        rootName: 'specialists',
        entries: [
          { path: 'a/one.json', sha256: HASH_B, size: 6, mode: 'read' },
        ],
      },
    ],
  };
}

function automationPipelineManifest(): PipelinePackageManifestV1 {
  const input = manifest();
  input.resources.push(pipelineResource(), assetResource());
  input.totalFiles += 2;
  input.totalBytes += 11;
  return input;
}

function resourceAt(
  value: PipelinePackageManifestV1,
  index: number,
): PipelinePackageResource {
  const resource = value.resources[index];
  if (!resource) throw new Error('Fixture resource is missing');
  return resource;
}

function expectInvalid(value: unknown, fragment: string): void {
  const result = validatePipelinePackageManifest(value);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.join('\n')).toContain(fragment);
}

describe('automation pipeline and file asset resources', () => {
  it('accepts an automation pipeline with its asset', () => {
    expect(
      validatePipelinePackageManifest(automationPipelineManifest()),
    ).toEqual({ ok: true });
  });

  it('keeps the new fields through canonicalization and the digest', async () => {
    const first = automationPipelineManifest();
    const second = automationPipelineManifest();
    second.resources.reverse();
    const canonical = canonicalizePipelinePackageManifest(first);
    expect(canonical).toBe(canonicalizePipelinePackageManifest(second));
    expect(canonical).toContain('"pipelineKey":"action"');
    expect(canonical).toContain(`"pipelineContentHash":"${HASH_C}"`);
    expect(canonical).toContain('"assetId":"specialists"');
    expect(canonical).toContain('"installMode":"seed"');
    expect(canonical).toContain('"required":true');
    const flipped = automationPipelineManifest();
    resourceAt(flipped, 3).installMode = 'replace';
    expect(await computePipelinePackageDigest(flipped)).not.toBe(
      await computePipelinePackageDigest(first),
    );
  });

  it('requires pipelineKey and pipelineContentHash on automation pipelines', () => {
    const missingKey = automationPipelineManifest();
    delete resourceAt(missingKey, 2).pipelineKey;
    expectInvalid(missingKey, 'resources[2].pipelineKey is invalid');

    const badKey = automationPipelineManifest();
    resourceAt(badKey, 2).pipelineKey = '../escape';
    expectInvalid(badKey, 'resources[2].pipelineKey is invalid');

    const missingHash = automationPipelineManifest();
    delete resourceAt(missingHash, 2).pipelineContentHash;
    expectInvalid(missingHash, 'resources[2].pipelineContentHash is invalid');

    const badHash = automationPipelineManifest();
    resourceAt(badHash, 2).pipelineContentHash = 'abc';
    expectInvalid(badHash, 'resources[2].pipelineContentHash is invalid');
  });

  it('requires assetId, installMode and required on file assets', () => {
    const badAsset = automationPipelineManifest();
    resourceAt(badAsset, 3).assetId = 'Bad-Id';
    expectInvalid(badAsset, 'resources[3].assetId is invalid');

    const badMode = automationPipelineManifest();
    Object.assign(resourceAt(badMode, 3), { installMode: 'merge' });
    expectInvalid(badMode, 'resources[3].installMode is invalid');

    const missingRequired = automationPipelineManifest();
    delete resourceAt(missingRequired, 3).required;
    expectInvalid(missingRequired, 'resources[3].required is invalid');
  });

  it('rejects the new fields on other kinds', () => {
    const onSkill = manifest();
    Object.assign(resourceAt(onSkill, 0), {
      pipelineKey: 'action',
      pipelineContentHash: HASH_C,
      assetId: 'specialists',
      installMode: 'seed',
      required: true,
    });
    const result = validatePipelinePackageManifest(onSkill);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'resources[0].pipelineKey is only allowed on pipeline resources',
        'resources[0].pipelineContentHash is only allowed on automation pipelines',
        'resources[0].assetId is only allowed on file assets',
        'resources[0].installMode is only allowed on file assets',
        'resources[0].required is only allowed on file assets',
      ]),
    );

    const hashOnAsset = automationPipelineManifest();
    resourceAt(hashOnAsset, 3).pipelineContentHash = HASH_C;
    expectInvalid(
      hashOnAsset,
      'resources[3].pipelineContentHash is only allowed on automation pipelines',
    );

    const assetFieldsOnPipeline = automationPipelineManifest();
    resourceAt(assetFieldsOnPipeline, 2).required = false;
    expectInvalid(
      assetFieldsOnPipeline,
      'resources[2].required is only allowed on file assets',
    );
  });

  it('rejects duplicate automation pipeline keys', () => {
    const duplicated = automationPipelineManifest();
    duplicated.resources.push({
      ...pipelineResource(),
      id: 'automation-pipeline-action-2',
    });
    duplicated.totalFiles += 1;
    duplicated.totalBytes += 5;
    expectInvalid(duplicated, 'Duplicate pipeline key: action');
  });

  it('rejects a file asset whose pipelineKey names no automation pipeline', () => {
    const orphan = automationPipelineManifest();
    resourceAt(orphan, 3).pipelineKey = 'project-other';
    expectInvalid(
      orphan,
      'resources[3].pipelineKey names no automation pipeline: project-other',
    );
  });

  it('keeps pipeline and asset trees on their own kinds', () => {
    const pipelineTreeOnSkill = manifest();
    const skillTree = resourceAt(pipelineTreeOnSkill, 1).trees[0];
    if (!skillTree) throw new Error('Fixture tree is missing');
    skillTree.runtimeKind = 'automation_pipeline';
    expectInvalid(
      pipelineTreeOnSkill,
      'resources[1].trees[0].runtimeKind does not match resources[1].kind',
    );

    const assetTreeOnSkill = manifest();
    const commandTree = resourceAt(assetTreeOnSkill, 0).trees[0];
    if (!commandTree) throw new Error('Fixture tree is missing');
    commandTree.runtimeKind = 'pipeline_asset';
    expectInvalid(
      assetTreeOnSkill,
      'resources[0].trees[0].runtimeKind does not match resources[0].kind',
    );

    const skillTreeOnPipeline = automationPipelineManifest();
    const pipelineTree = resourceAt(skillTreeOnPipeline, 2).trees[0];
    if (!pipelineTree) throw new Error('Fixture tree is missing');
    pipelineTree.runtimeKind = 'standalone_skill';
    expectInvalid(
      skillTreeOnPipeline,
      'resources[2].trees[0].runtimeKind does not match resources[2].kind',
    );

    const pipelineTreeOnAsset = automationPipelineManifest();
    const assetTree = resourceAt(pipelineTreeOnAsset, 3).trees[0];
    if (!assetTree) throw new Error('Fixture tree is missing');
    assetTree.runtimeKind = 'automation_pipeline';
    expectInvalid(
      pipelineTreeOnAsset,
      'resources[3].trees[0].runtimeKind does not match resources[3].kind',
    );
  });

  it('requires one pipeline.yaml entry in one tree rooted at the key', () => {
    const renamed = automationPipelineManifest();
    const renamedEntry = resourceAt(renamed, 2).trees[0]?.entries[0];
    if (!renamedEntry) throw new Error('Fixture entry is missing');
    renamedEntry.path = 'other.yaml';
    expectInvalid(renamed, 'must carry exactly one pipeline.yaml entry');

    const extra = automationPipelineManifest();
    resourceAt(extra, 2).trees[0]?.entries.push({
      path: 'extra.yaml',
      sha256: HASH_C,
      size: 1,
      mode: 'read',
    });
    extra.totalFiles += 1;
    extra.totalBytes += 1;
    expectInvalid(extra, 'must carry exactly one pipeline.yaml entry');

    const noTree = automationPipelineManifest();
    resourceAt(noTree, 2).trees = [];
    noTree.totalFiles -= 1;
    noTree.totalBytes -= 5;
    expectInvalid(noTree, 'resources[2] must carry exactly one pipeline tree');

    const wrongRoot = automationPipelineManifest();
    const wrongRootTree = resourceAt(wrongRoot, 2).trees[0];
    if (!wrongRootTree) throw new Error('Fixture tree is missing');
    wrongRootTree.rootName = 'other';
    expectInvalid(
      wrongRoot,
      'resources[2].trees[0].rootName must equal resources[2].pipelineKey',
    );

    const wrongAssetRoot = automationPipelineManifest();
    const wrongAssetTree = resourceAt(wrongAssetRoot, 3).trees[0];
    if (!wrongAssetTree) throw new Error('Fixture tree is missing');
    wrongAssetTree.rootName = 'other';
    expectInvalid(
      wrongAssetRoot,
      'resources[3].trees[0].rootName must equal resources[3].assetId',
    );
  });

  it('accepts an empty asset tree and an asset without a tree', () => {
    const empty = automationPipelineManifest();
    const tree = resourceAt(empty, 3).trees[0];
    if (!tree) throw new Error('Fixture tree is missing');
    tree.entries = [];
    empty.totalFiles -= 1;
    empty.totalBytes -= 6;
    expect(validatePipelinePackageManifest(empty)).toEqual({ ok: true });
    resourceAt(empty, 3).trees = [];
    expect(validatePipelinePackageManifest(empty)).toEqual({ ok: true });
  });
});

describe('listCapabilityPackageExecutablePaths', () => {
  it('lists each runnable file once, across provider copies, in path order', () => {
    const entry = (
      path: string,
      mode: PipelinePackageFileEntry['mode'],
    ): PipelinePackageFileEntry => ({ path, sha256: HASH_A, size: 1, mode });
    const resource: PipelinePackageResource = {
      id: 'skill',
      kind: 'standalone_skill',
      displayName: 'Deploy',
      sourceLabel: 'local',
      sourceVisibility: 'local',
      invocationKeys: ['/deploy'],
      dependencyResourceIds: [],
      // A packaged skill carries one tree per provider with the same files,
      // so the recipient must not see every script listed twice.
      trees: (['claude', 'codex'] as const).map((provider) => ({
        provider,
        runtimeKind: 'standalone_skill',
        rootName: 'deploy',
        entries: [
          entry('SKILL.md', 'read'),
          entry('scripts/zip.sh', 'execute'),
          entry('scripts/check.py', 'execute'),
        ],
      })),
    };

    expect(listCapabilityPackageExecutablePaths(resource)).toEqual([
      'scripts/check.py',
      'scripts/zip.sh',
    ]);
  });
});

describe('capability package provider twins', () => {
  const entry = (
    path: string,
    sha256: string,
    size: number,
  ): PipelinePackageFileEntry => ({ path, sha256, size, mode: 'read' });
  // A shared skill is analyzed once per provider, so the same folder arrives
  // as two resources that differ only in provider and invocation name.
  const twin = (
    provider: 'claude' | 'codex',
    id: string,
    displayName: string,
  ): PipelinePackageResource => ({
    id,
    kind: 'standalone_skill',
    displayName,
    sourceLabel: 'Custom',
    sourceVisibility: 'local',
    invocationKeys: [displayName],
    dependencyResourceIds: [],
    trees: [
      {
        provider,
        runtimeKind: 'standalone_skill',
        rootName: 'deploy',
        entries: [entry('SKILL.md', HASH_A, 10), entry('run.sh', HASH_B, 5)],
      },
    ],
  });
  const claude = twin('claude', 'deploy-claude', '/deploy');
  const codex = twin('codex', 'deploy-codex', '$builtin-app-plugin:deploy');
  const other: PipelinePackageResource = {
    ...twin('claude', 'helper', '/helper'),
    trees: [
      {
        provider: 'claude',
        runtimeKind: 'standalone_skill',
        rootName: 'helper',
        entries: [entry('SKILL.md', HASH_B, 7)],
      },
    ],
  };

  it('groups one skill folder packaged for each provider, Claude first', () => {
    expect(
      groupCapabilityPackageProviderTwins([codex, other, claude]).map((group) =>
        group.map((resource) => resource.id),
      ),
    ).toEqual([['deploy-claude', 'deploy-codex'], ['helper']]);
  });

  it('never groups two resources from the same provider', () => {
    expect(
      groupCapabilityPackageProviderTwins([
        claude,
        { ...claude, id: 'deploy-claude-2' },
      ]),
    ).toHaveLength(2);
  });

  it('counts each distinct file once across provider copies', () => {
    expect(countCapabilityPackageDistinctFiles([claude, codex])).toEqual({
      files: 2,
      bytes: 15,
    });
    expect(countCapabilityPackageDistinctFiles([claude, other])).toEqual({
      files: 3,
      bytes: 22,
    });
  });
});
