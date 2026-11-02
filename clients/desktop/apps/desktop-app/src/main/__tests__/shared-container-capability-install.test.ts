// CAN-4655 (plan §6): installing a fork's capability package. The package is
// produced by the real definition builders and package analyzer; transport,
// stores and the skill materializer are in-memory fakes that keep the same
// contracts (verified blobs, finalization inside the materializer's rollback
// boundary, the install ledger written last).
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeCapabilityPackage,
  assertValidPipelinePackage,
  computePipelinePackageDigestSync,
  filterPipelinePackageOverlayForStep,
  getProjectActionsDirCandidates,
  hashPipelinePackageYaml,
  installPipelinePackageAtomically,
  loadPipelinePackageExecutionOverlay,
  resolveChildPipeline,
  snapshotPipelinePackageForExecution,
} from '@canopy/desktop-shared/node';
import { resolveActionRuntime } from '@canopy/desktop-shared/node/pipelines/action-resolver';
import { resolvePlugins as resolvePipelineStepPlugins } from '@canopy/desktop-shared/node/plugins/plugin-resolver';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type {
  AutomationCreateRequest,
  ChatTabPluginSelections,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type {
  CapabilityPackageInstallRecordV1,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import type { InvocableInventoryCache } from '@canopy/desktop-shared/types/invocable-inventory';
import {
  encodeSharedContainerDefinitionDocument,
  parseSharedContainerDefinitionDocument,
  type SharedContainerForkRequest,
  type SharedContainerForkResponse,
} from '@canopy/protocol/shared-containers';
import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import {
  buildPortablePipelineResources,
  capabilityInventoryEntryIdsByKey,
} from '../pipelines/pipeline-package-service';
import {
  buildAgentDefinitionResource,
  buildAutomationDefinitionResource,
  buildHookDefinitionResource,
  buildPipelineDefinitionResource,
  toCapabilityPackageDefinitionResourceInput,
  type SharedContainerDefinitionBuildResult,
  type SharedContainerDefinitionBuilderDependencies,
  type SharedContainerDefinitionResourceDraft,
} from '../shared-containers/capability-package/definitions';
import {
  CANCELLED_PACKAGE_WARNING,
  CHANGED_PACKAGE_WARNING,
  defaultForkCapabilityInstallDependencies,
  FAILED_PACKAGE_WARNING,
  forkCapabilityInstallOwner,
  HOOKS_OMITTED_WARNING,
  installForkCapabilityPackage,
  INVALID_PACKAGE_WARNING,
  recoverForkCapabilityInstalls,
  residualWarning,
  TIMED_OUT_PACKAGE_WARNING,
  UNAVAILABLE_PACKAGE_WARNING,
  UNDISCLOSED_PACKAGE_WARNING,
  type ForkCapabilityInstallDependencies,
} from '../shared-containers/capability-package/install';
import {
  deleteForkCapabilityInstallJournal,
  forkCapabilityInstallJournalKey,
  listForkCapabilityInstallJournals,
  readForkCapabilityInstallJournal,
  writeForkCapabilityInstallJournal,
  type ForkCapabilityInstallJournal,
} from '../shared-containers/capability-package/install-journal';
import {
  deriveInstalledPipelineManifest,
  rewriteAgentModelIds,
  rewriteSkillInvocations,
  rewriteSkillInvocationsInPrompt,
  skillInvocationRenames,
} from '../shared-containers/capability-package/install-plan';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
} from '../lib/workspace-script-hook-settings';

let mockJournalDir = '';
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<Record<string, unknown>>('../lib/paths'),
  getSharedContainerCapabilityInstallJournalDir: (): string => mockJournalDir,
}));
// The pinned package routes, reached only through the default dependencies.
const mockGetRevisionPackage = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../shared-containers/canopy-server-client', () => ({
  getSharedContainerRevisionPackage: (...args: unknown[]): Promise<unknown> =>
    mockGetRevisionPackage(...args),
}));
// Hooks are workspace configuration: the installer must never reach either
// hook boundary. Mocked so any call would be observed.
jest.mock('../lib/workspace-script-hook-settings', () => ({
  updateWorkspaceHooks: jest.fn(),
  setWorktreeHooksPaused: jest.fn(),
}));

// ---------------------------------------------------------------------------
// A real container package
// ---------------------------------------------------------------------------

const PIPELINE_YAML = [
  'name: Review',
  'on: dispatch',
  'jobs:',
  '  review:',
  '    steps:',
  '      - id: loop',
  '        uses: builtin/agent-prompt',
  '        with:',
  '          prompt: Run /helper on the diff.',
  '          model: agent_model_reviewer',
  '      - id: nested',
  '        uses: builtin/run-pipeline',
  '        with:',
  '          pipeline: child.yaml',
  '',
].join('\n');

const EMPTY_INVENTORY: InvocableInventoryCache = {
  version: 5,
  builtAt: new Date(0).toISOString(),
  entries: [],
};

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

function builderDependencies(): SharedContainerDefinitionBuilderDependencies {
  return {
    loadInventory: () =>
      Promise.resolve({ inventory: EMPTY_INVENTORY, sources: {} }),
    buildPortablePipelineResources,
    capabilityInventoryEntryIdsByKey,
    mapPluginSelectionsToPortable: () =>
      Promise.resolve({ refs: [], mcpServers: [], unresolved: [] }),
    resolveEffectivePluginSelectionRefs: (value) =>
      Promise.resolve({
        disabledRefs: [],
        skillRefs: value.skillRefs,
        pluginRefs: value.pluginRefs,
        mcpServerRefs: value.mcpServerRefs ?? [],
        warnings: [],
      }),
    mcpSelectionToEnvironmentRequirement: (selection) =>
      Promise.resolve({
        id: `mcp:${selection.serverId}`,
        kind: 'mcp',
        displayName: selection.serverId,
        required: false,
        affectedSteps: [],
        setupHint: 'Set up this server.',
      }),
  };
}

function activity(
  id: string,
  name: string,
  action: ScheduledActivity['action'],
): ScheduledActivity {
  return {
    version: 1,
    id,
    name,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    failureCount: 0,
  };
}

function built(
  result: SharedContainerDefinitionBuildResult,
): SharedContainerDefinitionResourceDraft {
  if (!result.resource)
    throw new Error(`Expected a resource, got ${result.reason}`);
  return result.resource;
}

interface ContainerPackage {
  digest: string;
  manifest: PipelinePackageManifestV1;
  blobs: Map<string, Uint8Array>;
  ids: {
    pipeline: string;
    agent: string;
    pipelineAutomation: string;
    promptAutomation: string;
    coworkAutomation: string;
    hook: string;
    skill: string;
    child: string;
  };
}

async function buildContainerPackage(
  root: string,
  options: { includeHook?: boolean } = {},
): Promise<ContainerPackage> {
  const skillsRoot = path.join(root, 'skills');
  await mkdir(path.join(skillsRoot, 'helper'), { recursive: true });
  await writeFile(path.join(skillsRoot, 'helper', 'SKILL.md'), '# Helper\n');
  await writeFile(
    path.join(root, 'child.yaml'),
    'name: Child\non: dispatch\njobs: {}\n',
  );
  const deps = builderDependencies();
  const pipeline = built(
    await buildPipelineDefinitionResource(
      {
        pipeline: { id: 'pipeline-local-1', source: 'user', name: 'Review' },
        rawYaml: PIPELINE_YAML,
        pipelineFileDir: root,
      },
      deps,
    ),
  );
  const agentModel: AgentModelDefinition = {
    id: 'agent_model_reviewer',
    name: 'Reviewer',
    baseModel: 'sonnet',
    instructions: 'Review with /helper before replying.',
    pluginSelections: selections(),
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
  const agent = built(
    await buildAgentDefinitionResource({ agent: agentModel }, deps),
  );
  const pipelineAutomation = built(
    await buildAutomationDefinitionResource(
      {
        activity: activity('activity-pipeline', 'Nightly review', {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-local-1',
          baseWorktreeId: 'worktree-local-1',
          pipelineId: 'pipeline-local-1',
          pipelineSource: 'user',
          pipelineName: 'Review',
        }),
        containerType: 'code',
        pipelineYaml: PIPELINE_YAML,
      },
      deps,
    ),
  );
  const promptAutomation = built(
    await buildAutomationDefinitionResource(
      {
        activity: activity('activity-prompt', 'Morning triage', {
          type: 'worktree_prompt',
          workspaceId: 'workspace-local-1',
          existingWorktreeId: 'worktree-local-1',
          prompt: 'Triage with /helper.',
          model: 'agent_model_reviewer',
          pluginSelections: selections({
            skillRefs: [{ sourceId: 'custom:app', skillName: 'helper' }],
          }),
        }),
        containerType: 'code',
      },
      deps,
    ),
  );
  const coworkAutomation = built(
    await buildAutomationDefinitionResource(
      {
        activity: activity('activity-cowork', 'Weekly summary', {
          type: 'worktree_session_prompt',
          workspaceId: 'cowork-local-1',
          worktreeId: 'entry-local-1',
          chatId: 'chat-local-1',
          prompt: 'Summarize with /helper.',
          pluginSelections: selections({
            skillRefs: [{ sourceId: 'custom:app', skillName: 'helper' }],
          }),
        }),
        containerType: 'cowork',
      },
      deps,
    ),
  );
  const hook = built(
    await buildHookDefinitionResource(
      {
        hook: {
          triggerName: 'pr:create',
          target: 'project',
          actions: [{ type: 'command', command: 'echo opened' }],
        },
      },
      deps,
    ),
  );
  const analysis = await analyzeCapabilityPackage({
    rawContent: '{"container":"example"}',
    requests: [],
    invocableInventory: {
      ...EMPTY_INVENTORY,
      entries: [
        {
          id: 'helper-claude',
          provider: 'claude',
          kind: 'skill',
          name: 'helper',
          displayName: 'helper',
          description: '',
          insertText: '/helper ',
          invocationKey: '/helper',
          enableRef: {
            kind: 'skill',
            sourceId: 'custom:app',
            skillName: 'helper',
          },
        },
        {
          id: 'helper-codex',
          provider: 'codex',
          kind: 'skill',
          name: 'helper',
          displayName: 'helper',
          description: '',
          insertText: '$helper ',
          invocationKey: '$helper',
          enableRef: {
            kind: 'skill',
            sourceId: 'custom:app',
            skillName: 'helper',
          },
        },
      ],
    },
    sourceByInventoryEntryId: {
      'helper-claude': {
        sourceRoot: skillsRoot,
        memberPath: 'helper',
        sourceVisibility: 'local',
        runtimeKind: 'standalone_skill',
        rootName: 'helper',
      },
      'helper-codex': {
        sourceRoot: skillsRoot,
        memberPath: 'helper',
        sourceVisibility: 'local',
        runtimeKind: 'standalone_skill',
        rootName: 'helper',
      },
    },
    definitionResources: [
      pipeline,
      agent,
      pipelineAutomation,
      promptAutomation,
      coworkAutomation,
      ...(options.includeHook === false ? [] : [hook]),
    ].map((resource) => toCapabilityPackageDefinitionResourceInput(resource)),
  });
  expect(analysis.summary.blockers).toEqual([]);
  const manifest = analysis.summary.manifest;
  if (!manifest) throw new Error('missing manifest');
  const skill = manifest.resources.find(
    (resource) => resource.kind === 'standalone_skill',
  );
  const child = manifest.resources.find(
    (resource) => resource.kind === 'child_pipeline',
  );
  if (!skill || !child) throw new Error('package lacks its skill or child');
  return {
    digest: computePipelinePackageDigestSync(manifest),
    manifest,
    blobs: analysis.blobs,
    ids: {
      pipeline: pipeline.resourceId,
      agent: agent.resourceId,
      pipelineAutomation: pipelineAutomation.resourceId,
      promptAutomation: promptAutomation.resourceId,
      coworkAutomation: coworkAutomation.resourceId,
      hook: hook.resourceId,
      skill: skill.id,
      child: child.id,
    },
  };
}

/** Re-digest a manifest after a test edits one of its documents. */
function withDocument(
  pkg: ContainerPackage,
  resourceId: string,
  bytes: Uint8Array,
): ContainerPackage {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest: PipelinePackageManifestV1 = {
    ...pkg.manifest,
    resources: pkg.manifest.resources.map(
      (resource): PipelinePackageResource =>
        resource.id !== resourceId
          ? resource
          : {
              ...resource,
              trees: resource.trees.map((tree) => ({
                ...tree,
                entries: tree.entries.map((entry) => ({
                  ...entry,
                  sha256,
                  size: bytes.byteLength,
                })),
              })),
            },
    ),
  };
  const blobs = new Map(pkg.blobs);
  blobs.set(sha256, bytes);
  return {
    ...pkg,
    manifest,
    blobs,
    digest: computePipelinePackageDigestSync(manifest),
  };
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type FailurePoint =
  | 'agent'
  | 'pipeline'
  | 'automation'
  | 'defaults'
  | 'ledger'
  | 'materialize';

interface World {
  pkg: ContainerPackage;
  replicaPackage?: { digest: string };
  agents: AgentModelDefinition[];
  pipelines: Map<
    string,
    {
      name: string;
      raw: string;
      hash: string;
      overlay?: { digest: string; manifest: PipelinePackageManifestV1 };
    }
  >;
  existingPipelineNames: string[];
  automations: ScheduledActivity[];
  automationRequests: AutomationCreateRequest[];
  defaults: Map<string, Array<{ sourceId: string; skillName: string }>>;
  ledger: Map<string, CapabilityPackageInstallRecordV1>;
  journals: Map<string, ForkCapabilityInstallJournal>;
  /** Local skill folder name -> SKILL.md hash ('user' for the recipient's own). */
  skills: Map<string, string>;
  failAt?: FailurePoint;
  /** Runs after the given object is created, before the attempt continues. */
  afterCreate?: (kind: 'agent' | 'pipeline' | 'automation') => void;
  getPackageCalls: Array<{ revisionId: string; digest: string }>;
  tamperedBlob?: string;
  getPackageError?: Error;
  getPackageHangs?: boolean;
  /** Thrown by the materializer after its blobs verified. */
  materializeError?: Error;
  /** Every journal write, in order. */
  journalHistory: ForkCapabilityInstallJournal[];
  /** Local pipeline ids passed to `removePipeline`, in order. */
  removePipelineCalls: string[];
  /** Held before a `removePipeline` call for this id resolves. */
  removePipelineGate?: {
    localId: string;
    calls: 'first' | 'all';
    release: Promise<void>;
  };
}

function contentHashOf(
  agent: Omit<AgentModelDefinition, 'contentHash'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        agent.id,
        agent.name,
        agent.baseModel,
        agent.instructions,
        agent.pluginSelections,
      ]),
    )
    .digest('hex');
}

function newWorld(pkg: ContainerPackage): World {
  return {
    pkg,
    agents: [],
    pipelines: new Map(),
    existingPipelineNames: [],
    automations: [],
    automationRequests: [],
    defaults: new Map(),
    ledger: new Map(),
    journals: new Map(),
    skills: new Map(),
    getPackageCalls: [],
    journalHistory: [],
    removePipelineCalls: [],
  };
}

interface Gate {
  release: () => void;
  released: Promise<void>;
}

function gate(): Gate {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released };
}

/** Let every pending microtask and immediate run. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

let clock = 0;
function tick(): string {
  clock += 1000;
  return new Date(Date.UTC(2026, 9, 22, 0, 0, 0) + clock).toISOString();
}

function ownerKey(owner: { kind: string; localId?: string }): string {
  return `${owner.kind}:${owner.localId ?? ''}`;
}

function depsFor(
  world: World,
  overrides: Partial<ForkCapabilityInstallDependencies> = {},
): ForkCapabilityInstallDependencies {
  let ids = 0;
  const base: ForkCapabilityInstallDependencies = {
    timeoutMs: 5_000,
    now: () => new Date(tick()),
    randomId: () => `local-pipeline-${(ids += 1)}`,
    log: () => undefined,
    readReplicaPackage: () =>
      Promise.resolve(
        world.replicaPackage
          ? {
              digest: world.replicaPackage.digest,
              counts: {
                skills: 1,
                pipelines: 1,
                agents: 1,
                automations: 3,
                hooks: 1,
              },
              executableFiles: [],
            }
          : undefined,
      ),
    getPackage: (request, signal) => {
      world.getPackageCalls.push({
        revisionId: request.revisionId,
        digest: request.digest,
      });
      if (world.getPackageError) return Promise.reject(world.getPackageError);
      if (world.getPackageHangs)
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('aborted'),
            ),
          );
        });
      return Promise.resolve({
        digest: world.pkg.digest,
        manifest: world.pkg.manifest,
      });
    },
    getBlob: (_request, sha256) => {
      const bytes = world.pkg.blobs.get(sha256);
      if (!bytes) return Promise.reject(new Error(`missing blob ${sha256}`));
      if (sha256 === world.tamperedBlob)
        return Promise.resolve(new TextEncoder().encode('tampered'));
      return Promise.resolve(bytes);
    },
    installSubjectPackage: async (request) => {
      if (request.download.digest !== request.packageRef.digest)
        throw new Error('The capability package changed.');
      // The real materializer verifies every blob into the cache first.
      for (const resource of request.download.manifest.resources) {
        for (const tree of resource.trees) {
          for (const entry of tree.entries) {
            const bytes = await request.fetchBlob(entry.sha256);
            if (
              createHash('sha256').update(bytes).digest('hex') !== entry.sha256
            )
              throw new Error(
                `Pipeline package blob ${entry.sha256} failed verification`,
              );
          }
        }
      }
      if (world.failAt === 'materialize') throw new Error('disk full');
      if (world.materializeError) throw world.materializeError;
      const created: string[] = [];
      const installedSkills: Array<{
        name: string;
        localName: string;
        resourceId: string;
      }> = [];
      const result = {
        supportingFileCount: 0,
        installedSkills,
        uninstalledResourceLabels: [],
        keptLocalFiles: [],
      };
      try {
        for (const resource of request.download.manifest.resources) {
          if (resource.kind !== 'standalone_skill') continue;
          const tree = resource.trees[0];
          const rootName = tree?.rootName ?? resource.id;
          const skillMd =
            tree?.entries.find((entry) => entry.path === 'SKILL.md')?.sha256 ??
            '';
          // Like the real materializer: a byte-identical SKILL.md (a provider
          // twin) reuses the folder; any other taken name gets a suffix.
          let localName = rootName;
          for (
            let suffix = 2;
            world.skills.has(localName) &&
            world.skills.get(localName) !== skillMd;
            suffix += 1
          )
            localName = `${rootName}-${suffix}`;
          const reused = world.skills.has(localName);
          if (!reused) created.push(localName);
          // The real materializer reports the folder once it is reserved and
          // before it writes into it.
          await request.onSkillFolderReserved?.({
            resourceId: resource.id,
            localName,
            created: !reused,
            files: (tree?.entries ?? []).map((entry) => ({
              path: entry.path,
              sha256: entry.sha256,
            })),
          });
          if (!reused) world.skills.set(localName, skillMd);
          installedSkills.push({
            name: rootName,
            localName,
            resourceId: resource.id,
          });
        }
        await request.finalizeInstall?.(result);
        if (world.failAt === 'ledger') throw new Error('ledger read-only');
        world.ledger.set(ownerKey(request.owner), {
          owner: request.owner,
          ...(request.originExternalId
            ? { originExternalId: request.originExternalId }
            : {}),
          pipelineContentHash: request.download.manifest.pipelineContentHash,
          packageDigest: request.download.digest,
          installedAt: tick(),
        });
      } catch (error) {
        await Promise.allSettled([
          Promise.resolve().then(() => request.rollbackFinalization?.()),
        ]);
        for (const name of created) world.skills.delete(name);
        throw error;
      }
      return result;
    },
    findLedgerInstall: (owner) =>
      Promise.resolve(world.ledger.get(ownerKey(owner)) ?? null),
    resolvePortablePlugins: () =>
      Promise.resolve({ selections: selections(), unmatched: [] }),
    listAgents: () =>
      Promise.resolve(world.agents.map((agent) => ({ ...agent }))),
    createAgent: (request) => {
      if (world.failAt === 'agent')
        return Promise.reject(new Error('agents file locked'));
      const key = request.name.trim().toLowerCase();
      if (world.agents.some((agent) => agent.name.toLowerCase() === key))
        return Promise.reject(
          new Error(`An Agent named "${request.name}" already exists.`),
        );
      const slug = request.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      let id = `agent_model_${slug}`;
      for (
        let suffix = 2;
        world.agents.some((agent) => agent.id === id);
        suffix += 1
      )
        id = `agent_model_${slug}_${suffix}`;
      const now = tick();
      const base = {
        id,
        name: request.name,
        baseModel: request.baseModel,
        instructions: request.instructions,
        pluginSelections: request.pluginSelections,
        createdAt: now,
        updatedAt: now,
      };
      const agent: AgentModelDefinition = {
        ...base,
        contentHash: contentHashOf(base),
      };
      world.agents.push(agent);
      world.afterCreate?.('agent');
      return Promise.resolve({ ...agent });
    },
    removeAgent: (id, contentHash) => {
      const agent = world.agents.find((candidate) => candidate.id === id);
      if (agent && contentHashOf(agent) === contentHash)
        world.agents = world.agents.filter((candidate) => candidate.id !== id);
      return Promise.resolve();
    },
    listPipelineNames: () =>
      Promise.resolve([
        ...world.existingPipelineNames,
        ...Array.from(world.pipelines.values()).map(
          (pipeline) => pipeline.name,
        ),
      ]),
    readBundledPipelineScopes: () => Promise.resolve(undefined),
    createPipeline: (input) => {
      if (world.failAt === 'pipeline')
        return Promise.reject(new Error('pipelines index locked'));
      parsePipelineText(input.rawPipeline);
      const hash = hashPipelinePackageYaml(input.rawPipeline);
      if (input.overlay) {
        // The derived overlay is a valid package bound to this exact YAML.
        assertValidPipelinePackage(
          input.overlay.manifest,
          input.overlay.digest,
        );
        expect(input.overlay.manifest.pipelineContentHash).toBe(hash);
        expect(input.overlay.sourcePackageDigest).toBe(world.pkg.digest);
      }
      world.pipelines.set(input.localPipelineId, {
        name: input.name,
        raw: input.rawPipeline,
        hash,
        ...(input.overlay
          ? {
              overlay: {
                digest: input.overlay.digest,
                manifest: input.overlay.manifest,
              },
            }
          : {}),
      });
      world.afterCreate?.('pipeline');
      return Promise.resolve({
        localPipelineId: input.localPipelineId,
        contentHash: hash,
      });
    },
    removePipeline: async (localPipelineId, expectedContentHash) => {
      world.removePipelineCalls.push(localPipelineId);
      const held = world.removePipelineGate;
      if (
        held &&
        held.localId === localPipelineId &&
        (held.calls === 'all' ||
          world.removePipelineCalls.filter((id) => id === localPipelineId)
            .length === 1)
      )
        await held.release;
      const pipeline = world.pipelines.get(localPipelineId);
      if (!pipeline) return 'missing';
      if (pipeline.hash !== expectedContentHash) return 'kept';
      world.pipelines.delete(localPipelineId);
      return 'removed';
    },
    removeSkillFolder: (localName, files) => {
      const current = world.skills.get(localName);
      if (current === undefined) return Promise.resolve('missing');
      // The fake folder holds only its SKILL.md; any other hash is an edit.
      if (
        !files.some(
          (file) => file.path === 'SKILL.md' && file.sha256 === current,
        )
      )
        return Promise.resolve('kept');
      world.skills.delete(localName);
      return Promise.resolve('removed');
    },
    listAutomations: () =>
      Promise.resolve(world.automations.map((item) => ({ ...item }))),
    createAutomation: (request) => {
      if (world.failAt === 'automation')
        return Promise.reject(new Error('automations file locked'));
      world.automationRequests.push(request);
      const now = tick();
      const created: ScheduledActivity = {
        version: 1,
        id: `automation-${world.automations.length + 1}`,
        name: request.name,
        enabled: request.enabled !== false,
        schedule: request.schedule,
        action: request.action,
        createdAt: now,
        updatedAt: now,
        failureCount: 0,
      };
      world.automations.push(created);
      world.afterCreate?.('automation');
      return Promise.resolve({ ok: true, activity: { ...created } });
    },
    deleteAutomation: (id) => {
      world.automations = world.automations.filter((item) => item.id !== id);
      return Promise.resolve({ ok: true });
    },
    readDestination: (projectId) =>
      Promise.resolve({
        repoIds: ['repo-1'],
        defaultSkills: [...(world.defaults.get(projectId) ?? [])],
      }),
    addDefaultSkills: (workspaceId, skills) => {
      if (world.failAt === 'defaults')
        return Promise.reject(new Error('manifest unreadable'));
      const current = world.defaults.get(workspaceId) ?? [];
      for (const skill of skills) {
        if (
          !current.some(
            (ref) =>
              ref.sourceId === skill.sourceId &&
              ref.skillName === skill.skillName,
          )
        )
          current.push({ ...skill });
      }
      world.defaults.set(workspaceId, current);
      return Promise.resolve();
    },
    removeDefaultSkills: (workspaceId, skills) => {
      world.defaults.set(
        workspaceId,
        (world.defaults.get(workspaceId) ?? []).filter(
          (ref) =>
            !skills.some(
              (skill) =>
                skill.sourceId === ref.sourceId &&
                skill.skillName === ref.skillName,
            ),
        ),
      );
      return Promise.resolve();
    },
    readJournal: (key) =>
      Promise.resolve(
        world.journals.has(key)
          ? structuredClone(world.journals.get(key) ?? null)
          : null,
      ),
    writeJournal: (journal) => {
      world.journals.set(journal.key, structuredClone(journal));
      world.journalHistory.push(structuredClone(journal));
      return Promise.resolve();
    },
    deleteJournal: (key) => {
      world.journals.delete(key);
      return Promise.resolve();
    },
    listJournals: () =>
      Promise.resolve(
        Array.from(world.journals.values()).map((journal) =>
          structuredClone(journal),
        ),
      ),
  };
  return { ...base, ...overrides };
}

const CODE_RESPONSE: SharedContainerForkResponse = {
  containerType: 'CODE_WORKTREE',
  projectId: 'fork-project',
  worktreeId: 'fork-worktree',
  warnings: [],
  provenance: {
    sourceContainerId: 'container-1',
    sourceRevisionId: 'revision-1',
    sourceOwnerDisplayName: 'Ada',
    forkedAt: '2026-10-22T00:00:00.000Z',
  },
};

const COWORK_RESPONSE: SharedContainerForkResponse = {
  ...CODE_RESPONSE,
  containerType: 'COWORK_WORK_ENTRY',
  projectId: 'cowork-project',
  worktreeId: 'cowork-entry',
};

function forkRequest(digest?: string): SharedContainerForkRequest {
  return {
    containerId: 'container-1',
    revisionId: 'revision-1',
    organizationId: 'organization-1',
    sourceOwnerDisplayName: 'Ada',
    destination: {
      kind: 'new-workspace',
      owner: { kind: 'organization', organizationId: 'organization-1' },
    },
    ...(digest !== undefined ? { expectedPackageDigest: digest } : {}),
  };
}

function journalOf(
  world: World,
  response: SharedContainerForkResponse = CODE_RESPONSE,
): ForkCapabilityInstallJournal | undefined {
  const owner = forkCapabilityInstallOwner(
    response,
    'container-1',
    'revision-1',
  );
  return world.journals.get(
    forkCapabilityInstallJournalKey(owner.localId, world.pkg.digest),
  );
}

function expectNothingInstalled(world: World): void {
  expect(world.agents).toEqual([]);
  expect(world.pipelines.size).toBe(0);
  expect(world.automations).toEqual([]);
  expect(world.skills.size).toBe(0);
  expect(world.ledger.size).toBe(0);
}

describe('installForkCapabilityPackage', () => {
  let root: string;
  let pkg: ContainerPackage;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'fork-capabilities-'));
    pkg = await buildContainerPackage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.mocked(updateWorkspaceHooks).mockClear();
    jest.mocked(setWorktreeHooksPaused).mockClear();
  });

  describe('revision binding and consent', () => {
    it('does nothing for a legacy or package-free revision', async () => {
      const world = newWorld(pkg);
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([]);
      expect(world.getPackageCalls).toEqual([]);
      expectNothingInstalled(world);
    });

    it('skips a package the confirmation never disclosed', async () => {
      const world = newWorld(pkg);
      world.replicaPackage = { digest: pkg.digest };
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([UNDISCLOSED_PACKAGE_WARNING]);
      expect(world.getPackageCalls).toEqual([]);
      expectNothingInstalled(world);
    });

    it('skips a disclosure that no longer matches the revision', async () => {
      const world = newWorld(pkg);
      world.replicaPackage = {
        digest: 'pp:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      };
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([CHANGED_PACKAGE_WARNING]);
      expect(world.getPackageCalls).toEqual([]);
      expectNothingInstalled(world);
    });

    it('installs the disclosed revision and digest even after a newer publication', async () => {
      // The replica moved to a later revision: nothing local describes the
      // forked one, so the pinned server read alone decides.
      const world = newWorld(pkg);
      await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(world.getPackageCalls).toEqual([
        { revisionId: 'revision-1', digest: pkg.digest },
      ]);
      expect(world.ledger.size).toBe(1);
    });

    it.each([
      [404, UNAVAILABLE_PACKAGE_WARNING],
      [409, UNAVAILABLE_PACKAGE_WARNING],
      [403, UNAVAILABLE_PACKAGE_WARNING],
      [426, INVALID_PACKAGE_WARNING],
    ])(
      'leaves the fork alone when the pinned read is refused (%s)',
      async (status, warning) => {
        const world = newWorld(pkg);
        world.getPackageError = new CanopyCloudClientError(
          'http-error',
          'refused',
          status,
        );
        await expect(
          installForkCapabilityPackage(
            { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
            depsFor(world),
          ),
        ).resolves.toEqual([warning]);
        expectNothingInstalled(world);
      },
    );
  });

  describe('integrity', () => {
    it('refuses a tampered definition before changing anything', async () => {
      const world = newWorld(pkg);
      const entry = pkg.manifest.resources.find(
        (resource) => resource.id === pkg.ids.agent,
      )?.trees[0]?.entries[0];
      world.tamperedBlob = entry?.sha256;
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([INVALID_PACKAGE_WARNING]);
      expectNothingInstalled(world);
      expect(journalOf(world)).toBeUndefined();
    });

    it('refuses a non-canonical definition document', async () => {
      const original = pkg.blobs.get(
        pkg.manifest.resources.find((resource) => resource.id === pkg.ids.agent)
          ?.trees[0]?.entries[0]?.sha256 ?? '',
      );
      if (!original) throw new Error('missing agent document');
      const reformatted = new TextEncoder().encode(
        JSON.stringify(JSON.parse(new TextDecoder().decode(original)), null, 2),
      );
      const tampered = withDocument(pkg, pkg.ids.agent, reformatted);
      const world = newWorld(tampered);
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(tampered.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([INVALID_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });

    it('refuses an unsupported definition version', async () => {
      const original = pkg.blobs.get(
        pkg.manifest.resources.find((resource) => resource.id === pkg.ids.agent)
          ?.trees[0]?.entries[0]?.sha256 ?? '',
      );
      if (!original) throw new Error('missing agent document');
      const parsed: unknown = JSON.parse(new TextDecoder().decode(original));
      const future = new TextEncoder().encode(
        JSON.stringify({
          ...(typeof parsed === 'object' && parsed !== null ? parsed : {}),
          version: 2,
        }),
      );
      const tampered = withDocument(pkg, pkg.ids.agent, future);
      const world = newWorld(tampered);
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(tampered.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([INVALID_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });

    it('refuses a digest that does not match the disclosure', async () => {
      const world = newWorld(pkg);
      const other = 'pp:v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(other), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([INVALID_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });

    it('stops at its deadline without leaving anything behind', async () => {
      const world = newWorld(pkg);
      world.getPackageHangs = true;
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world, { timeoutMs: 20 }),
        ),
      ).resolves.toEqual([TIMED_OUT_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });
  });

  describe('a code fork', () => {
    it('installs skills, Agents, pipelines and turned-off automations, and omits hooks', async () => {
      const world = newWorld(pkg);
      world.agents.push({
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'opus',
        instructions: 'Mine.',
        pluginSelections: selections(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      world.existingPipelineNames.push('Review');
      world.skills.set('helper', 'user');
      world.defaults.set('fork-project', [
        { sourceId: 'custom:app', skillName: 'mine' },
      ]);

      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );

      // Skills: a taken name gets a suffix, never an overwrite.
      expect(Array.from(world.skills.keys()).sort()).toEqual([
        'helper',
        'helper-2',
      ]);

      // Agents: a new local copy; the recipient's own Reviewer is untouched.
      const installedAgent = world.agents.find(
        (agent) => agent.id !== 'agent_model_reviewer',
      );
      expect(installedAgent).toMatchObject({
        name: 'Reviewer (2)',
        baseModel: 'sonnet',
        // The recipient's `helper` took the packaged name.
        instructions: 'Review with /helper-2 before replying.',
      });
      expect(world.agents[0]).toMatchObject({ instructions: 'Mine.' });
      const localAgentId = installedAgent?.id ?? '';
      expect(localAgentId).not.toBe('agent_model_reviewer');

      // Pipelines: deduplicated name, Agent rewritten, child and the skill
      // its step invokes kept in the overlay, each bound to its own step.
      const [pipelineId, pipeline] =
        Array.from(world.pipelines.entries())[0] ?? [];
      expect(pipeline?.name).toBe('Review (2)');
      expect(pipeline?.raw).toContain(`model: ${localAgentId}`);
      expect(pipeline?.raw).not.toContain('agent_model_reviewer\n');
      expect(
        pipeline?.overlay?.manifest.resources
          .map((resource) => resource.kind)
          .sort(),
      ).toEqual(['child_pipeline', 'standalone_skill']);
      // The Claude step's `/helper` binds the Claude copy of the skill.
      const claudeHelper = pkg.manifest.resources.find(
        (resource) =>
          resource.kind === 'standalone_skill' &&
          resource.invocationKeys.includes('/helper'),
      );
      expect(pipeline?.overlay?.manifest.bindings).toEqual([
        { jobId: 'review', stepId: 'loop', resourceIds: [claudeHelper?.id] },
        { jobId: 'review', stepId: 'nested', resourceIds: [pkg.ids.child] },
      ]);

      // Automations: turned off, targeting the fork, no source ids or
      // `installedFrom`, remapped to the local pipeline and Agent.
      expect(world.automations).toHaveLength(2);
      for (const created of world.automations)
        expect(created.enabled).toBe(false);
      for (const request of world.automationRequests) {
        expect(request.installedFrom).toBeUndefined();
        const serialized = JSON.stringify(request);
        for (const sourceId of [
          'workspace-local-1',
          'worktree-local-1',
          'pipeline-local-1',
          'chat-local-1',
        ])
          expect(serialized).not.toContain(sourceId);
      }
      const pipelineAction = world.automations.find(
        (item) => item.action.type === 'worktree_pipeline',
      )?.action;
      expect(pipelineAction).toMatchObject({
        type: 'worktree_pipeline',
        workspaceId: 'fork-project',
        baseWorktreeId: 'fork-worktree',
        pipelineId,
        pipelineSource: 'user',
      });
      const promptAction = world.automations.find(
        (item) => item.action.type === 'worktree_prompt',
      )?.action;
      expect(promptAction).toMatchObject({
        type: 'worktree_prompt',
        workspaceId: 'fork-project',
        existingWorktreeId: 'fork-worktree',
        model: localAgentId,
      });
      expect(
        promptAction && 'pluginSelections' in promptAction
          ? promptAction.pluginSelections?.skillRefs
          : undefined,
      ).toEqual([{ sourceId: 'custom:app', skillName: 'helper-2' }]);
      // A prompt automation has no per-step overlay either, so its prompt
      // invokes the local copy its selections carry.
      expect(
        promptAction && 'prompt' in promptAction
          ? promptAction.prompt
          : undefined,
      ).toBe('Triage with /helper-2.');

      // Hooks: never written, never paused.
      expect(updateWorkspaceHooks).not.toHaveBeenCalled();
      expect(setWorktreeHooksPaused).not.toHaveBeenCalled();

      // Directly used skills join the destination's defaults; the
      // recipient's existing selections stay.
      expect(world.defaults.get('fork-project')).toEqual([
        { sourceId: 'custom:app', skillName: 'mine' },
        { sourceId: 'custom:app', skillName: 'helper-2' },
      ]);

      expect(warnings).toEqual([
        'Automation "Weekly summary" wasn\'t added because it runs somewhere this copy doesn\'t include.',
        HOOKS_OMITTED_WARNING,
      ]);
      const owner = forkCapabilityInstallOwner(
        CODE_RESPONSE,
        'container-1',
        'revision-1',
      );
      expect(owner.localId).toBe(
        'worktree:fork-project/fork-worktree:container-1:revision-1',
      );
      expect(world.ledger.get(ownerKey(owner))).toMatchObject({
        originExternalId: 'container-1',
        packageDigest: pkg.digest,
      });
      // The ledger row is the record of a finished install; its journal goes.
      expect(journalOf(world)).toBeUndefined();
    });

    it("points the installed Agent's instructions and selections at the packaged skill's local copy", async () => {
      const world = newWorld(pkg);
      // The recipient's own, different `helper` takes the packaged name.
      world.skills.set('helper', 'user');

      await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );

      expect(world.skills.get('helper')).toBe('user');
      const [agent] = world.agents;
      // The Agent has no per-step overlay: both its instructions and its
      // selections name the installed copy, never the recipient's `helper`.
      expect(agent?.instructions).toBe(
        'Review with /helper-2 before replying.',
      );
      expect(agent?.pluginSelections.skillRefs).toEqual([
        { sourceId: 'custom:app', skillName: 'helper-2' },
      ]);
    });

    it("gives the installed pipeline's step its packaged skill under the packaged name", async () => {
      const world = newWorld(pkg);
      // The recipient's own, different `helper`: installing the package's
      // `helper` globally gets the suffixed `helper-2`.
      world.skills.set('helper', 'user');

      await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(world.skills.has('helper-2')).toBe(true);
      const installed = Array.from(world.pipelines.values())[0];
      const overlay = installed?.overlay;
      if (!installed || !overlay) throw new Error('no overlay was installed');
      // The step still invokes the skill by its packaged name; its overlay
      // supplies that skill, whatever the recipient has installed.
      expect(installed.raw).toContain('Run /helper on the diff.');

      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), 'fork-skill-runtime-'),
      );
      try {
        // Materialize and snapshot exactly as a run of the installed pipeline.
        const cachedPackagePath = await installPipelinePackageAtomically({
          packagesRoot: path.join(runtimeRoot, 'cache'),
          digest: overlay.digest,
          manifest: overlay.manifest,
          fetchBlob: (sha256) => {
            const bytes = pkg.blobs.get(sha256);
            return bytes
              ? Promise.resolve(bytes)
              : Promise.reject(new Error(`missing blob ${sha256}`));
          },
        });
        const executionDirectory = path.join(runtimeRoot, 'execution');
        await mkdir(executionDirectory, { recursive: true });
        const snapshot = await snapshotPipelinePackageForExecution({
          digest: overlay.digest,
          rawPipeline: installed.raw,
          manifest: overlay.manifest,
          cachedPackagePath,
          executionDirectory,
        });
        const runOverlay = await loadPipelinePackageExecutionOverlay(snapshot);
        if (!runOverlay) throw new Error('no run overlay');
        const stepOverlay = filterPipelinePackageOverlayForStep(
          runOverlay,
          snapshot.bindings,
          'review',
          'loop',
        );
        // The step runtime the executor builds for a Claude step.
        const claudePluginDir = path.join(runtimeRoot, 'runtime', 'claude');
        const resolved = resolvePipelineStepPlugins(
          selections(),
          'fork-project',
          'fork-worktree',
          'loop',
          {
            purpose: 'claude-session',
            runtimeDirs: {
              rootDir: path.join(runtimeRoot, 'runtime'),
              claudePluginDir,
            },
            packageOverlay: stepOverlay,
          },
        );
        expect(resolved.sdkPlugins.map((plugin) => plugin.path)).toContain(
          claudePluginDir,
        );
        await expect(
          readFile(
            path.join(claudePluginDir, 'skills', 'helper', 'SKILL.md'),
            'utf8',
          ),
        ).resolves.toBe('# Helper\n');
        // A step that uses no packaged skill gets none.
        expect(
          filterPipelinePackageOverlayForStep(
            runOverlay,
            snapshot.bindings,
            'review',
            'nested',
          )?.resources.map((resource) => resource.kind),
        ).toEqual(['child_pipeline']);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    });

    it('is repeat-safe for the same destination, revision and digest', async () => {
      const world = newWorld(pkg);
      const deps = depsFor(world);
      const input = {
        request: forkRequest(pkg.digest),
        response: CODE_RESPONSE,
      };
      const [first, concurrent] = await Promise.all([
        installForkCapabilityPackage(input, deps),
        installForkCapabilityPackage(input, deps),
      ]);
      expect(concurrent).toEqual(first);
      const snapshot = {
        agents: world.agents.length,
        pipelines: world.pipelines.size,
        automations: world.automations.length,
        skills: world.skills.size,
      };
      await expect(installForkCapabilityPackage(input, deps)).resolves.toEqual(
        [],
      );
      expect({
        agents: world.agents.length,
        pipelines: world.pipelines.size,
        automations: world.automations.length,
        skills: world.skills.size,
      }).toEqual(snapshot);
      expect(world.getPackageCalls).toHaveLength(1);
    });

    it('warns that a gated automation arrives without its run condition', async () => {
      const original = pkg.blobs.get(
        pkg.manifest.resources.find(
          (resource) => resource.id === pkg.ids.promptAutomation,
        )?.trees[0]?.entries[0]?.sha256 ?? '',
      );
      if (!original) throw new Error('missing automation document');
      const parsed = parseSharedContainerDefinitionDocument(original);
      if (!parsed.ok || parsed.value.kind !== 'automation_definition')
        throw new Error('expected an automation definition');
      const document = parsed.value;
      const gated = withDocument(
        pkg,
        pkg.ids.promptAutomation,
        encodeSharedContainerDefinitionDocument({
          ...document,
          automation: { ...document.automation, hasRunCondition: true },
        }),
      );
      const world = newWorld(gated);
      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(gated.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(
        world.automations.find((item) => item.name === 'Morning triage'),
      ).toBeDefined();
      expect(warnings).toContain(
        'Automation "Morning triage" had a run condition that didn\'t come with the copy. Add one before you turn it on.',
      );
    });

    it('skips a pipeline whose packaged child routes through an Agent, and the automation that runs it', async () => {
      // A child pipeline travels verbatim in the overlay, so its Agent id
      // would stay the source machine's: never install it that way.
      const routed = withDocument(
        pkg,
        pkg.ids.child,
        new TextEncoder().encode(
          [
            'name: Child',
            'on: dispatch',
            'jobs:',
            '  inner:',
            '    steps:',
            '      - id: ask',
            '        uses: builtin/agent-prompt',
            '        with:',
            '          prompt: Check it.',
            '          model: agent_model_reviewer',
            '',
          ].join('\n'),
        ),
      );
      const world = newWorld(routed);
      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(routed.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(world.pipelines.size).toBe(0);
      expect(world.automations.map((item) => item.name)).toEqual([
        'Morning triage',
      ]);
      expect(world.agents).toHaveLength(1);
      expect(world.ledger.size).toBe(1);
      expect(warnings).toHaveLength(4);
      expect(warnings).toEqual(
        expect.arrayContaining([
          'Pipeline "Review" wasn\'t added because a pipeline or action it runs uses an Agent that copies can\'t include yet.',
          'Automation "Nightly review" wasn\'t added because the pipeline it runs wasn\'t added.',
          'Automation "Weekly summary" wasn\'t added because it runs somewhere this copy doesn\'t include.',
          HOOKS_OMITTED_WARNING,
        ]),
      );
    });

    it('warns once about hooks even when the package has nothing else for this fork', async () => {
      const world = newWorld(pkg);
      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(
        warnings.filter((warning) => warning === HOOKS_OMITTED_WARNING),
      ).toHaveLength(1);
    });
  });

  describe('a Cowork fork', () => {
    it('owns its install by the Cowork project and targets it', async () => {
      const world = newWorld(pkg);
      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: COWORK_RESPONSE },
        depsFor(world),
      );
      const owner = forkCapabilityInstallOwner(
        COWORK_RESPONSE,
        'container-1',
        'revision-1',
      );
      expect(owner.localId).toBe(
        'cowork:cowork-project:container-1:revision-1',
      );
      expect(world.ledger.has(ownerKey(owner))).toBe(true);
      expect(world.automations.map((item) => item.action)).toEqual([
        expect.objectContaining({
          type: 'standalone_prompt',
          chatProjectId: 'cowork-project',
        }),
      ]);
      expect(JSON.stringify(world.automations)).not.toContain('cowork-local-1');
      expect(JSON.stringify(world.automations)).not.toContain('entry-local-1');
      expect(warnings).toEqual(
        expect.arrayContaining([
          'Automation "Nightly review" wasn\'t added because it runs somewhere this copy doesn\'t include.',
          'Automation "Morning triage" wasn\'t added because it runs somewhere this copy doesn\'t include.',
          HOOKS_OMITTED_WARNING,
        ]),
      );
    });
  });

  describe('compensation', () => {
    it.each<FailurePoint>([
      'materialize',
      'agent',
      'pipeline',
      'automation',
      'defaults',
      'ledger',
    ])(
      'unwinds everything this attempt created when %s fails',
      async (failAt) => {
        const world = newWorld(pkg);
        world.failAt = failAt;
        world.defaults.set('fork-project', [
          { sourceId: 'custom:app', skillName: 'mine' },
        ]);
        const warnings = await installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world),
        );
        expect(warnings).toEqual([FAILED_PACKAGE_WARNING]);
        expectNothingInstalled(world);
        expect(world.defaults.get('fork-project')).toEqual([
          { sourceId: 'custom:app', skillName: 'mine' },
        ]);
        // Nothing is left to name, so the journal is not kept either.
        expect(journalOf(world)).toBeUndefined();
        expect(world.journalHistory.at(-1)?.status).toBe('rolled-back');
      },
    );

    it('names every journaled automation when it cannot list automations to undo them', async () => {
      const world = newWorld(pkg);
      world.failAt = 'defaults';
      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world, {
          listAutomations: () =>
            Promise.reject(new Error('automations file locked')),
        }),
      );
      // Turned off but still here: they must be named, not counted as removed.
      expect(world.automations).toHaveLength(2);
      expect(warnings[0]).toBe(FAILED_PACKAGE_WARNING);
      expect(warnings[1]).toMatch(/automation "Morning triage"/);
      expect(warnings[1]).toMatch(/automation "Nightly review"/);
      const journal = journalOf(world);
      expect(journal?.status).toBe('rollback-incomplete');
      expect([...(journal?.residual ?? [])].sort()).toEqual([
        'automation "Morning triage"',
        'automation "Nightly review"',
      ]);
    });

    it('keeps objects the user changed during the attempt and names them', async () => {
      const world = newWorld(pkg);
      world.failAt = 'defaults';
      world.afterCreate = (kind): void => {
        if (kind !== 'agent') return;
        const created = world.agents[world.agents.length - 1];
        if (created) created.instructions = 'Edited by the user.';
      };
      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(world.agents).toHaveLength(1);
      expect(world.agents[0]?.instructions).toBe('Edited by the user.');
      expect(world.pipelines.size).toBe(0);
      expect(world.automations).toEqual([]);
      expect(warnings).toEqual([
        FAILED_PACKAGE_WARNING,
        'Some items from a failed capability install are still here: Agent "Reviewer".',
      ]);
      expect(journalOf(world)).toMatchObject({
        status: 'rollback-incomplete',
        residual: ['Agent "Reviewer"'],
      });
    });
  });

  describe('crash recovery', () => {
    it('compensates an interrupted attempt on the next install', async () => {
      const world = newWorld(pkg);
      const crashedAgent = {
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Interrupted copy.',
        pluginSelections: selections(),
        createdAt: '2026-10-22T00:00:01.000Z',
        updatedAt: '2026-10-22T00:00:01.000Z',
      };
      world.agents.push({
        ...crashedAgent,
        contentHash: contentHashOf(crashedAgent),
      });
      world.pipelines.set('crashed-pipeline', {
        name: 'Review',
        raw: PIPELINE_YAML,
        hash: hashPipelinePackageYaml(PIPELINE_YAML),
      });
      world.automations.push({
        ...activity('crashed-automation', 'Nightly review', {
          type: 'worktree_prompt',
          workspaceId: 'other-project',
          prompt: 'x',
        }),
        enabled: false,
        createdAt: '2026-10-22T00:00:02.000Z',
        updatedAt: '2026-10-22T00:00:02.000Z',
      });
      const interrupted: ForkCapabilityInstallJournal = {
        version: 1,
        key: 'interrupted',
        ownerLocalId:
          'worktree:other-project/other-worktree:container-9:revision-9',
        containerId: 'container-9',
        revisionId: 'revision-9',
        packageDigest: pkg.digest,
        destination: {
          projectId: 'other-project',
          worktreeId: 'other-worktree',
          containerType: 'CODE_WORKTREE',
        },
        status: 'installing',
        startedAt: '2026-10-22T00:00:00.000Z',
        updatedAt: '2026-10-22T00:00:02.000Z',
        skills: [],
        // The Agent and automation were created but their ids never reached
        // the journal: only untouched objects of that name from this attempt
        // can be claimed.
        agents: [{ resourceId: pkg.ids.agent, name: 'Reviewer' }],
        pipelines: [
          {
            resourceId: pkg.ids.pipeline,
            localId: 'crashed-pipeline',
            contentHash: hashPipelinePackageYaml(PIPELINE_YAML),
            name: 'Review',
          },
        ],
        automations: [
          { resourceId: pkg.ids.promptAutomation, name: 'Nightly review' },
        ],
        environmentRequirements: [],
      };
      world.journals.set(interrupted.key, interrupted);

      await installForkCapabilityPackage(
        { request: forkRequest(), response: CODE_RESPONSE },
        depsFor(world),
      );
      // A package-free fork is not an attempt; recovery waits for one.
      expect(world.journals.get('interrupted')?.status).toBe('installing');

      await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(
        world.journalHistory.filter((entry) => entry.key === 'interrupted'),
      ).toEqual([expect.objectContaining({ status: 'rolled-back' })]);
      expect(world.journals.has('interrupted')).toBe(false);
      expect(world.pipelines.has('crashed-pipeline')).toBe(false);
      expect(
        world.automations.some((item) => item.id === 'crashed-automation'),
      ).toBe(false);
      expect(
        world.agents.some(
          (agent) => agent.instructions === 'Interrupted copy.',
        ),
      ).toBe(false);
    });

    it('undoes an interrupted attempt for the same fork before retrying it', async () => {
      const world = newWorld(pkg);
      const owner = forkCapabilityInstallOwner(
        CODE_RESPONSE,
        'container-1',
        'revision-1',
      );
      const key = forkCapabilityInstallJournalKey(owner.localId, pkg.digest);
      const hash = hashPipelinePackageYaml(PIPELINE_YAML);
      world.pipelines.set('half-installed', {
        name: 'Review',
        raw: PIPELINE_YAML,
        hash,
      });
      world.journals.set(key, {
        version: 1,
        key,
        ownerLocalId: owner.localId,
        containerId: 'container-1',
        revisionId: 'revision-1',
        packageDigest: pkg.digest,
        destination: {
          projectId: 'fork-project',
          worktreeId: 'fork-worktree',
          containerType: 'CODE_WORKTREE',
        },
        status: 'installing',
        startedAt: '2026-10-22T00:00:00.000Z',
        updatedAt: '2026-10-22T00:00:00.000Z',
        skills: [],
        agents: [],
        pipelines: [
          {
            resourceId: pkg.ids.pipeline,
            localId: 'half-installed',
            contentHash: hash,
            name: 'Review',
          },
        ],
        automations: [],
        environmentRequirements: [],
      });
      await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      // The retry installs exactly one copy, not the interrupted one as well.
      expect(world.pipelines.has('half-installed')).toBe(false);
      expect(world.pipelines.size).toBe(1);
      expect(world.journals.has(key)).toBe(false);
      expect(world.journalHistory.at(-1)).toMatchObject({
        status: 'completed',
      });
    });

    it('finishes an attempt whose ledger row was written before the crash', async () => {
      const world = newWorld(pkg);
      const owner = forkCapabilityInstallOwner(
        CODE_RESPONSE,
        'container-1',
        'revision-1',
      );
      world.ledger.set(ownerKey(owner), {
        owner,
        originExternalId: 'container-1',
        pipelineContentHash: pkg.manifest.pipelineContentHash,
        packageDigest: pkg.digest,
        installedAt: '2026-10-22T00:00:00.000Z',
      });
      world.pipelines.set('kept-pipeline', {
        name: 'Review',
        raw: PIPELINE_YAML,
        hash: hashPipelinePackageYaml(PIPELINE_YAML),
      });
      const key = forkCapabilityInstallJournalKey(owner.localId, pkg.digest);
      world.journals.set(key, {
        version: 1,
        key,
        ownerLocalId: owner.localId,
        containerId: 'container-1',
        revisionId: 'revision-1',
        packageDigest: pkg.digest,
        destination: {
          projectId: 'fork-project',
          worktreeId: 'fork-worktree',
          containerType: 'CODE_WORKTREE',
        },
        status: 'installing',
        startedAt: '2026-10-22T00:00:00.000Z',
        updatedAt: '2026-10-22T00:00:00.000Z',
        skills: [],
        agents: [],
        pipelines: [
          {
            resourceId: pkg.ids.pipeline,
            localId: 'kept-pipeline',
            contentHash: hashPipelinePackageYaml(PIPELINE_YAML),
            name: 'Review',
          },
        ],
        automations: [],
        environmentRequirements: [],
      });
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([]);
      expect(world.journals.has(key)).toBe(false);
      expect(world.journalHistory.at(-1)).toMatchObject({
        status: 'completed',
      });
      expect(world.pipelines.has('kept-pipeline')).toBe(true);
      expect(world.getPackageCalls).toEqual([]);
    });
  });

  /** An earlier attempt for this same fork that stopped without its ledger row. */
  function staleJournal(
    overrides: Partial<ForkCapabilityInstallJournal> = {},
  ): ForkCapabilityInstallJournal {
    const owner = forkCapabilityInstallOwner(
      CODE_RESPONSE,
      'container-1',
      'revision-1',
    );
    return {
      version: 1,
      key: forkCapabilityInstallJournalKey(owner.localId, pkg.digest),
      attemptId: 'stale-attempt',
      ownerLocalId: owner.localId,
      containerId: 'container-1',
      revisionId: 'revision-1',
      packageDigest: pkg.digest,
      destination: {
        projectId: 'fork-project',
        worktreeId: 'fork-worktree',
        containerType: 'CODE_WORKTREE',
      },
      status: 'installing',
      startedAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      skills: [],
      agents: [],
      pipelines: [],
      automations: [],
      environmentRequirements: [],
      ...overrides,
    };
  }

  function skillMdSha(): string {
    const sha = pkg.manifest.resources
      .find((resource) => resource.id === pkg.ids.skill)
      ?.trees[0]?.entries.find((entry) => entry.path === 'SKILL.md')?.sha256;
    if (!sha) throw new Error('package skill has no SKILL.md');
    return sha;
  }

  function halfInstalledPipeline(world: World): ForkCapabilityInstallJournal {
    const hash = hashPipelinePackageYaml(PIPELINE_YAML);
    world.pipelines.set('half-installed', {
      name: 'Review',
      raw: PIPELINE_YAML,
      hash,
    });
    const journal = staleJournal({
      pipelines: [
        {
          resourceId: pkg.ids.pipeline,
          localId: 'half-installed',
          contentHash: hash,
          name: 'Review',
        },
      ],
    });
    world.journals.set(journal.key, journal);
    return journal;
  }

  describe('skill compensation', () => {
    it('journals each skill folder as created or reused before writing into it', async () => {
      const world = newWorld(pkg);
      world.skills.set('helper', 'user');
      await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      // The package carries one resource per provider for the same skill:
      // the first creates the folder and its twin reuses it.
      const recorded = world.journalHistory.find(
        (entry) => entry.skills.length === 2,
      );
      expect(
        recorded?.skills.map(({ localName, created }) => ({
          localName,
          created,
        })),
      ).toEqual([
        { localName: 'helper-2', created: true },
        { localName: 'helper-2', created: false },
      ]);
      // Each entry carries the packaged tree compensation checks against.
      expect(
        recorded?.skills.every((skill) =>
          skill.files?.some(
            (file) => file.path === 'SKILL.md' && file.sha256 === skillMdSha(),
          ),
        ),
      ).toBe(true);
      // Recorded before any definition was created.
      expect(recorded?.agents).toEqual([]);
    });

    it('recovery removes a skill folder an interrupted attempt created', async () => {
      const world = newWorld(pkg);
      world.skills.set('helper', skillMdSha());
      const journal = staleJournal({
        skills: [
          {
            resourceId: pkg.ids.skill,
            localName: 'helper',
            created: true,
            files: [{ path: 'SKILL.md', sha256: skillMdSha() }],
          },
        ],
      });
      world.journals.set(journal.key, journal);
      await recoverForkCapabilityInstalls(depsFor(world));
      expect(world.skills.has('helper')).toBe(false);
      expect(world.journalHistory.at(-1)).toMatchObject({
        key: journal.key,
        status: 'rolled-back',
        residual: [],
      });
    });

    it('recovery leaves a folder the attempt reused alone', async () => {
      const world = newWorld(pkg);
      world.skills.set('helper', skillMdSha());
      const journal = staleJournal({
        skills: [
          {
            resourceId: pkg.ids.skill,
            localName: 'helper',
            created: false,
            files: [{ path: 'SKILL.md', sha256: skillMdSha() }],
          },
        ],
      });
      world.journals.set(journal.key, journal);
      await recoverForkCapabilityInstalls(depsFor(world));
      expect(world.skills.get('helper')).toBe(skillMdSha());
      expect(world.journalHistory.at(-1)).toMatchObject({
        status: 'rolled-back',
        residual: [],
      });
    });

    it('recovery keeps a created folder the user edited and names it', async () => {
      const world = newWorld(pkg);
      world.skills.set('helper', 'edited');
      const journal = staleJournal({
        skills: [
          {
            resourceId: pkg.ids.skill,
            localName: 'helper',
            created: true,
            files: [{ path: 'SKILL.md', sha256: skillMdSha() }],
          },
        ],
      });
      world.journals.set(journal.key, journal);
      await recoverForkCapabilityInstalls(depsFor(world));
      expect(world.skills.get('helper')).toBe('edited');
      expect(world.journals.get(journal.key)).toMatchObject({
        status: 'rollback-incomplete',
        residual: ['skill "helper"'],
      });
    });

    it('names what an earlier attempt left behind when the same fork retries', async () => {
      const world = newWorld(pkg);
      world.skills.set('helper', 'edited');
      const journal = staleJournal({
        skills: [
          {
            resourceId: pkg.ids.skill,
            localName: 'helper',
            created: true,
            files: [{ path: 'SKILL.md', sha256: skillMdSha() }],
          },
        ],
      });
      world.journals.set(journal.key, journal);
      // Startup recovery has not reached this journal: the retry recovers it.
      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world, { listJournals: () => Promise.resolve([]) }),
      );
      expect(
        warnings.filter(
          (warning) =>
            warning ===
            'Some items from a failed capability install are still here: skill "helper".',
        ),
      ).toHaveLength(1);
      expect(world.skills.get('helper')).toBe('edited');
      expect(world.ledger.size).toBe(1);
      // The retry's own journal does not erase what the recovery recorded.
      expect(
        Array.from(world.journals.values()).filter(
          (entry) => entry.status === 'rollback-incomplete',
        ),
      ).toEqual([
        expect.objectContaining({
          attemptId: 'stale-attempt',
          residual: ['skill "helper"'],
        }),
      ]);
    });

    it('keeps an earlier incomplete rollback on record when the same fork installs again', async () => {
      const world = newWorld(pkg);
      const earlier = staleJournal({
        status: 'rollback-incomplete',
        residual: ['Agent "Reviewer"'],
        updatedAt: '2026-10-21T00:00:00.000Z',
      });
      world.journals.set(earlier.key, earlier);
      const warning = residualWarning(['Agent "Reviewer"']);

      const warnings = await installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      );
      expect(world.ledger.size).toBe(1);
      expect(warnings.filter((entry) => entry === warning)).toHaveLength(1);
      // Kept with its own retention clock, under a name no attempt reuses.
      const kept = Array.from(world.journals.values()).filter(
        (entry) => entry.status === 'rollback-incomplete',
      );
      expect(kept).toEqual([
        expect.objectContaining({
          attemptId: 'stale-attempt',
          residual: ['Agent "Reviewer"'],
          updatedAt: '2026-10-21T00:00:00.000Z',
        }),
      ]);
      expect(kept[0]?.key).not.toBe(earlier.key);

      // Named once: a repeat of the finished install does not name it again.
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([]);
      expect(
        Array.from(world.journals.values()).filter(
          (entry) => entry.status === 'rollback-incomplete',
        ),
      ).toHaveLength(1);
    });
  });

  describe('failure warnings', () => {
    it('reports caller cancellation as cancellation, not a timeout', async () => {
      const world = newWorld(pkg);
      world.getPackageHangs = true;
      const controller = new AbortController();
      const pending = installForkCapabilityPackage(
        {
          request: forkRequest(pkg.digest),
          response: CODE_RESPONSE,
          signal: controller.signal,
        },
        depsFor(world),
      );
      await settle();
      controller.abort();
      await expect(pending).resolves.toEqual([CANCELLED_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });

    it('reports a cancellation that arrived before the install started', async () => {
      const world = newWorld(pkg);
      const controller = new AbortController();
      controller.abort(new Error('window closed'));
      await expect(
        installForkCapabilityPackage(
          {
            request: forkRequest(pkg.digest),
            response: CODE_RESPONSE,
            signal: controller.signal,
          },
          depsFor(world),
        ),
      ).resolves.toEqual([CANCELLED_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });

    it('treats a local failure after verification as a failed install, whatever its message says', async () => {
      // Every blob was verified on download; a later local error is not the
      // share's fault, even when its text mentions verification.
      const world = newWorld(pkg);
      world.materializeError = new Error(
        'Pipeline package blob abc failed verification',
      );
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([FAILED_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });

    it('refuses a skill file whose bytes do not match the manifest', async () => {
      const world = newWorld(pkg);
      world.tamperedBlob = skillMdSha();
      await expect(
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          depsFor(world),
        ),
      ).resolves.toEqual([INVALID_PACKAGE_WARNING]);
      expectNothingInstalled(world);
    });

    it.each<[string, Error, string]>([
      [
        'an invalid manifest',
        new Error('Shared-container package manifest is invalid'),
        INVALID_PACKAGE_WARNING,
      ],
      [
        'a retired revision',
        new CanopyCloudClientError('http-error', 'gone', 410),
        UNAVAILABLE_PACKAGE_WARNING,
      ],
      [
        'a network failure',
        new CanopyCloudClientError('network-error', 'offline'),
        FAILED_PACKAGE_WARNING,
      ],
    ])(
      'classifies %s from the pinned route by its type',
      async (_label, error, warning) => {
        const world = newWorld(pkg);
        const defaults = defaultForkCapabilityInstallDependencies();
        mockGetRevisionPackage.mockRejectedValueOnce(error);
        await expect(
          installForkCapabilityPackage(
            { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
            depsFor(world, {
              getPackage: (request, signal) =>
                defaults.getPackage(request, signal),
            }),
          ),
        ).resolves.toEqual([warning]);
        expectNothingInstalled(world);
      },
    );
  });

  describe('callers of one attempt', () => {
    function heldPackage(world: World): {
      deps: ForkCapabilityInstallDependencies;
      held: Gate;
    } {
      const held = gate();
      const base = depsFor(world);
      return {
        held,
        deps: depsFor(world, {
          getPackage: async (request, signal) => {
            await held.released;
            return base.getPackage(request, signal);
          },
        }),
      };
    }

    it('keeps installing for a caller still waiting when another cancels', async () => {
      const world = newWorld(pkg);
      const { deps, held } = heldPackage(world);
      const cancelled = new AbortController();
      const first = installForkCapabilityPackage(
        {
          request: forkRequest(pkg.digest),
          response: CODE_RESPONSE,
          signal: cancelled.signal,
        },
        deps,
      );
      const second = installForkCapabilityPackage(
        {
          request: forkRequest(pkg.digest),
          response: CODE_RESPONSE,
          signal: new AbortController().signal,
        },
        deps,
      );
      await settle();
      cancelled.abort();
      held.release();
      const [firstWarnings, secondWarnings] = await Promise.all([
        first,
        second,
      ]);
      expect(secondWarnings).not.toContain(CANCELLED_PACKAGE_WARNING);
      // The cancelled caller learns what actually happened.
      expect(firstWarnings).toEqual(secondWarnings);
      expect(world.ledger.size).toBe(1);
      expect(world.getPackageCalls).toHaveLength(1);
    });

    it('cancels the shared attempt once every caller has cancelled', async () => {
      const world = newWorld(pkg);
      const { deps, held } = heldPackage(world);
      const controllers = [new AbortController(), new AbortController()];
      const pending = controllers.map((controller) =>
        installForkCapabilityPackage(
          {
            request: forkRequest(pkg.digest),
            response: CODE_RESPONSE,
            signal: controller.signal,
          },
          deps,
        ),
      );
      await settle();
      for (const controller of controllers) controller.abort();
      held.release();
      await expect(Promise.all(pending)).resolves.toEqual([
        [CANCELLED_PACKAGE_WARNING],
        [CANCELLED_PACKAGE_WARNING],
      ]);
      expectNothingInstalled(world);
    });

    it('starts afresh for a caller that arrives after the earlier one cancelled', async () => {
      const world = newWorld(pkg);
      const { deps, held } = heldPackage(world);
      const cancelled = new AbortController();
      const first = installForkCapabilityPackage(
        {
          request: forkRequest(pkg.digest),
          response: CODE_RESPONSE,
          signal: cancelled.signal,
        },
        deps,
      );
      await settle();
      cancelled.abort();
      // The cancelled attempt is still unwinding when this caller arrives.
      const second = installForkCapabilityPackage(
        {
          request: forkRequest(pkg.digest),
          response: CODE_RESPONSE,
          signal: new AbortController().signal,
        },
        deps,
      );
      await settle();
      held.release();
      await expect(first).resolves.toEqual([CANCELLED_PACKAGE_WARNING]);
      expect(await second).not.toContain(CANCELLED_PACKAGE_WARNING);
      expect(world.ledger.size).toBe(1);
    });
  });

  describe('concurrent recovery', () => {
    it('shares one recovery pass between its callers', async () => {
      const world = newWorld(pkg);
      const deps = depsFor(world);
      const first = recoverForkCapabilityInstalls(deps);
      expect(recoverForkCapabilityInstalls(deps)).toBe(first);
      await first;
    });

    it('a same-fork retry during startup recovery waits for it and keeps its own journal', async () => {
      const world = newWorld(pkg);
      const stale = halfInstalledPipeline(world);
      const held = gate();
      world.removePipelineGate = {
        localId: 'half-installed',
        calls: 'first',
        release: held.released,
      };
      const deps = depsFor(world);
      const startup = recoverForkCapabilityInstalls(deps);
      await settle();
      expect(world.removePipelineCalls).toEqual(['half-installed']);

      const retry = installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        deps,
      );
      await settle();
      held.release();
      await Promise.all([startup, retry]);

      // Compensated once, installed once, and the startup pass never wrote
      // over the retry's journal.
      expect(world.removePipelineCalls).toEqual(['half-installed']);
      expect(world.pipelines.has('half-installed')).toBe(false);
      expect(world.pipelines.size).toBe(1);
      expect(world.ledger.size).toBe(1);
      expect(world.journals.has(stale.key)).toBe(false);
      const fresh = world.journalHistory.findIndex(
        (entry) =>
          entry.key === stale.key && entry.attemptId !== 'stale-attempt',
      );
      expect(fresh).toBeGreaterThan(-1);
      expect(
        world.journalHistory
          .slice(fresh)
          .some((entry) => entry.attemptId === 'stale-attempt'),
      ).toBe(false);
    });

    it('stops waiting for a hung startup recovery at the install deadline', async () => {
      const world = newWorld(pkg);
      halfInstalledPipeline(world);
      const held = gate();
      world.removePipelineGate = {
        localId: 'half-installed',
        calls: 'all',
        release: held.released,
      };
      const deps = depsFor(world, { timeoutMs: 50 });
      const startup = recoverForkCapabilityInstalls(deps);
      await settle();
      const outcome = await Promise.race([
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          deps,
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still waiting'), 2_000),
        ),
      ]);
      expect(outcome).toEqual([TIMED_OUT_PACKAGE_WARNING]);
      expect(world.getPackageCalls).toEqual([]);
      held.release();
      await startup;
    });

    it('bounds its own recovery of an earlier attempt by the install deadline', async () => {
      const world = newWorld(pkg);
      const stale = halfInstalledPipeline(world);
      const held = gate();
      world.removePipelineGate = {
        localId: 'half-installed',
        calls: 'all',
        release: held.released,
      };
      const deps = depsFor(world, {
        timeoutMs: 50,
        listJournals: () => Promise.resolve([]),
      });
      const outcome = await Promise.race([
        installForkCapabilityPackage(
          { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
          deps,
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still waiting'), 2_000),
        ),
      ]);
      expect(outcome).toEqual([TIMED_OUT_PACKAGE_WARNING]);
      expect(world.getPackageCalls).toEqual([]);
      // The abandoned compensation still finishes, and alone.
      held.release();
      await settle();
      expect(world.removePipelineCalls).toEqual(['half-installed']);
      expect(world.pipelines.has('half-installed')).toBe(false);
      expect(world.journals.has(stale.key)).toBe(false);
    });
  });

  describe('journal retention', () => {
    it('recovery prunes final journals and residual journals past their retention', async () => {
      const world = newWorld(pkg);
      const base = staleJournal();
      const terminal = (
        key: string,
        status: ForkCapabilityInstallJournal['status'],
        updatedAt: string,
      ): void => {
        world.journals.set(key, {
          ...base,
          key,
          status,
          updatedAt,
          ...(status === 'rollback-incomplete'
            ? { residual: ['Agent "Reviewer"'] }
            : {}),
        });
      };
      terminal('done', 'completed', '2026-10-21T00:00:00.000Z');
      terminal('undone', 'rolled-back', '2026-10-21T00:00:00.000Z');
      terminal(
        'residual-recent',
        'rollback-incomplete',
        '2026-10-21T00:00:00.000Z',
      );
      terminal(
        'residual-old',
        'rollback-incomplete',
        '2026-08-01T00:00:00.000Z',
      );
      await recoverForkCapabilityInstalls(depsFor(world));
      expect(Array.from(world.journals.keys())).toEqual(['residual-recent']);
    });
  });
});

// An installed pipeline runs through the ordinary package runtime: the
// executor snapshots the derived manifest's bindings and gives each step only
// the resources bound to that step. A step that runs a packaged child
// pipeline or project action must see it there, nested children included,
// or the run falls back to the recipient's own pipelines and actions.
describe('container-installed pipeline package at run time', () => {
  const RUNTIME_PIPELINE_YAML = [
    'name: Ship',
    'on: dispatch',
    'jobs:',
    '  review:',
    '    steps:',
    '      - id: lint',
    '        uses: project/review',
    '      - id: nested',
    '        uses: builtin/run-pipeline',
    '        with:',
    '          pipeline: child.yaml',
    '      - id: plain',
    '        run: echo done',
    '',
  ].join('\n');
  const CHILD_YAML = [
    'name: Child',
    'on: dispatch',
    'dependencies:',
    '  - id: github',
    '    kind: connector',
    '    connector: github',
    '    required: true',
    '    steps: [grand]',
    'jobs:',
    '  run:',
    '    steps:',
    '      - id: grand',
    '        uses: builtin/run-pipeline',
    '        with:',
    '          pipeline: grand.yaml',
    '',
  ].join('\n');
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'fork-pipeline-runtime-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function buildRuntimePackage(): Promise<ContainerPackage> {
    const pipelinesDir = path.join(root, 'pipelines');
    await mkdir(pipelinesDir, { recursive: true });
    await writeFile(path.join(pipelinesDir, 'child.yaml'), CHILD_YAML);
    await writeFile(
      path.join(pipelinesDir, 'grand.yaml'),
      'name: Grand\non: dispatch\njobs: {}\n',
    );
    const repoPath = path.join(root, 'repo');
    const actionsDir = getProjectActionsDirCandidates(repoPath)[0];
    if (!actionsDir) throw new Error('no project actions directory');
    await mkdir(path.join(actionsDir, 'review'), { recursive: true });
    await writeFile(
      path.join(actionsDir, 'review', 'action.yml'),
      'name: Packaged review\nruns:\n  using: composite\n  steps: []\n',
    );
    const pipeline = built(
      await buildPipelineDefinitionResource(
        {
          pipeline: { id: 'pipeline-local-2', source: 'user', name: 'Ship' },
          rawYaml: RUNTIME_PIPELINE_YAML,
          pipelineFileDir: pipelinesDir,
          repoPath,
        },
        builderDependencies(),
      ),
    );
    const analysis = await analyzeCapabilityPackage({
      rawContent: '{"container":"runtime"}',
      requests: [],
      invocableInventory: EMPTY_INVENTORY,
      definitionResources: [
        toCapabilityPackageDefinitionResourceInput(pipeline),
      ],
    });
    expect(analysis.summary.blockers).toEqual([]);
    const manifest = analysis.summary.manifest;
    if (!manifest) throw new Error('missing manifest');
    expect(manifest.resources.map((resource) => resource.kind).sort()).toEqual([
      'child_pipeline',
      'child_pipeline',
      'pipeline_action',
      'pipeline_definition',
    ]);
    return {
      digest: computePipelinePackageDigestSync(manifest),
      manifest,
      blobs: analysis.blobs,
      ids: {
        pipeline: pipeline.resourceId,
        agent: '',
        pipelineAutomation: '',
        promptAutomation: '',
        coworkAutomation: '',
        hook: '',
        skill: '',
        child: '',
      },
    };
  }

  it('gives each step its packaged child pipelines and actions through the executor resolvers', async () => {
    const pkg = await buildRuntimePackage();
    const world = newWorld(pkg);
    await expect(
      installForkCapabilityPackage(
        { request: forkRequest(pkg.digest), response: CODE_RESPONSE },
        depsFor(world),
      ),
    ).resolves.toEqual([]);
    const installed = Array.from(world.pipelines.values())[0];
    const overlay = installed?.overlay;
    if (!installed || !overlay) throw new Error('no overlay was installed');

    // Materialize and snapshot exactly as a run of the installed pipeline.
    const cachedPackagePath = await installPipelinePackageAtomically({
      packagesRoot: path.join(root, 'cache'),
      digest: overlay.digest,
      manifest: overlay.manifest,
      fetchBlob: (sha256) => {
        const bytes = pkg.blobs.get(sha256);
        return bytes
          ? Promise.resolve(bytes)
          : Promise.reject(new Error(`missing blob ${sha256}`));
      },
    });
    const executionDirectory = path.join(root, 'execution');
    await mkdir(executionDirectory, { recursive: true });
    const snapshot = await snapshotPipelinePackageForExecution({
      digest: overlay.digest,
      rawPipeline: installed.raw,
      manifest: overlay.manifest,
      cachedPackagePath,
      executionDirectory,
    });
    const runOverlay = await loadPipelinePackageExecutionOverlay(snapshot);
    if (!runOverlay) throw new Error('no run overlay');
    const stepOverlay = (
      stepId: string,
    ): ReturnType<typeof filterPipelinePackageOverlayForStep> =>
      filterPipelinePackageOverlayForStep(
        runOverlay,
        snapshot.bindings,
        'review',
        stepId,
      );

    // The child step sees its child and the child's own nested child.
    const nested = stepOverlay('nested');
    expect(
      nested?.resources.map((resource) => resource.invocationKeys).sort(),
    ).toEqual([['child.yaml'], ['grand.yaml']]);
    const emptyCwd = path.join(root, 'cwd');
    await mkdir(emptyCwd, { recursive: true });
    const child = await resolveChildPipeline({
      pipelineRef: 'child.yaml',
      cwd: emptyCwd,
      packageOverlay: nested,
    });
    expect(child).toMatchObject({ packaged: true });
    expect(child.pipeline.name).toBe('Child');
    // A child run inherits its parent step's overlay.
    const grand = await resolveChildPipeline({
      pipelineRef: 'grand.yaml',
      cwd: emptyCwd,
      packageOverlay: nested,
    });
    expect(grand).toMatchObject({ packaged: true });
    expect(grand.pipeline.name).toBe('Grand');

    // The action step sees only its packaged action, ahead of the
    // recipient's workspace actions.
    const lint = stepOverlay('lint');
    expect(lint?.resources.map((resource) => resource.kind)).toEqual([
      'pipeline_action',
    ]);
    const action = resolveActionRuntime(
      'project/review',
      {
        bundledActionsDir: path.join(root, 'builtin-actions'),
        getProjectActionsDir: () => path.join(root, 'workspace-actions'),
        getProjectActionsDirCandidates: () => [
          path.join(root, 'workspace-actions'),
        ],
      },
      path.join(root, 'recipient-repo'),
      lint,
    );
    expect(action?.definition.name).toBe('Packaged review');

    // A step that uses nothing packaged sees nothing.
    expect(stepOverlay('plain')).toBeUndefined();

    // The packaged child's declared requirement is checked before the run,
    // located at the parent step that runs it.
    expect(overlay.manifest.environmentRequirements).toEqual([
      expect.objectContaining({
        id: 'github',
        kind: 'connector',
        required: true,
        affectedSteps: [{ jobId: 'review', stepId: 'nested' }],
      }),
    ]);
  });
});

describe('fork capability install journal', () => {
  beforeEach(async () => {
    mockJournalDir = await mkdtemp(path.join(os.tmpdir(), 'fork-journal-'));
  });

  afterEach(async () => {
    await rm(mockJournalDir, { recursive: true, force: true });
  });

  it('round-trips through atomic writes and ignores unreadable files', async () => {
    const journal: ForkCapabilityInstallJournal = {
      version: 1,
      key: forkCapabilityInstallJournalKey('owner', 'pp:v1:digest'),
      ownerLocalId: 'owner',
      containerId: 'container-1',
      revisionId: 'revision-1',
      packageDigest: 'pp:v1:digest',
      destination: {
        projectId: 'project',
        worktreeId: 'worktree',
        containerType: 'CODE_WORKTREE',
      },
      attemptId: 'attempt-1',
      status: 'installing',
      startedAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      skills: [
        { resourceId: 'skill', localName: 'helper' },
        {
          resourceId: 'other',
          localName: 'other',
          created: true,
          files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64) }],
        },
      ],
      agents: [{ resourceId: 'agent', name: 'Reviewer' }],
      pipelines: [],
      automations: [],
      selections: {
        workspaceId: 'project',
        added: [{ sourceId: 'custom:app', skillName: 'helper' }],
      },
      environmentRequirements: [{ id: 'github', kind: 'connector' }],
    };
    await writeForkCapabilityInstallJournal(journal);
    await writeFile(path.join(mockJournalDir, 'broken.json'), '{');
    await expect(
      readForkCapabilityInstallJournal(journal.key),
    ).resolves.toEqual(journal);
    await expect(listForkCapabilityInstallJournals()).resolves.toEqual([
      journal,
    ]);
    // Never inside a checkout: the journal lives under the app data helper.
    const raw = await readFile(
      path.join(mockJournalDir, `${journal.key}.json`),
      'utf8',
    );
    expect(JSON.parse(raw)).toEqual(journal);
  });

  it('deletes a final journal and tolerates one that is already gone', async () => {
    const journal: ForkCapabilityInstallJournal = {
      version: 1,
      key: forkCapabilityInstallJournalKey('owner', 'pp:v1:digest'),
      ownerLocalId: 'owner',
      containerId: 'container-1',
      revisionId: 'revision-1',
      packageDigest: 'pp:v1:digest',
      destination: {
        projectId: 'project',
        worktreeId: 'worktree',
        containerType: 'CODE_WORKTREE',
      },
      status: 'completed',
      startedAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      skills: [],
      agents: [],
      pipelines: [],
      automations: [],
      environmentRequirements: [],
    };
    await writeForkCapabilityInstallJournal(journal);
    await deleteForkCapabilityInstallJournal(journal.key);
    await expect(
      readForkCapabilityInstallJournal(journal.key),
    ).resolves.toBeNull();
    await expect(
      deleteForkCapabilityInstallJournal(journal.key),
    ).resolves.toBeUndefined();
  });

  it('keeps the definition document format the installer reads', () => {
    // Guard against a silent change to the canonical encoding the plan
    // relies on: the installer rejects anything but canonical bytes.
    const bytes = encodeSharedContainerDefinitionDocument({
      version: 1,
      kind: 'agent_definition',
      references: [],
      agent: {
        version: 1,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review.',
        plugins: [],
      },
    });
    expect(new TextDecoder().decode(bytes)).toMatch(/^\{"agent":/);
  });
});

describe('rewriteAgentModelIds', () => {
  it('rewrites each source id once when a local id equals another source id', () => {
    // The recipient already has "Reviewer", so the package's
    // agent_model_reviewer becomes agent_model_reviewer_2, which is the id
    // of the package's second Agent, itself renamed to agent_model_reviewer_2_2.
    const yaml = [
      'first: agent_model_reviewer',
      'second: agent_model_reviewer_2',
      'routed: agent_model_reviewer@sonnet',
      'other: agent_model_reviewer_20',
      '',
    ].join('\n');
    expect(
      rewriteAgentModelIds(
        yaml,
        new Map([
          ['agent_model_reviewer', 'agent_model_reviewer_2'],
          ['agent_model_reviewer_2', 'agent_model_reviewer_2_2'],
        ]),
      ),
    ).toBe(
      [
        'first: agent_model_reviewer_2',
        'second: agent_model_reviewer_2_2',
        'routed: agent_model_reviewer_2@sonnet',
        'other: agent_model_reviewer_20',
        '',
      ].join('\n'),
    );
  });

  it('swaps two ids without either rewrite seeing the other', () => {
    expect(
      rewriteAgentModelIds(
        'a: agent_model_one\nb: agent_model_two\n',
        new Map([
          ['agent_model_one', 'agent_model_two'],
          ['agent_model_two', 'agent_model_one'],
        ]),
      ),
    ).toBe('a: agent_model_two\nb: agent_model_one\n');
  });

  it('matches whole ids only, preferring the longest', () => {
    expect(
      rewriteAgentModelIds(
        'x: agent_model_review_2\ny: agent_model_review\nz: my_agent_model_review\n',
        new Map([
          ['agent_model_review', 'agent_model_local'],
          ['agent_model_review_2', 'agent_model_local_2'],
        ]),
      ),
    ).toBe(
      'x: agent_model_local_2\ny: agent_model_local\nz: my_agent_model_review\n',
    );
  });
});

describe('rewriteSkillInvocationsInPrompt', () => {
  const renames = new Map([
    ['/helper', '/helper-2'],
    ['$helper', '$helper-2'],
  ]);

  it('keeps reference offsets aligned and leaves referenced text alone', () => {
    const prompt = 'Use /helper, read docs.md, then /helper again.';
    const docsStart = prompt.indexOf('docs.md');
    const result = rewriteSkillInvocationsInPrompt(
      prompt,
      [
        {
          textStart: docsStart,
          displayText: 'docs.md',
          kind: 'file',
          root: { kind: 'workspace' },
          relativePath: 'docs.md',
        },
      ],
      renames,
    );
    expect(result.prompt).toBe(
      'Use /helper-2, read docs.md, then /helper-2 again.',
    );
    const [reference] = result.references ?? [];
    expect(reference?.textStart).toBe(result.prompt.indexOf('docs.md'));
    expect(
      result.prompt.slice(
        reference?.textStart ?? 0,
        (reference?.textStart ?? 0) + (reference?.displayText.length ?? 0),
      ),
    ).toBe('docs.md');
  });

  it('never rewrites an invocation inside a reference span', () => {
    const prompt = 'Run /helper now';
    const result = rewriteSkillInvocationsInPrompt(
      prompt,
      [
        {
          textStart: 4,
          displayText: '/helper',
          kind: 'plugin',
          plugin: {
            kind: 'installed',
            marketplaceId: 'm',
            pluginName: 'p',
          },
        },
      ],
      renames,
    );
    expect(result.prompt).toBe(prompt);
    expect(result.references?.[0]?.textStart).toBe(4);
  });

  it('rewrites a prompt without references', () => {
    expect(
      rewriteSkillInvocationsInPrompt('Run $helper.', undefined, renames),
    ).toEqual({ prompt: 'Run $helper-2.' });
  });
});

describe('rewriteSkillInvocations', () => {
  it('rewrites whole invocations of either sigil in one pass', () => {
    const renames = new Map([
      ['/helper', '/helper-2'],
      ['$helper', '$helper-2'],
      // A local name that equals another packaged name is not rewritten twice.
      ['/helper-2', '/helper-2-2'],
    ]);
    expect(
      rewriteSkillInvocations(
        'Run /helper. Then $helper, /helper: go, and /helper-2.',
        renames,
      ),
    ).toBe('Run /helper-2. Then $helper-2, /helper-2: go, and /helper-2-2.');
  });

  it('leaves other tokens, paths and URLs alone', () => {
    const renames = new Map([
      ['/helper', '/helper-2'],
      ['$helper', '$helper-2'],
    ]);
    const text = [
      '/helper.md',
      '/helper:sub',
      '/helper_x',
      '$helper-x',
      './helper',
      '~/helper',
      'docs/helper',
      '/helper/',
      'https://example.com/helper',
      'key=/helper',
      'a$helper',
    ].join(' ');
    expect(rewriteSkillInvocations(text, renames)).toBe(text);
  });
});

describe('skillInvocationRenames', () => {
  function skillResource(
    id: string,
    invocationKeys: string[],
  ): PipelinePackageResource {
    return {
      id,
      kind: 'standalone_skill',
      displayName: id,
      sourceLabel: id,
      sourceVisibility: 'local',
      invocationKeys,
      dependencyResourceIds: [],
      trees: [],
    };
  }

  it('maps bare invocations of installed skills only', () => {
    const resources = [
      skillResource('claude', ['/helper']),
      skillResource('codex', ['$helper']),
      skillResource('namespaced', ['/kit:helper']),
      skillResource('missing', ['/absent']),
      skillResource('unchanged', ['/same']),
    ];
    expect(
      skillInvocationRenames(
        resources,
        resources.map((resource) => resource.id),
        new Map([
          ['claude', 'helper-2'],
          ['codex', 'helper-2'],
          ['namespaced', 'kit-helper'],
          ['unchanged', 'same'],
        ]),
      ),
    ).toEqual(
      new Map([
        ['/helper', '/helper-2'],
        ['$helper', '$helper-2'],
        ['/same', '/same'],
      ]),
    );
  });

  it('never guesses an invocation two installed skills map differently', () => {
    const resources = [
      skillResource('one', ['/helper']),
      skillResource('two', ['/helper']),
    ];
    expect(
      skillInvocationRenames(
        resources,
        ['one', 'two'],
        new Map([
          ['one', 'helper-2'],
          ['two', 'helper-3'],
        ]),
      ),
    ).toEqual(new Map());
  });
});

describe('deriveInstalledPipelineManifest skill bindings', () => {
  const ENTRY = {
    path: 'SKILL.md',
    sha256: 'a'.repeat(64),
    size: 1,
    mode: 'read' as const,
  };

  function resource(
    id: string,
    kind: PipelinePackageResource['kind'],
    invocationKeys: string[],
    provider: 'claude' | 'codex',
    extra: Partial<PipelinePackageResource> = {},
  ): PipelinePackageResource {
    return {
      id,
      kind,
      displayName: id,
      sourceLabel: id,
      sourceVisibility: 'local',
      invocationKeys,
      dependencyResourceIds: [],
      trees: [
        {
          provider,
          runtimeKind:
            kind === 'standalone_skill'
              ? 'standalone_skill'
              : 'plugin_fragment',
          rootName: id,
          entries: [ENTRY],
        },
      ],
      ...extra,
    };
  }

  const resources = [
    resource('helper-claude', 'standalone_skill', ['/helper'], 'claude', {
      dependencyResourceIds: ['shared'],
    }),
    resource('helper-codex', 'standalone_skill', ['$helper'], 'codex'),
    resource('shared', 'standalone_skill', ['/shared'], 'claude'),
    resource('inner', 'standalone_skill', ['/inner'], 'claude'),
    // Named by a GitHub dependency: the package keeps only the publisher's
    // local selection identity, which no portable key spells.
    resource('declared', 'standalone_skill', ['/declared'], 'claude', {
      installedItemRef: {
        kind: 'skill',
        sourceId: 'github:acme:skills',
        skillName: 'declared',
      },
    }),
    resource('child', 'child_pipeline', ['child.yaml'], 'claude'),
  ];
  const manifest: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: 'b'.repeat(64),
    resources,
    bindings: [],
    environmentRequirements: [],
    totalFiles: resources.length,
    totalBytes: resources.length,
  };
  const childPipeline = parsePipelineText(
    [
      'name: Child',
      'on: dispatch',
      'jobs:',
      '  inner:',
      '    steps:',
      '      - id: go',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          prompt: Use /inner.',
      '',
    ].join('\n'),
  );
  const installedPipeline = parsePipelineText(
    [
      'name: Ship',
      'on: dispatch',
      'dependencies:',
      '  - id: declared',
      '    kind: skill',
      '    required: true',
      '    steps: [deps]',
      '    ref:',
      '      type: skill',
      '      source:',
      '        type: github',
      '        repo: acme/skills',
      '      skill_name: declared',
      'jobs:',
      '  main:',
      '    steps:',
      '      - id: ask',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          prompt: Use /helper, not /helper.md or ./helper.',
      '      - id: codex',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          prompt: Use $helper.',
      '      - id: nested',
      '        uses: builtin/run-pipeline',
      '        with:',
      '          pipeline: child.yaml',
      '      - id: deps',
      '        uses: builtin/agent-prompt',
      '        with:',
      '          prompt: Review.',
      '      - id: plain',
      '        run: echo done',
      '',
    ].join('\n'),
  );
  // Codex for the `codex` step, Claude for every other: as the publisher read it.
  const providers = (pipeline: Pipeline): Record<string, 'claude' | 'codex'> =>
    Object.fromEntries(
      Object.entries(pipeline.jobs).flatMap(([jobId, job]) =>
        job.steps.map((step) => [
          `${jobId}.${step.id ?? ''}`,
          step.id === 'codex' ? 'codex' : 'claude',
        ]),
      ),
    );

  it("binds each step's packaged skills, a child's skills to the step that runs it, and dependencies to their steps", () => {
    const derived = deriveInstalledPipelineManifest(
      manifest,
      {
        overlayResourceIds: resources.map((item) => item.id),
        overlayChildPipelines: [
          { resourceId: 'child', pipeline: childPipeline },
        ],
      },
      { pipeline: installedPipeline, contentHash: 'b'.repeat(64) },
      providers,
    );
    expect(derived?.bindings).toEqual([
      // A skill's own dependencies are bound with it.
      {
        jobId: 'main',
        stepId: 'ask',
        resourceIds: ['helper-claude', 'shared'],
      },
      { jobId: 'main', stepId: 'codex', resourceIds: ['helper-codex'] },
      // A child run inherits this step's overlay, so it carries the
      // child's skills too.
      { jobId: 'main', stepId: 'nested', resourceIds: ['child', 'inner'] },
      { jobId: 'main', stepId: 'deps', resourceIds: ['declared'] },
    ]);
  });
});
