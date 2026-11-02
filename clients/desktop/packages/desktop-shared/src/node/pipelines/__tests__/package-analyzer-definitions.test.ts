import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  computePipelinePackageDigest,
  validatePipelinePackageManifest,
} from '@canopy/protocol/pipelines';
import {
  SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
  encodeSharedContainerDefinitionDocument,
  type SharedContainerDefinitionDocument,
} from '@canopy/protocol/shared-containers';
import type { InvocableInventoryEntry } from '../../../types/invocable-inventory';
import {
  analyzeCapabilityPackage,
  capabilityPackageDefinitionResourceId,
  type AnalyzeCapabilityPackageInput,
  type CapabilityPackageDefinitionResourceInput,
} from '../package-analyzer';

const PIPELINE_IDENTITY = 'pipeline:user:review';
const AUTOMATION_IDENTITY = 'automation:nightly';
const PIPELINE_ID = capabilityPackageDefinitionResourceId(
  'pipeline_definition',
  PIPELINE_IDENTITY,
);

function skillEntry(
  name: string,
  provider: 'claude' | 'codex' = 'claude',
): InvocableInventoryEntry {
  const prefix = provider === 'codex' ? '$' : '/';
  return {
    id: `${name}-${provider}`,
    provider,
    kind: 'skill',
    name,
    displayName: name,
    description: '',
    insertText: `${prefix}${name} `,
    invocationKey: `${prefix}${name}`,
    enableRef: { kind: 'skill', sourceId: 'custom:app', skillName: name },
  };
}

function pipelineDefinition(
  overrides: Partial<CapabilityPackageDefinitionResourceInput> = {},
): CapabilityPackageDefinitionResourceInput {
  const document: SharedContainerDefinitionDocument = {
    version: 1,
    kind: 'pipeline_definition',
    references: [],
    name: 'Review',
    yaml: 'name: Review\non: dispatch\njobs: {}\n',
  };
  return {
    kind: 'pipeline_definition',
    displayName: 'Review',
    identity: PIPELINE_IDENTITY,
    document: encodeSharedContainerDefinitionDocument(document),
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    promptTexts: [{ provider: 'claude', text: 'Run /helper on the diff.' }],
    ...overrides,
  };
}

function automationDefinition(
  references: string[] = [PIPELINE_ID],
): CapabilityPackageDefinitionResourceInput {
  const document: SharedContainerDefinitionDocument = {
    version: 1,
    kind: 'automation_definition',
    references,
    automation: {
      version: 1,
      name: 'Nightly review',
      description: '',
      trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: { source: 'unresolved', name: 'Review' },
        inputKeys: [],
      },
      hasRunCondition: false,
    },
    target: { kind: 'source-container' },
    uses: { pipeline: PIPELINE_ID },
  };
  return {
    kind: 'automation_definition',
    displayName: 'Nightly review',
    identity: AUTOMATION_IDENTITY,
    document: encodeSharedContainerDefinitionDocument(document),
    bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    dependsOnIdentities: [PIPELINE_IDENTITY],
  };
}

describe('analyzeCapabilityPackage definition resources', () => {
  let root: string;
  let base: AnalyzeCapabilityPackageInput;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'capability-definitions-'));
    for (const name of ['helper', 'formatter']) {
      await mkdir(join(root, name), { recursive: true });
    }
    await writeFile(
      join(root, 'helper', 'SKILL.md'),
      '# Helper\n\nThen run /formatter.\n',
    );
    await writeFile(join(root, 'formatter', 'SKILL.md'), '# Formatter\n');
    base = {
      rawContent: '{"container":"example"}',
      requests: [],
      invocableInventory: {
        version: 5,
        builtAt: new Date(0).toISOString(),
        entries: [skillEntry('helper'), skillEntry('formatter')],
      },
      sourceByInventoryEntryId: {
        'helper-claude': {
          sourceRoot: root,
          memberPath: 'helper',
          sourceVisibility: 'local',
          runtimeKind: 'standalone_skill',
          rootName: 'helper',
        },
        'formatter-claude': {
          sourceRoot: root,
          memberPath: 'formatter',
          sourceVisibility: 'local',
          runtimeKind: 'standalone_skill',
          rootName: 'formatter',
        },
      },
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores one read-only canonical document with its full dependency closure', async () => {
    const definition = pipelineDefinition();
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [definition],
    });

    expect(result.summary.blockers).toEqual([]);
    expect(result.summary.state).toBe('ready');
    const manifest = result.summary.manifest;
    expect(manifest).toBeDefined();
    if (!manifest) return;
    expect(validatePipelinePackageManifest(manifest)).toEqual({ ok: true });
    const resource = manifest.resources.find((item) => item.id === PIPELINE_ID);
    const sha256 = createHash('sha256')
      .update(definition.document)
      .digest('hex');
    expect(resource).toMatchObject({
      kind: 'pipeline_definition',
      displayName: 'Review',
      sourceVisibility: 'local',
      invocationKeys: [],
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'standalone_skill',
          rootName: PIPELINE_ID,
          entries: [
            {
              path: SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
              sha256,
              size: definition.document.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    });
    expect(result.blobs.get(sha256)).toEqual(definition.document);
    // `/helper` is discovered from the prompt; `/formatter` transitively.
    const skillIds = manifest.resources
      .filter((item) => item.kind === 'standalone_skill')
      .map((item) => item.id)
      .sort();
    expect(skillIds).toHaveLength(2);
    expect(resource?.dependencyResourceIds).toEqual(skillIds);
    expect(manifest.bindings).toEqual([
      {
        target: 'subject',
        resourceIds: [PIPELINE_ID, ...skillIds].sort(),
      },
    ]);
  });

  it('resolves local selection request keys against inventory enable refs', async () => {
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [
        pipelineDefinition({
          promptTexts: [],
          requestKeys: [
            {
              key: 'skill:custom:app:formatter',
              provider: 'claude',
              required: true,
            },
          ],
        }),
      ],
    });
    expect(result.summary.state).toBe('ready');
    const resource = result.summary.manifest?.resources.find(
      (item) => item.id === PIPELINE_ID,
    );
    expect(resource?.dependencyResourceIds).toHaveLength(1);
  });

  it('blocks on a required request or prompt invocation that cannot be resolved', async () => {
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [
        pipelineDefinition({
          promptTexts: [
            { provider: 'claude', text: 'Run /missing:command now.' },
          ],
          requestKeys: [
            {
              key: 'skill:custom:app:absent',
              provider: 'codex',
              required: true,
            },
          ],
        }),
      ],
    });
    expect(result.summary.state).toBe('blocked');
    expect(
      result.summary.blockers.map((blocker) => blocker.code).sort(),
    ).toEqual(['MISSING_DEPENDENCY_SOURCE', 'UNRESOLVED_INVOCATION']);
  });

  it('includes depended-on definitions and their skills in the closure', async () => {
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [automationDefinition(), pipelineDefinition()],
    });
    expect(result.summary.blockers).toEqual([]);
    const manifest = result.summary.manifest;
    const automationId = capabilityPackageDefinitionResourceId(
      'automation_definition',
      AUTOMATION_IDENTITY,
    );
    const automation = manifest?.resources.find(
      (item) => item.id === automationId,
    );
    const pipeline = manifest?.resources.find(
      (item) => item.id === PIPELINE_ID,
    );
    expect(automation?.dependencyResourceIds).toEqual(
      [PIPELINE_ID, ...(pipeline?.dependencyResourceIds ?? [])].sort(),
    );
    expect(manifest && validatePipelinePackageManifest(manifest)).toEqual({
      ok: true,
    });
  });

  it('blocks rather than emit a dangling definition reference', async () => {
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [automationDefinition()],
    });
    expect(result.summary.state).toBe('blocked');
    expect(
      result.summary.blockers.map((blocker) => blocker.code).sort(),
    ).toEqual(['INVALID_PACKAGE', 'MISSING_DEPENDENCY_SOURCE']);
    const automation = result.summary.manifest?.resources.find(
      (item) => item.kind === 'automation_definition',
    );
    expect(automation?.dependencyResourceIds).toEqual([]);
  });

  it('refuses a document that is invalid or not canonical', async () => {
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [
        pipelineDefinition({
          document: new TextEncoder().encode(
            JSON.stringify(
              {
                version: 1,
                kind: 'pipeline_definition',
                references: [],
                name: 'Review',
                yaml: 'name: Review\n',
              },
              null,
              2,
            ),
          ),
        }),
      ],
    });
    expect(result.summary.state).toBe('blocked');
    expect(result.summary.blockers[0]?.code).toBe('INVALID_PACKAGE');
    expect(
      result.summary.manifest?.resources.some(
        (item) => item.kind === 'pipeline_definition',
      ),
    ).toBe(false);
  });

  it('produces the same digest regardless of input order', async () => {
    const first = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [automationDefinition(), pipelineDefinition()],
    });
    const second = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [pipelineDefinition(), automationDefinition()],
    });
    expect(first.summary.manifest).toEqual(second.summary.manifest);
    const firstManifest = first.summary.manifest;
    const secondManifest = second.summary.manifest;
    if (!firstManifest || !secondManifest) throw new Error('missing manifest');
    expect(await computePipelinePackageDigest(firstManifest)).toBe(
      await computePipelinePackageDigest(secondManifest),
    );
    expect(firstManifest.resources.map((item) => item.id)).toEqual(
      [...firstManifest.resources.map((item) => item.id)].sort(),
    );
  });

  it('packages child pipelines as definition dependencies', async () => {
    await mkdir(join(root, 'pipelines'), { recursive: true });
    await writeFile(
      join(root, 'pipelines', 'child.yaml'),
      'name: Child\non: dispatch\njobs: {}\n',
    );
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [
        pipelineDefinition({
          promptTexts: [],
          portableResources: [
            {
              kind: 'child_pipeline',
              displayName: 'child.yaml',
              invocationKeys: ['child.yaml'],
              descriptor: {
                sourceRoot: join(root, 'pipelines'),
                memberPath: 'child.yaml',
                exportRoot: join(root, 'pipelines'),
                sourceVisibility: 'local',
                runtimeKind: 'plugin_fragment',
                rootName: 'pipelines-child',
              },
            },
          ],
        }),
      ],
    });
    expect(result.summary.blockers).toEqual([]);
    const manifest = result.summary.manifest;
    const child = manifest?.resources.find(
      (item) => item.kind === 'child_pipeline',
    );
    expect(child?.trees[0]?.entries.map((entry) => entry.path)).toEqual([
      'child.yaml',
    ]);
    const pipeline = manifest?.resources.find(
      (item) => item.id === PIPELINE_ID,
    );
    expect(pipeline?.dependencyResourceIds).toEqual([child?.id]);
    expect(manifest?.bindings[0]?.resourceIds).toEqual(
      [PIPELINE_ID, child?.id ?? ''].sort(),
    );
  });

  it('rejects the same definition listed twice', async () => {
    const result = await analyzeCapabilityPackage({
      ...base,
      definitionResources: [pipelineDefinition(), pipelineDefinition()],
    });
    expect(result.summary.blockers.map((blocker) => blocker.code)).toContain(
      'INVALID_PACKAGE',
    );
  });
});
