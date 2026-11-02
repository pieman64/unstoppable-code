// CAN-4655: one capability package per shared-container revision. Usage and
// local stores are injected; the definition builders, the package analyzer,
// manifest validation and digesting are real and read real files.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeCapabilityPackage,
  computePipelinePackageDigestSync,
  type AnalyzeCapabilityPackageInput,
  type CapabilityPackageAnalysisInternal,
  type PipelinePackageSourceDescriptor,
} from '@canopy/desktop-shared/node';
import type {
  ChatTabsFile,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type {
  InvocableInventoryCache,
  InvocableInventoryEntry,
} from '@canopy/desktop-shared/types/invocable-inventory';
import { validatePipelinePackageManifest } from '@canopy/protocol/pipelines';
import {
  parseSharedContainerDefinitionDocument,
  summarizeSharedContainerCapabilityPackage,
  type SharedContainerCapabilityPackageCounts,
  type SharedContainerStageRevisionRequest,
} from '@canopy/protocol/shared-containers';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  buildPortablePipelineResources,
  capabilityInventoryEntryIdsByKey,
} from '../pipelines/pipeline-package-service';
import {
  analyzeSharedContainerCapabilityPackage,
  type AnalyzeSharedContainerCapabilityPackageInput,
  type CompletedSharedContainerCapabilityPackageAnalysis,
  type DiscoveredRepoLocalInvocables,
  type ReadySharedContainerCapabilityPackageAnalysis,
  type SharedContainerCapabilityPackageAnalysis,
  type SharedContainerCapabilityPackageAnalysisDependencies,
  type StoredUserPipelineDefinition,
} from '../shared-containers/capability-package/analyze';
import {
  SharedContainerCapabilityPackageAnalysisCache,
  sharedContainerCapabilityPackageScopeKey,
} from '../shared-containers/capability-package/analysis-cache';
import {
  prepareCodeSharedContainerCapabilityPackage,
  prepareCoworkSharedContainerCapabilityPackage,
  prepareSharedContainerCapabilityPackage,
  sharedContainerSnapshotPathsFromCodeInventory,
  type SharedContainerCapabilityPackagePreparationDependencies,
} from '../shared-containers/capability-package/prepare';
import {
  SharedContainerCapabilityPackagePreviewRefresher,
  type SharedContainerCapabilityPackagePreviewDependencies,
} from '../shared-containers/capability-package/preview';
import type { SharedContainerDefinitionBuilderDependencies } from '../shared-containers/capability-package/definitions';
import type {
  SharedContainerCapabilityReference,
  SharedContainerCapabilityReferenceTarget,
  SharedContainerCapabilityUsage,
  SharedContainerCapabilityUsagePriority,
} from '../shared-containers/publish/capability-usage';
import type { CodePublishInventory } from '../shared-containers/publish/code-inventory';
import type { CoworkPublishInventory } from '../shared-containers/publish/inventory';
import {
  publishSharedContainerRevision,
  type PublishSharedContainerRevisionDependencies,
} from '../shared-containers/publish/pipeline';
import * as publicationState from '../shared-containers/publication-state';
import type { SharedContainerPublicationRecord } from '../shared-containers/publication-state';
import { ShareStageError } from '../sharing/share-operation-result';

const PROJECT = 'project-1';
const WORKTREE = 'worktree-1';

const REVIEW_PIPELINE_YAML = [
  'name: Review',
  'on: dispatch',
  'jobs:',
  '  review:',
  '    steps:',
  '      - id: run',
  '        uses: builtin/agent-prompt',
  '        with:',
  '          prompt: Run /helper on the diff.',
  '          model: agent_model_reviewer',
  '',
].join('\n');

interface Fixture {
  root: string;
  entries: InvocableInventoryEntry[];
  sources: Record<string, PipelinePackageSourceDescriptor>;
  references: SharedContainerCapabilityReference[];
  agents: Map<string, AgentModelDefinition>;
  userPipelines: Map<string, StoredUserPipelineDefinition>;
  automations: ScheduledActivity[];
  repoLocal: Map<string, DiscoveredRepoLocalInvocables>;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'container-package-analysis-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function fixture(): Fixture {
  return {
    root,
    entries: [],
    sources: {},
    references: [],
    agents: new Map(),
    userPipelines: new Map(),
    automations: [],
    repoLocal: new Map(),
  };
}

async function addSkill(
  f: Fixture,
  name: string,
  options: {
    body?: string;
    sourceId?: string;
    executable?: string;
    missing?: boolean;
  } = {},
): Promise<void> {
  const sourceId = options.sourceId ?? 'custom:app';
  const dir = path.join(f.root, 'skills', sourceId.replace(/:/g, '-'), name);
  if (!options.missing) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), options.body ?? `# ${name}\n`);
    if (options.executable) {
      await mkdir(path.join(dir, 'scripts'), { recursive: true });
      const script = path.join(dir, 'scripts', options.executable);
      await writeFile(script, '#!/bin/sh\necho packaged\n');
      await chmod(script, 0o755);
    }
  }
  const id = `${sourceId}:${name}:claude`;
  f.entries.push({
    id,
    provider: 'claude',
    kind: 'skill',
    name,
    displayName: name,
    description: '',
    insertText: `/${name} `,
    invocationKey: `/${name}`,
    enableRef: { kind: 'skill', sourceId, skillName: name },
  });
  f.sources[id] = {
    sourceRoot: dir,
    memberPath: '.',
    sourceVisibility: 'local',
    runtimeKind: 'standalone_skill',
    rootName: name,
  };
}

async function addPlugin(
  f: Fixture,
  pluginName: string,
  member: string,
): Promise<void> {
  const pluginRoot = path.join(f.root, 'plugins', pluginName);
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName }),
  );
  await mkdir(path.join(pluginRoot, 'skills', member), { recursive: true });
  await writeFile(
    path.join(pluginRoot, 'skills', member, 'SKILL.md'),
    `# ${member}\n`,
  );
  const id = `plugin:${pluginName}:${member}:claude`;
  f.entries.push({
    id,
    provider: 'claude',
    kind: 'plugin_skill',
    name: member,
    displayName: member,
    description: '',
    insertText: `/${pluginName}:${member} `,
    invocationKey: `/${pluginName}:${member}`,
    enableRef: { kind: 'plugin', marketplaceId: 'acme', pluginName },
  });
  f.sources[id] = {
    sourceRoot: pluginRoot,
    memberPath: path.join('skills', member),
    sourceVisibility: 'private',
    runtimeKind: 'plugin_fragment',
    rootName: pluginName,
  };
}

function reference(
  target: SharedContainerCapabilityReferenceTarget,
  key: string,
  priority: SharedContainerCapabilityUsagePriority = 'observed',
): SharedContainerCapabilityReference {
  return {
    ...target,
    key,
    provenance: [priority === 'observed' ? 'transcript' : 'selection_fallback'],
    priority,
  };
}

function agentModel(
  overrides: Partial<AgentModelDefinition> = {},
): AgentModelDefinition {
  return {
    id: 'agent_model_reviewer',
    name: 'Reviewer',
    baseModel: 'sonnet',
    instructions: 'Review with /helper before replying.',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function activity(
  id: string,
  action: ScheduledActivity['action'],
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Automation ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    failureCount: 0,
  };
}

function usageOf(
  f: Fixture,
  containerType: SharedContainerCapabilityUsage['containerType'],
): SharedContainerCapabilityUsage {
  const references = [...f.references].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  return {
    containerType,
    references,
    incomplete: false,
    sourceVersion: `scu:test:${createHash('sha256')
      .update(JSON.stringify(references))
      .digest('hex')}`,
    diagnostics: {
      chatsRequested: 0,
      chatsRead: 0,
      chatsFromCache: 0,
      chatsMissing: 0,
      chatsUnreadable: 0,
      duplicateChatIds: 0,
      duplicateVisitsSkipped: 0,
      delegationRunsVisited: 0,
      delegationCyclesSkipped: 0,
      transcriptReferencesTruncated: 0,
      excludedBuiltin: 0,
      excludedCanopyMcp: 0,
      excludedRepoLocal: 0,
      excludedCarriedHooks: 0,
      agentsUnavailable: 0,
      agentsUnreadable: 0,
      pipelineExecutionsMissing: 0,
      pipelineExecutionsUnreadable: 0,
      pipelineDefinitionsUnreadable: 0,
      pipelineChildExecutionsSkipped: 0,
      pipelinesHistorical: 0,
      pipelinesTruncated: 0,
      pipelineSnapshotsUnavailable: 0,
      automationsUnreadable: 0,
      automationSystemSkipped: 0,
      automationRunHistoryTruncated: 0,
      hooksUnavailable: 0,
      cacheDiscarded: 0,
      cacheWriteFailed: 0,
    },
  };
}

function inventoryOf(f: Fixture): InvocableInventoryCache {
  return {
    version: 5,
    builtAt: new Date(0).toISOString(),
    entries: f.entries,
  };
}

function builderDependencies(
  f: Fixture,
): SharedContainerDefinitionBuilderDependencies {
  return {
    loadInventory: () =>
      Promise.resolve({ inventory: inventoryOf(f), sources: f.sources }),
    buildPortablePipelineResources,
    capabilityInventoryEntryIdsByKey,
    mapPluginSelectionsToPortable: () =>
      Promise.resolve({ refs: [], mcpServers: [], unresolved: [] }),
    resolveEffectivePluginSelectionRefs: (selections) =>
      Promise.resolve({
        disabledRefs: [],
        skillRefs: selections.skillRefs,
        pluginRefs: selections.pluginRefs,
        mcpServerRefs: selections.mcpServerRefs ?? [],
        warnings: [],
      }),
    mcpSelectionToEnvironmentRequirement: (selection) =>
      Promise.resolve({
        id: `mcp:${selection.serverId}`,
        kind: 'mcp',
        displayName: selection.serverId,
        required: true,
        affectedSteps: [],
        setupHint: 'Connect this server in Settings.',
      }),
  };
}

type Analyze = SharedContainerCapabilityPackageAnalysisDependencies['analyze'];

function dependencies(
  f: Fixture,
  overrides: Partial<SharedContainerCapabilityPackageAnalysisDependencies> = {},
): SharedContainerCapabilityPackageAnalysisDependencies & {
  analyze: jest.MockedFunction<Analyze>;
} {
  const analyze = jest.fn<ReturnType<Analyze>, Parameters<Analyze>>(
    overrides.analyze ?? analyzeCapabilityPackage,
  );
  return {
    collectUsage: (input) => Promise.resolve(usageOf(f, input.containerType)),
    loadInventory: () =>
      Promise.resolve({ inventory: inventoryOf(f), sources: f.sources }),
    discoverRepoLocalInvocables: (repoPath) =>
      Promise.resolve(
        f.repoLocal.get(repoPath) ?? { entries: [], scannedDirectories: [] },
      ),
    getAgentModel: (agentId) => Promise.resolve(f.agents.get(agentId) ?? null),
    readUserPipeline: (pipelineId) =>
      Promise.resolve(f.userPipelines.get(pipelineId) ?? null),
    readPipelineFile: () => Promise.resolve(null),
    findCuratedPipelineKey: () => Promise.resolve(undefined),
    listAutomations: () => Promise.resolve(f.automations),
    mcpSelectionToEnvironmentRequirement: (selection) =>
      Promise.resolve({
        id: `mcp:${selection.serverId}`,
        kind: 'mcp',
        displayName: selection.serverId,
        required: true,
        affectedSteps: [],
        setupHint: 'Connect this server in Settings.',
      }),
    definitionBuilders: builderDependencies(f),
    ...overrides,
    analyze,
  };
}

function input(
  overrides: Partial<AnalyzeSharedContainerCapabilityPackageInput> = {},
): AnalyzeSharedContainerCapabilityPackageInput {
  return {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    containerType: 'CODE_WORKTREE',
    includedChatIds: ['chat-1'],
    ...overrides,
  };
}

function ready(
  result: SharedContainerCapabilityPackageAnalysis,
): ReadySharedContainerCapabilityPackageAnalysis {
  if (result.state !== 'ready')
    throw new Error(`Expected a ready analysis, got ${result.state}`);
  return result;
}

function resourceNames(
  analysis: ReadySharedContainerCapabilityPackageAnalysis,
): string[] {
  return analysis.manifest.resources
    .map((resource) => resource.displayName)
    .sort();
}

/** A capped analyzer: a package above `limit` bytes reports the total cap. */
function cappedAnalyze(limit: number): Analyze {
  return async (
    analyzerInput: AnalyzeCapabilityPackageInput,
  ): Promise<CapabilityPackageAnalysisInternal> => {
    const result = await analyzeCapabilityPackage(analyzerInput);
    const manifest = result.summary.manifest;
    if (!manifest || manifest.totalBytes <= limit) return result;
    return {
      ...result,
      summary: {
        ...result.summary,
        state: 'blocked',
        blockers: [
          ...result.summary.blockers,
          {
            code: 'PACKAGE_LIMIT_EXCEEDED',
            limit: 'total_size',
            message: 'The package is too large.',
            occurrences: [],
          },
        ],
      },
    };
  };
}

async function addReviewPipeline(f: Fixture): Promise<void> {
  await addSkill(f, 'helper');
  f.agents.set('agent_model_reviewer', agentModel());
  f.userPipelines.set('pipeline-review', {
    name: 'Review',
    rawYaml: REVIEW_PIPELINE_YAML,
  });
}

describe('analyzeSharedContainerCapabilityPackage', () => {
  it('resolves every reference kind into one validated package', async () => {
    const f = fixture();
    await addSkill(f, 'alpha');
    await addSkill(f, 'beta');
    await addPlugin(f, 'toolkit', 'tool');
    await addReviewPipeline(f);
    const repo = path.join(root, 'repo');
    await mkdir(path.join(repo, '.claude', 'commands'), { recursive: true });
    const command = path.join(repo, '.claude', 'commands', 'local-cmd.md');
    await writeFile(command, 'Run the local command.\n');
    f.repoLocal.set(repo, {
      entries: [{ name: 'local-cmd', kind: 'command', absolutePath: command }],
      scannedDirectories: [path.join(repo, '.claude')],
    });
    f.automations.push(
      activity('activity-1', {
        type: 'worktree_pipeline',
        workspaceId: PROJECT,
        pipelineId: 'pipeline-review',
        pipelineSource: 'user',
        pipelineName: 'Review',
      }),
    );
    f.references.push(
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'alpha' },
        'skill:alpha',
      ),
      reference(
        { kind: 'plugin', marketplaceId: 'acme', pluginName: 'toolkit' },
        'plugin:toolkit',
      ),
      reference(
        {
          kind: 'invocation',
          token: 'beta',
          provider: 'claude',
          via: ['leading'],
        },
        'invocation:beta',
      ),
      reference(
        {
          kind: 'invocation',
          token: 'local-cmd',
          provider: 'claude',
          via: ['leading'],
        },
        'invocation:local-cmd',
      ),
      reference(
        {
          kind: 'mcp_server',
          identity: {
            kind: 'standalone',
            serverId: 'server-1',
            configId: 'config-1',
          },
        },
        'mcp:server-1',
      ),
      reference(
        {
          kind: 'agent',
          agentId: 'agent_model_reviewer',
          definitionVersion: 'v1',
        },
        'agent:reviewer',
      ),
      reference(
        {
          kind: 'pipeline',
          pipelineId: 'pipeline-review',
          sourceKind: 'user',
          definitionVersion: 'v1',
        },
        'pipeline:review',
      ),
      reference(
        {
          kind: 'automation',
          automationId: 'activity-1',
          definitionVersion: 'v1',
        },
        'automation:1',
      ),
      reference(
        {
          kind: 'hook',
          hookKey: 'project:pr:checks:fail',
          scope: 'project',
          triggerName: 'pr:checks:fail',
          definitionVersion: 'v1',
        },
        'hook:checks',
      ),
    );
    const deps = dependencies(f);
    const result = ready(
      await analyzeSharedContainerCapabilityPackage(
        input({
          repositories: [{ repoId: 'repo-1', repoPath: repo }],
          snapshotPaths: {
            repositories: [
              { repoId: 'repo-1', repoPath: repo, paths: ['README.md'] },
            ],
          },
        }),
        deps,
      ),
    );
    expect(validatePipelinePackageManifest(result.manifest)).toEqual({
      ok: true,
    });
    expect(result.summary).toEqual(
      summarizeSharedContainerCapabilityPackage(
        computePipelinePackageDigestSync(result.manifest),
        result.manifest,
      ),
    );
    const kinds = result.manifest.resources.map((resource) => resource.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'standalone_skill',
        'plugin_skill',
        'plugin_command',
        'agent_definition',
        'pipeline_definition',
        'automation_definition',
      ]),
    );
    // No installer can guarantee a hook starts paused, so hooks never travel.
    expect(kinds).not.toContain('hook_definition');
    expect(result.diagnostics.hooksSkipped).toBe(1);
    expect(result.summary.counts).toEqual({
      // alpha, beta and helper. Plugin members (toolkit:tool and the
      // repo-local command) travel but are not counted as installed.
      skills: 3,
      pipelines: 1,
      agents: 1,
      automations: 1,
      hooks: 0,
    });
    expect(
      result.manifest.environmentRequirements.map((requirement) => ({
        id: requirement.id,
        kind: requirement.kind,
      })),
    ).toContainEqual({ id: 'mcp:server-1', kind: 'mcp' });
    expect(result.manifest.bindings).toEqual([
      expect.objectContaining({ target: 'subject' }),
    ]);
  });

  it('leaves repo-local commands the snapshot carries to the code', async () => {
    const f = fixture();
    await addReviewPipeline(f);
    const repo = path.join(root, 'repo');
    await mkdir(path.join(repo, '.claude', 'commands'), { recursive: true });
    const command = path.join(repo, '.claude', 'commands', 'local-cmd.md');
    await writeFile(command, 'Run the local command.\n');
    f.repoLocal.set(repo, {
      entries: [{ name: 'local-cmd', kind: 'command', absolutePath: command }],
      scannedDirectories: [path.join(repo, '.claude')],
    });
    f.userPipelines.set('pipeline-review', {
      name: 'Review',
      rawYaml: REVIEW_PIPELINE_YAML.replace('/helper', '/local-cmd'),
    });
    f.references.push(
      reference(
        {
          kind: 'pipeline',
          pipelineId: 'pipeline-review',
          sourceKind: 'user',
          definitionVersion: 'v1',
        },
        'pipeline:review',
      ),
    );
    const result = ready(
      await analyzeSharedContainerCapabilityPackage(
        input({
          repositories: [{ repoId: 'repo-1', repoPath: repo }],
          snapshotPaths: {
            repositories: [
              {
                repoId: 'repo-1',
                repoPath: repo,
                paths: ['.claude/commands/local-cmd.md'],
              },
            ],
          },
        }),
        dependencies(f),
      ),
    );
    expect(
      result.manifest.resources.map((resource) => resource.kind),
    ).not.toContain('plugin_command');
    expect(result.summary.counts.pipelines).toBe(1);
  });

  it('omits ambiguous and unresolved references without guessing', async () => {
    const f = fixture();
    await addSkill(f, 'alpha');
    await addSkill(f, 'dup', { sourceId: 'custom:one' });
    await addSkill(f, 'dup', { sourceId: 'custom:two' });
    const repos = [path.join(root, 'repo-a'), path.join(root, 'repo-b')];
    for (const repo of repos) {
      const command = path.join(repo, '.claude', 'commands', 'twin.md');
      await mkdir(path.dirname(command), { recursive: true });
      await writeFile(command, `Twin in ${path.basename(repo)}.\n`);
      f.repoLocal.set(repo, {
        entries: [{ name: 'twin', kind: 'command', absolutePath: command }],
        scannedDirectories: [],
      });
    }
    f.references.push(
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'alpha' },
        'skill:alpha',
      ),
      reference(
        { kind: 'invocation', token: 'dup', provider: 'claude', via: [] },
        'invocation:dup',
      ),
      reference(
        { kind: 'invocation', token: 'twin', provider: 'claude', via: [] },
        'invocation:twin',
      ),
      reference(
        { kind: 'invocation', token: 'missing', provider: 'codex', via: [] },
        'invocation:missing',
      ),
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'gone' },
        'skill:gone',
      ),
    );
    const result = ready(
      await analyzeSharedContainerCapabilityPackage(
        input({
          repositories: repos.map((repoPath, index) => ({
            repoId: `repo-${String(index)}`,
            repoPath,
          })),
        }),
        dependencies(f),
      ),
    );
    expect(resourceNames(result)).toEqual(['alpha']);
    expect(result.diagnostics).toMatchObject({ ambiguous: 2, unresolved: 2 });
  });

  it('packages a deleted pipeline from its historical snapshot with provenance', async () => {
    const f = fixture();
    await addReviewPipeline(f);
    f.references.push(
      reference(
        {
          kind: 'pipeline',
          pipelineId: 'pipeline-gone',
          sourceKind: 'user',
          historical: true,
          historicalSnapshot: {
            format: 'normalized_pipeline_yaml',
            yaml: REVIEW_PIPELINE_YAML.replace('name: Review', 'name: Gone'),
            executionId: 'execution-1',
            capturedAt: '2026-10-20T00:00:00.000Z',
          },
        },
        'pipeline:gone',
      ),
      reference(
        {
          kind: 'pipeline',
          pipelineId: 'pipeline-no-snapshot',
          sourceKind: 'user',
          historical: true,
        },
        'pipeline:no-snapshot',
      ),
    );
    const result = ready(
      await analyzeSharedContainerCapabilityPackage(input(), dependencies(f)),
    );
    const pipeline = result.manifest.resources.find(
      (resource) => resource.kind === 'pipeline_definition',
    );
    expect(pipeline?.displayName).toBe('Gone');
    const entry = pipeline?.trees[0]?.entries[0];
    const bytes = entry ? result.analysis.blobs.get(entry.sha256) : undefined;
    if (!bytes) throw new Error('missing pipeline document');
    const parsed = parseSharedContainerDefinitionDocument(bytes);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    expect(parsed.value.provenance).toEqual({ historicalSnapshot: true });
    expect(result.summary.counts.pipelines).toBe(1);
    expect(result.diagnostics.definitionsOmitted).toBe(1);
  });

  it('produces the same digest regardless of input order', async () => {
    const f = fixture();
    await addSkill(f, 'alpha');
    await addSkill(f, 'beta');
    await addReviewPipeline(f);
    f.references.push(
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'alpha' },
        'skill:alpha',
      ),
      reference(
        { kind: 'invocation', token: 'beta', provider: 'claude', via: [] },
        'invocation:beta',
      ),
      reference(
        {
          kind: 'pipeline',
          pipelineId: 'pipeline-review',
          sourceKind: 'user',
          definitionVersion: 'v1',
        },
        'pipeline:review',
      ),
    );
    const first = ready(
      await analyzeSharedContainerCapabilityPackage(input(), dependencies(f)),
    );
    f.entries.reverse();
    const deps = dependencies(f, {
      collectUsage: () => {
        const usage = usageOf(f, 'CODE_WORKTREE');
        return Promise.resolve({
          ...usage,
          references: [...usage.references].reverse(),
        });
      },
    });
    const second = ready(
      await analyzeSharedContainerCapabilityPackage(input(), deps),
    );
    expect(second.summary.digest).toBe(first.summary.digest);
  });

  it('closes definition dependencies and drops dependents that cannot travel', async () => {
    const f = fixture();
    await addReviewPipeline(f);
    f.automations.push(
      activity('activity-1', {
        type: 'worktree_pipeline',
        workspaceId: PROJECT,
        pipelineId: 'pipeline-review',
        pipelineSource: 'user',
        pipelineName: 'Review',
      }),
    );
    // Its Agent is gone, so it cannot travel.
    f.userPipelines.set('pipeline-ghost', {
      name: 'Ghost',
      rawYaml: REVIEW_PIPELINE_YAML.replace(
        'agent_model_reviewer',
        'agent_model_ghost',
      ),
    });
    f.references.push(
      reference(
        {
          kind: 'automation',
          automationId: 'activity-1',
          definitionVersion: 'v1',
        },
        'automation:1',
      ),
      reference(
        {
          kind: 'pipeline',
          pipelineId: 'pipeline-ghost',
          sourceKind: 'user',
          definitionVersion: 'v1',
        },
        'pipeline:ghost',
      ),
    );
    const result = ready(
      await analyzeSharedContainerCapabilityPackage(input(), dependencies(f)),
    );
    expect(result.summary.counts).toEqual({
      skills: 1,
      pipelines: 1,
      agents: 1,
      automations: 1,
      hooks: 0,
    });
    const byId = new Map(
      result.manifest.resources.map((resource) => [resource.id, resource]),
    );
    const automation = result.manifest.resources.find(
      (resource) => resource.kind === 'automation_definition',
    );
    const closure = new Set<string>();
    const pending = [...(automation?.dependencyResourceIds ?? [])];
    while (pending.length > 0) {
      const id = pending.pop();
      if (!id || closure.has(id)) continue;
      closure.add(id);
      pending.push(...(byId.get(id)?.dependencyResourceIds ?? []));
    }
    expect(Array.from(closure, (id) => byId.get(id)?.kind).sort()).toEqual([
      'agent_definition',
      'pipeline_definition',
      'standalone_skill',
    ]);
    expect(result.diagnostics.dependentsOmitted).toBe(1);
  });

  it('omits a blocked resource and everything that needs it, keeping the rest', async () => {
    const f = fixture();
    await addSkill(f, 'alpha');
    await addSkill(f, 'broken', { missing: true });
    f.agents.set(
      'agent_model_reviewer',
      agentModel({ instructions: 'Always run /broken first.' }),
    );
    f.userPipelines.set('pipeline-review', {
      name: 'Review',
      rawYaml: REVIEW_PIPELINE_YAML.replace('Run /helper on the diff.', 'Go.'),
    });
    f.references.push(
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'alpha' },
        'skill:alpha',
      ),
      reference(
        {
          kind: 'pipeline',
          pipelineId: 'pipeline-review',
          sourceKind: 'user',
          definitionVersion: 'v1',
        },
        'pipeline:review',
      ),
    );
    const result = ready(
      await analyzeSharedContainerCapabilityPackage(input(), dependencies(f)),
    );
    expect(resourceNames(result)).toEqual(['alpha']);
    // The Agent cannot be analyzed, and neither can the pipeline that needs it.
    expect(result.diagnostics.blockedOmitted).toBe(2);
  });

  describe('cap pruning', () => {
    async function cappedFixture(): Promise<Fixture> {
      const f = fixture();
      await addSkill(f, 'a', { body: 'a'.repeat(300) });
      await addSkill(f, 'd', { body: 'd'.repeat(300) });
      await addSkill(f, 'b', { body: 'b'.repeat(100) });
      await addSkill(f, 'c', { body: 'c'.repeat(200) });
      f.references.push(
        reference(
          { kind: 'skill', sourceId: 'custom:app', skillName: 'a' },
          'skill:a',
        ),
        reference(
          { kind: 'skill', sourceId: 'custom:app', skillName: 'd' },
          'skill:d',
        ),
        reference(
          { kind: 'skill', sourceId: 'custom:app', skillName: 'b' },
          'skill:b',
          'fallback',
        ),
        reference(
          { kind: 'skill', sourceId: 'custom:app', skillName: 'c' },
          'skill:c',
          'fallback',
        ),
      );
      return f;
    }

    it('counts per-unit isolation analyses toward the attempt budget', async () => {
      const f = fixture();
      for (let index = 0; index < 30; index += 1) {
        const name = `skill-${String(index).padStart(2, '0')}`;
        await addSkill(f, name, { body: `${name}\n`.repeat(20) });
        f.references.push(
          reference(
            { kind: 'skill', sourceId: 'custom:app', skillName: name },
            `skill:${name}`,
          ),
        );
      }
      const deps = dependencies(f, { analyze: cappedAnalyze(1) });
      await expect(
        analyzeSharedContainerCapabilityPackage(input(), deps),
      ).resolves.toEqual({ state: 'failed', reason: 'prune_budget_exhausted' });
      expect(deps.analyze.mock.calls.length).toBeLessThanOrEqual(24);
    });

    it('stops isolating units once cancelled', async () => {
      const f = await cappedFixture();
      const controller = new AbortController();
      const capped = cappedAnalyze(1);
      const deps = dependencies(f, {
        analyze: async (analyzerInput) => {
          const result = await capped(analyzerInput);
          // Cancel during the first isolation analysis.
          if (deps.analyze.mock.calls.length === 2)
            controller.abort(new Error('cancelled'));
          return result;
        },
      });
      await expect(
        analyzeSharedContainerCapabilityPackage(
          input({ signal: controller.signal }),
          deps,
        ),
      ).rejects.toThrow('cancelled');
      expect(deps.analyze).toHaveBeenCalledTimes(2);
    });

    it('removes fallback-only resources first, largest first', async () => {
      const f = await cappedFixture();
      const result = ready(
        await analyzeSharedContainerCapabilityPackage(
          input(),
          dependencies(f, { analyze: cappedAnalyze(650) }),
        ),
      );
      expect(resourceNames(result)).toEqual(['a', 'd']);
      expect(result.diagnostics.prunedForCaps).toBe(2);
      expect(validatePipelinePackageManifest(result.manifest)).toEqual({
        ok: true,
      });
    });

    it('never drops an observed resource while a fallback one remains and breaks size ties by key', async () => {
      const f = await cappedFixture();
      const result = ready(
        await analyzeSharedContainerCapabilityPackage(
          input(),
          dependencies(f, { analyze: cappedAnalyze(350) }),
        ),
      );
      expect(resourceNames(result)).toEqual(['d']);
      expect(result.summary.counts.skills).toBe(1);
    });

    it('prunes the largest definition with the dependencies only it needed', async () => {
      const f = fixture();
      await addSkill(f, 'a', { body: 'a'.repeat(300) });
      await addSkill(f, 'e', { body: 'e'.repeat(400) });
      f.agents.set(
        'agent_model_big',
        agentModel({
          id: 'agent_model_big',
          name: 'Big',
          instructions: 'Use /e.',
        }),
      );
      f.references.push(
        reference(
          { kind: 'skill', sourceId: 'custom:app', skillName: 'a' },
          'skill:a',
        ),
        reference(
          {
            kind: 'agent',
            agentId: 'agent_model_big',
            definitionVersion: 'v1',
          },
          'agent:big',
        ),
      );
      const result = ready(
        await analyzeSharedContainerCapabilityPackage(
          input(),
          dependencies(f, { analyze: cappedAnalyze(350) }),
        ),
      );
      expect(resourceNames(result)).toEqual(['a']);
      expect(result.summary.counts).toMatchObject({ skills: 1, agents: 0 });
    });

    it('returns empty when nothing fits', async () => {
      const f = await cappedFixture();
      await expect(
        analyzeSharedContainerCapabilityPackage(
          input(),
          dependencies(f, { analyze: cappedAnalyze(10) }),
        ),
      ).resolves.toMatchObject({ state: 'empty' });
    });
  });

  it('discloses executable paths from the final manifest only', async () => {
    const f = fixture();
    await addSkill(f, 'runner', { executable: 'run.sh' });
    await addSkill(f, 'extra', {
      body: 'x'.repeat(4_000),
      executable: 'dropped.sh',
    });
    f.references.push(
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'runner' },
        'skill:runner',
      ),
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'extra' },
        'skill:extra',
        'fallback',
      ),
    );
    const result = ready(
      await analyzeSharedContainerCapabilityPackage(
        input(),
        dependencies(f, { analyze: cappedAnalyze(1_000) }),
      ),
    );
    expect(result.summary.executableFiles).toEqual(['runner/scripts/run.sh']);
    expect(result.summary.counts).toEqual({
      skills: 1,
      pipelines: 0,
      agents: 0,
      automations: 0,
      hooks: 0,
    });
  });

  it.each(['CODE_WORKTREE', 'COWORK_WORK_ENTRY'] as const)(
    'never packages hooks (%s)',
    async (containerType) => {
      const f = fixture();
      f.references.push(
        reference(
          {
            kind: 'hook',
            hookKey: 'project:pr:checks:fail',
            scope: 'project',
            triggerName: 'pr:checks:fail',
            definitionVersion: 'v1',
          },
          'hook:checks',
        ),
      );
      const deps = dependencies(f);
      await expect(
        analyzeSharedContainerCapabilityPackage(input({ containerType }), deps),
      ).resolves.toMatchObject({
        state: 'empty',
        diagnostics: { hooksSkipped: 1 },
      });
    },
  );

  describe('unreadable sources', () => {
    async function reviewed(f: Fixture): Promise<void> {
      await addReviewPipeline(f);
      f.references.push(
        reference(
          { kind: 'skill', sourceId: 'custom:app', skillName: 'helper' },
          'skill:helper',
        ),
        reference(
          {
            kind: 'pipeline',
            pipelineId: 'pipeline-review',
            sourceKind: 'user',
            definitionVersion: 'v1',
          },
          'pipeline:review',
        ),
      );
    }

    it('fails instead of packaging incomplete usage', async () => {
      const f = fixture();
      await reviewed(f);
      const deps = dependencies(f, {
        collectUsage: (usageInput) =>
          Promise.resolve({
            ...usageOf(f, usageInput.containerType),
            incomplete: true,
          }),
      });
      await expect(
        analyzeSharedContainerCapabilityPackage(input(), deps),
      ).resolves.toEqual({ state: 'failed', reason: 'sources_unreadable' });
      expect(deps.analyze).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a user pipeline',
        (): Partial<SharedContainerCapabilityPackageAnalysisDependencies> => ({
          readUserPipeline: () => Promise.reject(new Error('EIO')),
        }),
      ],
      [
        'an Agent',
        (): Partial<SharedContainerCapabilityPackageAnalysisDependencies> => ({
          getAgentModel: () => Promise.reject(new Error('EIO')),
        }),
      ],
    ])(
      'fails when %s cannot be read rather than omitting it',
      async (_label, overrides) => {
        const f = fixture();
        await reviewed(f);
        const deps = dependencies(f, overrides());
        await expect(
          analyzeSharedContainerCapabilityPackage(input(), deps),
        ).resolves.toEqual({ state: 'failed', reason: 'sources_unreadable' });
        expect(deps.analyze).not.toHaveBeenCalled();
      },
    );

    it('still omits a definition that is genuinely gone', async () => {
      const f = fixture();
      await reviewed(f);
      f.userPipelines.clear();
      const result = ready(
        await analyzeSharedContainerCapabilityPackage(input(), dependencies(f)),
      );
      expect(resourceNames(result)).toEqual(['helper']);
      expect(result.diagnostics.definitionsOmitted).toBe(1);
    });
  });

  it('reports failure distinctly from an empty package and observes cancellation', async () => {
    const f = fixture();
    await expect(
      analyzeSharedContainerCapabilityPackage(
        input(),
        dependencies(f, {
          collectUsage: () => Promise.reject(new Error('unreadable')),
        }),
      ),
    ).resolves.toEqual({ state: 'failed', reason: 'analysis_error' });
    await expect(
      analyzeSharedContainerCapabilityPackage(input(), dependencies(f)),
    ).resolves.toMatchObject({ state: 'empty' });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      analyzeSharedContainerCapabilityPackage(
        input({ signal: controller.signal }),
        dependencies(f),
      ),
    ).rejects.toThrow('cancelled');
  });

  it('reuses a completed analysis until a source file changes', async () => {
    const f = fixture();
    await addSkill(f, 'alpha');
    f.references.push(
      reference(
        { kind: 'skill', sourceId: 'custom:app', skillName: 'alpha' },
        'skill:alpha',
      ),
    );
    const deps = dependencies(f);
    const first = ready(
      await analyzeSharedContainerCapabilityPackage(input(), deps),
    );
    const calls = deps.analyze.mock.calls.length;
    const second = ready(
      await analyzeSharedContainerCapabilityPackage(input(), deps, {
        previous: first,
      }),
    );
    expect(deps.analyze.mock.calls.length).toBe(calls);
    expect(second.diagnostics.reused).toBe(true);
    expect(second.summary.digest).toBe(first.summary.digest);
    await writeFile(
      path.join(root, 'skills', 'custom-app', 'alpha', 'SKILL.md'),
      '# alpha, edited\n',
    );
    const third = ready(
      await analyzeSharedContainerCapabilityPackage(input(), deps, {
        previous: second,
      }),
    );
    expect(deps.analyze.mock.calls.length).toBeGreaterThan(calls);
    expect(third.summary.digest).not.toBe(first.summary.digest);
  });
});

// ---------------------------------------------------------------------------
// Publish preparation
// ---------------------------------------------------------------------------

type CommitUpload =
  SharedContainerCapabilityPackagePreparationDependencies['commitUpload'];

function preparationDependencies(
  f: Fixture,
  overrides: Partial<SharedContainerCapabilityPackagePreparationDependencies> = {},
): SharedContainerCapabilityPackagePreparationDependencies & {
  commitUpload: jest.MockedFunction<CommitUpload>;
} {
  const analysisDeps = dependencies(f);
  const commitUpload = jest.fn<
    ReturnType<CommitUpload>,
    Parameters<CommitUpload>
  >(async (manifest, readBlob, _getWindow, beforeCommit) => {
    for (const resource of manifest.resources)
      for (const tree of resource.trees)
        for (const entry of tree.entries) await readBlob(entry.sha256);
    await beforeCommit?.();
    return {
      uploadId: 'package-upload-1',
      packageRef: {
        version: 1,
        digest: computePipelinePackageDigestSync(manifest),
      },
    };
  });
  return {
    analyze: (analysisInput, options) =>
      analyzeSharedContainerCapabilityPackage(
        analysisInput,
        analysisDeps,
        options,
      ),
    cache: new SharedContainerCapabilityPackageAnalysisCache(),
    readScopeKey: () => Promise.resolve('scope-1'),
    isStale: () => Promise.resolve(false),
    listTrackedPaths: () => Promise.resolve([]),
    now: () => 1_000,
    backgroundTimeoutMs: 60_000,
    ...overrides,
    commitUpload: overrides.commitUpload
      ? jest.fn(overrides.commitUpload)
      : commitUpload,
  };
}

async function alphaFixture(): Promise<Fixture> {
  const f = fixture();
  await addSkill(f, 'alpha');
  f.references.push(
    reference(
      { kind: 'skill', sourceId: 'custom:app', skillName: 'alpha' },
      'skill:alpha',
    ),
  );
  return f;
}

function prepareInput(signal = new AbortController().signal): {
  projectId: string;
  worktreeId: string;
  containerType: 'COWORK_WORK_ENTRY';
  includedChatIds: string[];
  fileScope: { includedPaths: string[] };
  signal: AbortSignal;
} {
  return {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    containerType: 'COWORK_WORK_ENTRY',
    includedChatIds: ['chat-1'],
    fileScope: { includedPaths: [] },
    signal,
  };
}

describe('shared-container capability package preparation', () => {
  it('uploads the analyzed manifest unchanged and returns the prepared digest', async () => {
    const f = await alphaFixture();
    const deps = preparationDependencies(f);
    const prepared = await prepareSharedContainerCapabilityPackage(
      prepareInput(),
      deps,
    );
    if (prepared.state !== 'ready') throw new Error('expected ready');
    const cached = deps.cache.get({
      projectId: PROJECT,
      worktreeId: WORKTREE,
      containerType: 'COWORK_WORK_ENTRY',
    });
    expect(cached).toMatchObject({ scopeKey: 'scope-1', completedAt: 1_000 });
    const analysis = cached?.analysis;
    if (analysis?.state !== 'ready') throw new Error('expected cached ready');
    await expect(
      prepared.commit(new AbortController().signal),
    ).resolves.toEqual({
      capabilityPackage: { version: 1, digest: prepared.summary.digest },
      committedPackageUploadId: 'package-upload-1',
    });
    expect(deps.commitUpload.mock.calls[0]?.[0]).toEqual(analysis.manifest);
  });

  it('never starts or commits an upload after cancellation', async () => {
    const f = await alphaFixture();
    const deps = preparationDependencies(f);
    const prepared = await prepareSharedContainerCapabilityPackage(
      prepareInput(),
      deps,
    );
    if (prepared.state !== 'ready') throw new Error('expected ready');
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    await expect(prepared.commit(cancelled.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(deps.commitUpload).not.toHaveBeenCalled();
    const midway = new AbortController();
    const beforeCommit = jest.fn();
    deps.commitUpload.mockImplementationOnce(
      async (manifest, readBlob, _getWindow, before) => {
        midway.abort(new Error('cancelled midway'));
        const entry = manifest.resources[0]?.trees[0]?.entries[0];
        if (entry) await readBlob(entry.sha256);
        beforeCommit();
        await before?.();
        return { uploadId: 'late', packageRef: { version: 1, digest: 'x' } };
      },
    );
    await expect(prepared.commit(midway.signal)).rejects.toThrow(
      'cancelled midway',
    );
    expect(beforeCommit).not.toHaveBeenCalled();
  });

  it('keeps an authorization refusal visible through the upload stage wrapper', async () => {
    const f = await alphaFixture();
    const refusal = new CanopyCloudClientError('http-error', 'Forbidden', 403);
    const deps = preparationDependencies(f, {
      commitUpload: () =>
        Promise.reject(new ShareStageError('upload', refusal)),
    });
    const prepared = await prepareSharedContainerCapabilityPackage(
      prepareInput(),
      deps,
    );
    if (prepared.state !== 'ready') throw new Error('expected ready');
    const error: unknown = await prepared
      .commit(new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.cause : undefined).toBe(refusal);
  });

  it('refuses stale sources and a changed digest', async () => {
    const f = await alphaFixture();
    const stale = await prepareSharedContainerCapabilityPackage(
      prepareInput(),
      preparationDependencies(f, { isStale: () => Promise.resolve(true) }),
    );
    if (stale.state !== 'ready') throw new Error('expected ready');
    await expect(stale.commit(new AbortController().signal)).rejects.toThrow(
      'sources changed',
    );
    const changed = await prepareSharedContainerCapabilityPackage(
      prepareInput(),
      preparationDependencies(f, {
        commitUpload: () =>
          Promise.resolve({
            uploadId: 'other',
            packageRef: { version: 1, digest: `pp:v1:${'z'.repeat(43)}` },
          }),
      }),
    );
    if (changed.state !== 'ready') throw new Error('expected ready');
    await expect(changed.commit(new AbortController().signal)).rejects.toThrow(
      'digest changed',
    );
  });

  it('reports a failed analysis as failed without caching it', async () => {
    const deps = preparationDependencies(fixture(), {
      analyze: () => Promise.resolve({ state: 'failed', reason: 'test' }),
    });
    await expect(
      prepareSharedContainerCapabilityPackage(prepareInput(), deps),
    ).resolves.toEqual({ state: 'failed' });
    expect(
      deps.cache.get({
        projectId: PROJECT,
        worktreeId: WORKTREE,
        containerType: 'COWORK_WORK_ENTRY',
      }),
    ).toBeUndefined();
  });

  it('finishes an analysis the publication stopped waiting for, for recovery to reuse', async () => {
    let settle: (
      result: SharedContainerCapabilityPackageAnalysis,
    ) => void = () => undefined;
    const analyze = jest.fn<
      ReturnType<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >,
      Parameters<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >
    >(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const deps = preparationDependencies(fixture(), { analyze });
    const publication = new AbortController();
    const pending = prepareSharedContainerCapabilityPackage(
      prepareInput(publication.signal),
      deps,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const analysisSignal = analyze.mock.calls[0]?.[0].signal;
    publication.abort(new Error('package budget elapsed'));
    await expect(pending).rejects.toThrow('package budget elapsed');
    expect(analysisSignal?.aborted).toBe(false);
    const completed = completedAnalysis(COUNTS);
    settle(completed);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      deps.cache.get({
        projectId: PROJECT,
        worktreeId: WORKTREE,
        containerType: 'COWORK_WORK_ENTRY',
      })?.analysis,
    ).toBe(completed);
    analyze.mockImplementationOnce((_input, options) =>
      Promise.resolve(options.previous ?? { state: 'failed', reason: 'cold' }),
    );
    await expect(
      prepareSharedContainerCapabilityPackage(prepareInput(), deps),
    ).resolves.toMatchObject({ state: 'ready' });
    expect(analyze.mock.calls[1]?.[1].previous).toBe(completed);
  });

  it('shares one in-flight analysis across publication attempts', async () => {
    let settle: (
      result: SharedContainerCapabilityPackageAnalysis,
    ) => void = () => undefined;
    const analyze = jest.fn<
      ReturnType<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >,
      Parameters<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >
    >(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const deps = preparationDependencies(fixture(), { analyze });
    // The first attempt's package budget elapses while analysis runs.
    const first = new AbortController();
    const firstAttempt = prepareSharedContainerCapabilityPackage(
      prepareInput(first.signal),
      deps,
    );
    await new Promise((resolve) => setImmediate(resolve));
    first.abort(new Error('package budget elapsed'));
    await expect(firstAttempt).rejects.toThrow('package budget elapsed');
    // A retry with the same scope and inputs waits for the same analysis.
    const retry = prepareSharedContainerCapabilityPackage(prepareInput(), deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(analyze).toHaveBeenCalledTimes(1);
    settle(completedAnalysis(COUNTS));
    await expect(retry).resolves.toMatchObject({ state: 'ready' });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('does not share an analysis of different inputs', async () => {
    const analyze = jest.fn<
      ReturnType<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >,
      Parameters<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >
    >(() => Promise.resolve(completedAnalysis(COUNTS)));
    const deps = preparationDependencies(fixture(), { analyze });
    await Promise.all([
      prepareSharedContainerCapabilityPackage(prepareInput(), deps),
      prepareSharedContainerCapabilityPackage(
        { ...prepareInput(), includedChatIds: ['chat-2'] },
        deps,
      ),
    ]);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('derives code snapshot paths and included chats from the inventory', async () => {
    const listTrackedPaths = jest.fn<Promise<string[]>, [string]>(() =>
      Promise.resolve(['README.md', '.claude/commands/old.md']),
    );
    const repositories: CodePublishInventory['repositories'] = [
      {
        repoId: 'github',
        repoName: 'github',
        repoPath: '/repos/github',
        baseCommitSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        unpushedCommitCount: 0,
        fingerprint: 'f',
        approvedUntrackedPaths: [],
        files: [
          {
            path: '.claude/commands/old.md',
            status: 'deleted',
            mode: '100644',
            untracked: false,
          },
          {
            path: '.claude/skills/new/SKILL.md',
            status: 'added',
            mode: '100644',
            untracked: true,
          },
        ],
      },
      {
        repoId: 'snapshot',
        repoName: 'snapshot',
        repoPath: '/repos/snapshot',
        source: 'snapshot',
        snapshot: {
          baseCommitSha: 'd'.repeat(40),
          chunks: [],
          treeFileCount: 1,
          treeBytes: 1n,
          treeFileSizes: new Map([['pipelines/run.yaml', 1n]]),
          withheldPaths: [],
        },
        baseCommitSha: 'd'.repeat(40),
        headSha: 'd'.repeat(40),
        unpushedCommitCount: 0,
        fingerprint: 'g',
        approvedUntrackedPaths: [],
        files: [],
      },
    ];
    const snapshot = await sharedContainerSnapshotPathsFromCodeInventory(
      { repositories },
      new AbortController().signal,
      listTrackedPaths,
    );
    expect(listTrackedPaths).toHaveBeenCalledTimes(1);
    expect(listTrackedPaths).toHaveBeenCalledWith('/repos/github');
    expect(
      snapshot.repositories.map((repository) => ({
        repoId: repository.repoId,
        paths: Array.from(repository.paths).sort(),
      })),
    ).toEqual([
      {
        repoId: 'github',
        paths: ['.claude/skills/new/SKILL.md', 'README.md'],
      },
      { repoId: 'snapshot', paths: ['pipelines/run.yaml'] },
    ]);

    const analyze = jest.fn<
      ReturnType<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >,
      Parameters<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >
    >(() => Promise.resolve({ state: 'failed', reason: 'test' }));
    const deps = preparationDependencies(fixture(), {
      analyze,
      listTrackedPaths,
    });
    const chats: CodePublishInventory['chats'] = [
      { id: 'chat-a', title: 'A', createdAt: 'now', messages: [] },
      { id: 'chat-b', title: 'B', createdAt: 'now', messages: [] },
    ];
    await prepareCodeSharedContainerCapabilityPackage(
      {
        projectId: PROJECT,
        worktreeId: WORKTREE,
        inventory: {
          chats,
          attachments: [],
          notes: [],
          prompts: [],
          plans: [],
          repositories,
          withheldFileCount: 0,
          withheldFileReasons: [],
        },
        scope: { includedPaths: [] },
        signal: new AbortController().signal,
      },
      deps,
    );
    expect(analyze.mock.calls[0]?.[0]).toMatchObject({
      containerType: 'CODE_WORKTREE',
      includedChatIds: ['chat-a', 'chat-b'],
      repositories: [
        { repoId: 'github', repoPath: '/repos/github' },
        { repoId: 'snapshot', repoPath: '/repos/snapshot' },
      ],
    });
    const cowork: CoworkPublishInventory = {
      chats,
      attachments: [],
      notes: [],
      prompts: [],
      files: [],
    };
    await prepareCoworkSharedContainerCapabilityPackage(
      {
        projectId: PROJECT,
        worktreeId: WORKTREE,
        inventory: cowork,
        scope: { includedPaths: [] },
        signal: new AbortController().signal,
      },
      deps,
    );
    const coworkInput = analyze.mock.calls[1]?.[0];
    expect(coworkInput).toMatchObject({
      containerType: 'COWORK_WORK_ENTRY',
      includedChatIds: ['chat-a', 'chat-b'],
    });
    expect(coworkInput).not.toHaveProperty('snapshotPaths');
  });
});

// ---------------------------------------------------------------------------
// Publication through the real pipeline
// ---------------------------------------------------------------------------

type Stage =
  PublishSharedContainerRevisionDependencies<CoworkPublishInventory>['stage'];

describe('shared-container capability package publication', () => {
  function publisher(f: Fixture): {
    target: {
      projectId: string;
      worktreeId: string;
      containerId: string;
      containerType: 'COWORK_WORK_ENTRY';
    };
    deps: PublishSharedContainerRevisionDependencies<CoworkPublishInventory>;
    stage: jest.MockedFunction<Stage>;
    prep: ReturnType<typeof preparationDependencies>;
    record(): SharedContainerPublicationRecord | null;
  } {
    const target = {
      projectId: PROJECT,
      worktreeId: WORKTREE,
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY' as const,
    };
    let record: SharedContainerPublicationRecord | null = null;
    const store = publicationState.getSharedContainerPublicationStateStore();
    jest.spyOn(store, 'get').mockImplementation(() => Promise.resolve(record));
    jest.spyOn(store, 'set').mockImplementation((next) => {
      record = next;
      return Promise.resolve(next);
    });
    let lastRequest: SharedContainerStageRevisionRequest | undefined;
    let staged = 0;
    const stage = jest.fn<ReturnType<Stage>, Parameters<Stage>>(
      (_id, request) => {
        lastRequest = request;
        staged += 1;
        return Promise.resolve({
          stagingSessionId: request.idempotencyKey,
          revisionId: `revision-${String(staged)}`,
          uploadTargets: [],
        });
      },
    );
    const prep = preparationDependencies(f);
    const deps: PublishSharedContainerRevisionDependencies<CoworkPublishInventory> =
      {
        buildInventory: () =>
          Promise.resolve({
            chats: [],
            attachments: [],
            notes: [],
            prompts: [],
            files: [],
          }),
        buildArtifacts: () => [],
        validateArtifacts: (
          _artifacts,
          _organization,
          sourceDeviceId,
          idempotencyKey,
          parentRevisionId,
        ) => ({
          artifacts: [],
          schemaVersion: 4,
          sourceDeviceId,
          idempotencyKey,
          ...(parentRevisionId ? { parentRevisionId } : {}),
        }),
        readScope: () => Promise.resolve({ includedPaths: [] }),
        readDeviceId: () => Promise.resolve('device-1'),
        stage,
        upload: () => Promise.resolve(),
        commit: () => {
          const digest = lastRequest?.capabilityPackage?.digest;
          return Promise.resolve({
            revision: {
              id: `revision-${String(staged)}`,
              revision: staged,
              schemaVersion: 4,
              sourceDeviceId: 'device-1',
              artifactObjectKey: 'artifact-object-key',
              artifactHash: 'artifact-hash',
              artifactSizeBytes: '0',
              createdAt: '2026-10-22T00:00:00.000Z',
              ...(digest
                ? {
                    package: {
                      digest,
                      counts: {
                        skills: 1,
                        pipelines: 0,
                        agents: 0,
                        automations: 0,
                        hooks: 0,
                      },
                      executableFiles: [],
                    },
                  }
                : {}),
            },
          });
        },
        prepareCapabilityPackage: (prepareArgs) =>
          prepareCoworkSharedContainerCapabilityPackage(prepareArgs, prep),
      };
    return {
      target,
      deps,
      stage,
      prep,
      record: (): SharedContainerPublicationRecord | null => record,
    };
  }

  it('publishes package-only changes, uploads nothing when unchanged and reuses the analysis', async () => {
    const f = await alphaFixture();
    const h = publisher(f);
    await publishSharedContainerRevision(h.target, h.deps);
    const firstDigest = h.record()?.publishedPackageDigest;
    expect(firstDigest).toMatch(/^pp:v1:/);
    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.prep.commitUpload).toHaveBeenCalledTimes(1);

    await publishSharedContainerRevision(h.target, h.deps);
    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.prep.commitUpload).toHaveBeenCalledTimes(1);

    // Same artifacts, edited skill: only the package changed.
    await writeFile(
      path.join(root, 'skills', 'custom-app', 'alpha', 'SKILL.md'),
      '# alpha, edited\n',
    );
    await publishSharedContainerRevision(h.target, h.deps);
    expect(h.stage).toHaveBeenCalledTimes(2);
    expect(h.prep.commitUpload).toHaveBeenCalledTimes(2);
    expect(h.record()?.publishedPackageDigest).not.toBe(firstDigest);
    expect(h.stage.mock.calls[1]?.[1]).toMatchObject({
      capabilityPackage: { digest: h.record()?.publishedPackageDigest },
    });
  });

  it('publishes without a package when analysis fails and recovers later', async () => {
    const f = await alphaFixture();
    const h = publisher(f);
    const failing = preparationDependencies(f, {
      analyze: () => Promise.resolve({ state: 'failed', reason: 'test' }),
    });
    await expect(
      publishSharedContainerRevision(h.target, {
        ...h.deps,
        prepareCapabilityPackage: (prepareArgs) =>
          prepareCoworkSharedContainerCapabilityPackage(prepareArgs, failing),
      }),
    ).resolves.toMatchObject({
      status: 'published',
      packageRecoveryPending: true,
    });
    expect(h.stage.mock.calls[0]?.[1]).not.toHaveProperty('capabilityPackage');
    await expect(
      publishSharedContainerRevision(h.target, h.deps),
    ).resolves.not.toHaveProperty('packageRecoveryPending');
    expect(h.record()?.publishedPackageDigest).toMatch(/^pp:v1:/);
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const COUNTS: SharedContainerCapabilityPackageCounts = {
  skills: 2,
  pipelines: 1,
  agents: 0,
  automations: 0,
  hooks: 0,
};

function completedAnalysis(
  counts: SharedContainerCapabilityPackageCounts,
): CompletedSharedContainerCapabilityPackageAnalysis {
  const manifest = {
    version: 1 as const,
    pipelineContentHash: 'a'.repeat(64),
    resources: [],
    bindings: [],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  };
  return {
    state: 'ready',
    contentKey: 'content-1',
    summary: { digest: `pp:v1:${'a'.repeat(43)}`, counts, executableFiles: [] },
    manifest,
    analysis: {
      summary: {
        analysisId: 'analysis-1',
        state: 'ready',
        pipelineContentHash: manifest.pipelineContentHash,
        manifest,
        blockers: [],
        expiresAt: new Date(0).toISOString(),
      },
      optionalBindings: [],
      blobs: new Map(),
      sourceStats: [],
      sourceDirectories: [],
    },
    observedSources: { sourceStats: [], sourceDirectories: [] },
    diagnostics: {
      references: 0,
      unresolved: 0,
      ambiguous: 0,
      unpackageable: 0,
      definitionsOmitted: 0,
      dependentsOmitted: 0,
      blockedOmitted: 0,
      prunedForCaps: 0,
      mcpRequirementsOmitted: 0,
      hooksSkipped: 0,
      sourcesUnreadable: 0,
      analyses: 1,
      reused: false,
    },
  };
}

function chatTabs(revision: number): ChatTabsFile {
  return {
    version: 1,
    activeTabId: 'chat-1',
    tabs: [
      {
        id: 'chat-1',
        title: 'Chat',
        createdAt: 'now',
        messages: [
          {
            id: `message-${String(revision)}`,
            role: 'user',
            timestamp: revision,
            blocks: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    ],
  };
}

describe('shared-container capability package preview', () => {
  function refresherHarness(): {
    refresher: SharedContainerCapabilityPackagePreviewRefresher;
    deps: SharedContainerCapabilityPackagePreviewDependencies;
    analyze: jest.MockedFunction<
      SharedContainerCapabilityPackagePreviewDependencies['analyze']
    >;
    setTabs(next: ChatTabsFile): void;
    settle(result: SharedContainerCapabilityPackageAnalysis): void;
  } {
    let tabs = chatTabs(1);
    const pending: Array<
      (result: SharedContainerCapabilityPackageAnalysis) => void
    > = [];
    const analyze = jest.fn<
      ReturnType<
        SharedContainerCapabilityPackagePreviewDependencies['analyze']
      >,
      Parameters<SharedContainerCapabilityPackagePreviewDependencies['analyze']>
    >(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const deps: SharedContainerCapabilityPackagePreviewDependencies = {
      cache: new SharedContainerCapabilityPackageAnalysisCache(),
      readChatTabs: () => Promise.resolve(tabs),
      listRepositories: () =>
        Promise.resolve([
          {
            repoId: 'repo-1',
            repoName: 'repo',
            repoPath: '/repos/one',
            relativePrefix: '',
          },
        ]),
      listTrackedPaths: () => Promise.resolve(['README.md']),
      analyze,
      now: () => 5_000,
      timeoutMs: 60_000,
    };
    return {
      refresher: new SharedContainerCapabilityPackagePreviewRefresher(deps),
      deps,
      analyze,
      setTabs: (next): void => {
        tabs = next;
      },
      settle: (result): void => {
        for (const resolve of pending.splice(0)) resolve(result);
      },
    };
  }

  const request = {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    containerType: 'CODE_WORKTREE' as const,
  };

  it('shows no counts while cold, refreshes once in the background, then shows warm counts', async () => {
    const h = refresherHarness();
    // Neither call waits for the background analysis.
    await expect(
      h.refresher.readCounts(request, { includedPaths: [] }),
    ).resolves.toBeUndefined();
    await expect(
      h.refresher.readCounts(request, { includedPaths: [] }),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.analyze).toHaveBeenCalledTimes(1);
    expect(h.analyze.mock.calls[0]?.[0]).toMatchObject({
      containerType: 'CODE_WORKTREE',
      includedChatIds: ['chat-1'],
      snapshotPaths: {
        repositories: [
          { repoId: 'repo-1', repoPath: '/repos/one', paths: ['README.md'] },
        ],
      },
    });
    h.settle(completedAnalysis(COUNTS));
    await h.refresher.whenIdle();
    await expect(
      h.refresher.readCounts(request, { includedPaths: [] }),
    ).resolves.toEqual(COUNTS);
    expect(h.analyze).toHaveBeenCalledTimes(1);
  });

  it('shows no counts for a changed scope and cancels the superseded refresh', async () => {
    const h = refresherHarness();
    await h.refresher.readCounts(request, { includedPaths: [] });
    await new Promise((resolve) => setImmediate(resolve));
    h.settle(completedAnalysis(COUNTS));
    await h.refresher.whenIdle();
    h.setTabs(chatTabs(2));
    await expect(
      h.refresher.readCounts(request, { includedPaths: [] }),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    const superseded = h.analyze.mock.calls[1]?.[0].signal;
    await expect(
      h.refresher.readCounts(request, { includedPaths: ['notes.md'] }),
    ).resolves.toBeUndefined();
    expect(superseded?.aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    h.settle(completedAnalysis({ ...COUNTS, hooks: 1 }));
    await h.refresher.whenIdle();
    await expect(
      h.refresher.readCounts(request, { includedPaths: ['notes.md'] }),
    ).resolves.toEqual({ ...COUNTS, hooks: 1 });
  });

  it('leaves counts absent when the background analysis fails', async () => {
    const h = refresherHarness();
    await h.refresher.readCounts(request, { includedPaths: [] });
    await new Promise((resolve) => setImmediate(resolve));
    h.settle({ state: 'failed', reason: 'test' });
    await h.refresher.whenIdle();
    expect(h.deps.cache.get(request)).toBeUndefined();
  });

  it('lets publication join an in-flight preview analysis of the same scope', async () => {
    const h = refresherHarness();
    const cowork = { ...request, containerType: 'COWORK_WORK_ENTRY' as const };
    await h.refresher.readCounts(cowork, { includedPaths: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.analyze).toHaveBeenCalledTimes(1);
    const publicationAnalyze = jest.fn<
      ReturnType<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >,
      Parameters<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >
    >(() => Promise.resolve({ state: 'failed', reason: 'not shared' }));
    const prepared = prepareSharedContainerCapabilityPackage(
      prepareInput(),
      preparationDependencies(fixture(), {
        analyze: publicationAnalyze,
        cache: h.deps.cache,
        readScopeKey: () =>
          Promise.resolve(
            sharedContainerCapabilityPackageScopeKey({
              containerType: 'COWORK_WORK_ENTRY',
              chatTabs: chatTabs(1),
              fileScope: { includedPaths: [] },
            }),
          ),
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // A scope change cancels the preview's wait, not the analysis publication
    // also waits for.
    const shared = h.analyze.mock.calls[0]?.[0].signal;
    h.setTabs(chatTabs(2));
    await h.refresher.readCounts(cowork, { includedPaths: [] });
    expect(shared?.aborted).toBe(false);
    h.settle(completedAnalysis(COUNTS));
    await expect(prepared).resolves.toMatchObject({ state: 'ready' });
    expect(publicationAnalyze).not.toHaveBeenCalled();
    h.refresher.cancelAll();
    await h.refresher.whenIdle();
  });

  it('hands the preview analysis to publication for reuse', async () => {
    const h = refresherHarness();
    await h.refresher.readCounts(
      { ...request, containerType: 'COWORK_WORK_ENTRY' },
      { includedPaths: [] },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const completed = completedAnalysis(COUNTS);
    h.settle(completed);
    await h.refresher.whenIdle();
    const analyze = jest.fn<
      ReturnType<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >,
      Parameters<
        SharedContainerCapabilityPackagePreparationDependencies['analyze']
      >
    >((_input, options) =>
      Promise.resolve(options.previous ?? { state: 'failed', reason: 'cold' }),
    );
    const prepared = await prepareSharedContainerCapabilityPackage(
      prepareInput(),
      preparationDependencies(fixture(), { analyze, cache: h.deps.cache }),
    );
    expect(analyze.mock.calls[0]?.[1].previous).toBe(completed);
    expect(prepared).toMatchObject({
      state: 'ready',
      summary: completed.state === 'ready' ? completed.summary : undefined,
    });
  });
});
