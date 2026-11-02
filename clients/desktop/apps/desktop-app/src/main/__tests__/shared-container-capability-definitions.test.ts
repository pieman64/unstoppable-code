// CAN-4655: portable definition builders for shared-container capability
// packages. Plugin, MCP and inventory lookups are injected; YAML parsing, the
// automation share sanitizer, the portable pipeline resource builder and the
// package analyzer are real.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeCapabilityPackage,
  capabilityPackageDefinitionResourceId,
} from '@canopy/desktop-shared/node';
import type {
  ChatTabPluginSelections,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { InvocableInventoryCache } from '@canopy/desktop-shared/types/invocable-inventory';
import { validatePipelinePackageManifest } from '@canopy/protocol/pipelines';
import {
  parseSharedContainerDefinitionDocument,
  type SharedContainerDefinitionDocument,
} from '@canopy/protocol/shared-containers';
import {
  buildPortablePipelineResources,
  capabilityInventoryEntryIdsByKey,
} from '../pipelines/pipeline-package-service';
import { getProjectActionsDirCandidates } from '../pipelines/config-paths';
import {
  agentDefinitionIdentity,
  buildAgentDefinitionResource,
  buildAutomationDefinitionResource,
  buildHookDefinitionResource,
  buildPipelineDefinitionResource,
  pipelineDefinitionIdentity,
  toCapabilityPackageDefinitionResourceInput,
  type SharedContainerDefinitionBuildResult,
  type SharedContainerDefinitionBuilderDependencies,
  type SharedContainerDefinitionResourceDraft,
} from '../shared-containers/capability-package/definitions';

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

function emptySelections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

function dependencies(
  overrides: Partial<SharedContainerDefinitionBuilderDependencies> = {},
): SharedContainerDefinitionBuilderDependencies {
  return {
    loadInventory: () =>
      Promise.resolve({ inventory: EMPTY_INVENTORY, sources: {} }),
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
        required: false,
        affectedSteps: [],
        setupHint: 'Set up this server.',
      }),
    ...overrides,
  };
}

function activity(action: ScheduledActivity['action']): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-local-1',
    name: 'Nightly review',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    lastRunAt: '2026-10-03T00:00:00.000Z',
    failureCount: 0,
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
    pluginSelections: emptySelections(),
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function built(
  result: SharedContainerDefinitionBuildResult,
): SharedContainerDefinitionResourceDraft {
  if (!result.resource)
    throw new Error(`Expected a resource, got ${result.reason}`);
  return result.resource;
}

function documentOf(
  resource: SharedContainerDefinitionResourceDraft,
): SharedContainerDefinitionDocument {
  const parsed = parseSharedContainerDefinitionDocument(resource.document);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.value;
}

describe('shared container definition builders', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'container-definitions-'));
    await writeFile(
      path.join(root, 'child.yaml'),
      'name: Child\non: dispatch\njobs: {}\n',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('pipelines', () => {
    it('carries portable YAML, its prompts, Agents and child pipelines', async () => {
      const resource = built(
        await buildPipelineDefinitionResource(
          {
            pipeline: {
              id: 'pipeline-local-1',
              source: 'user',
              name: 'Review',
              description: 'Reviews diffs.',
            },
            rawYaml: PIPELINE_YAML,
            origin: 'historical-snapshot',
            pipelineFileDir: root,
          },
          dependencies(),
        ),
      );
      expect(resource.identity).toBe(
        pipelineDefinitionIdentity('user', 'pipeline-local-1'),
      );
      expect(resource.resourceId).toBe(
        capabilityPackageDefinitionResourceId(
          'pipeline_definition',
          resource.identity,
        ),
      );
      const agentResourceId = capabilityPackageDefinitionResourceId(
        'agent_definition',
        agentDefinitionIdentity('agent_model_reviewer'),
      );
      expect(documentOf(resource)).toEqual({
        version: 1,
        kind: 'pipeline_definition',
        references: [agentResourceId],
        provenance: { historicalSnapshot: true },
        name: 'Review',
        description: 'Reviews diffs.',
        yaml: PIPELINE_YAML,
      });
      expect(resource.dependsOnIdentities).toEqual([
        agentDefinitionIdentity('agent_model_reviewer'),
      ]);
      expect(resource.promptTexts.map((text) => text.text)).toContain(
        'Run /helper on the diff.',
      );
      expect(resource.portableResources).toEqual([
        expect.objectContaining({
          kind: 'child_pipeline',
          invocationKeys: ['child.yaml'],
        }),
      ]);
    });

    it('omits pipelines it cannot make portable', async () => {
      await expect(
        buildPipelineDefinitionResource(
          {
            pipeline: { id: 'bundled-1', source: 'bundled', name: 'Bundled' },
            rawYaml: PIPELINE_YAML,
          },
          dependencies(),
        ),
      ).resolves.toEqual({ resource: undefined, reason: 'unsupported_source' });
      const invalid = await buildPipelineDefinitionResource(
        {
          pipeline: { id: 'p', source: 'user', name: 'Broken' },
          rawYaml: 'jobs: [',
        },
        dependencies(),
      );
      expect(invalid.resource).toBeUndefined();
      expect(invalid.resource === undefined && invalid.reason).toBe(
        'invalid_definition',
      );
      const leaked = await buildPipelineDefinitionResource(
        {
          pipeline: { id: 'p', source: 'user', name: 'Leaky' },
          rawYaml: PIPELINE_YAML.replace(
            'Run /helper on the diff.',
            'Use token ghp_abcdefghijklmnopqrstuvwxyz0123 here.',
          ),
        },
        dependencies(),
      );
      expect(leaked.resource === undefined && leaked.reason).toBe(
        'not_portable',
      );
    });

    it('omits a pipeline whose child pipeline routes through an Agent', async () => {
      // Child pipelines travel verbatim, so their Agent ids could not be
      // rewritten to the recipient's copies.
      await mkdir(path.join(root, 'nested'), { recursive: true });
      await writeFile(
        path.join(root, 'child.yaml'),
        [
          'name: Child',
          'on: dispatch',
          'jobs:',
          '  inner:',
          '    steps:',
          '      - id: deeper',
          '        uses: builtin/run-pipeline',
          '        with:',
          '          pipeline: nested/grandchild.yaml',
          '',
        ].join('\n'),
      );
      await writeFile(
        path.join(root, 'nested', 'grandchild.yaml'),
        [
          'name: Grandchild',
          'on: dispatch',
          'jobs:',
          '  inner:',
          '    steps:',
          '      - id: ask',
          '        uses: builtin/agent-prompt',
          '        with:',
          '          prompt: Check it.',
          '          model: agent_model_helper@sonnet',
          '',
        ].join('\n'),
      );
      await expect(
        buildPipelineDefinitionResource(
          {
            pipeline: { id: 'p', source: 'user', name: 'Review' },
            rawYaml: PIPELINE_YAML,
            pipelineFileDir: root,
          },
          dependencies(),
        ),
      ).resolves.toEqual({
        resource: undefined,
        reason: 'child_agent_routing',
        detail: 'nested/grandchild.yaml',
      });
    });

    it('omits a pipeline whose project action routes through an Agent', async () => {
      const repoPath = path.join(root, 'repo');
      const [actionsDir] = getProjectActionsDirCandidates(repoPath);
      if (!actionsDir) throw new Error('no project actions directory');
      await mkdir(path.join(actionsDir, 'triage'), { recursive: true });
      await writeFile(
        path.join(actionsDir, 'triage', 'action.yml'),
        [
          'name: Triage',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - uses: builtin/agent-prompt',
          '      with:',
          '        prompt: Triage it.',
          '        model: agent_model_helper',
          '',
        ].join('\n'),
      );
      const rawYaml = [
        'name: Triage',
        'on: dispatch',
        'jobs:',
        '  triage:',
        '    steps:',
        '      - id: act',
        '        uses: project/triage',
        '',
      ].join('\n');
      await expect(
        buildPipelineDefinitionResource(
          {
            pipeline: { id: 'p', source: 'project', name: 'Triage' },
            rawYaml,
            repoPath,
          },
          dependencies(),
        ),
      ).resolves.toEqual({
        resource: undefined,
        reason: 'child_agent_routing',
        detail: 'project/triage',
      });
      // The same action without an Agent travels with its pipeline.
      await writeFile(
        path.join(actionsDir, 'triage', 'action.yml'),
        'name: Triage\nruns:\n  using: composite\n  steps: []\n',
      );
      const plain = built(
        await buildPipelineDefinitionResource(
          {
            pipeline: { id: 'p', source: 'project', name: 'Triage' },
            rawYaml,
            repoPath,
          },
          dependencies(),
        ),
      );
      expect(plain.portableResources).toEqual([
        expect.objectContaining({ kind: 'pipeline_action' }),
      ]);
    });
  });

  describe('automations', () => {
    it('retargets a pipeline automation to the fork and names its packaged pipeline', async () => {
      const result = await buildAutomationDefinitionResource(
        {
          activity: activity({
            type: 'worktree_pipeline',
            workspaceId: 'workspace-local-1',
            baseWorktreeId: 'worktree-local-1',
            pipelineId: 'pipeline-local-1',
            pipelineSource: 'user',
            pipelineName: 'Review',
            repoId: 'repo-local-1',
            inputs: { token: 'not-shared' },
          }),
          containerType: 'code',
          pipelineYaml: PIPELINE_YAML,
        },
        dependencies(),
      );
      const resource = built(result);
      const pipelineResourceId = capabilityPackageDefinitionResourceId(
        'pipeline_definition',
        pipelineDefinitionIdentity('user', 'pipeline-local-1'),
      );
      const document = documentOf(resource);
      expect(document).toMatchObject({
        kind: 'automation_definition',
        references: [pipelineResourceId],
        target: { kind: 'source-container' },
        uses: { pipeline: pipelineResourceId },
        automation: {
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: { source: 'unresolved', name: 'Review' },
            inputKeys: ['token'],
          },
        },
      });
      const text = new TextDecoder().decode(resource.document);
      for (const local of [
        'workspace-local-1',
        'worktree-local-1',
        'repo-local-1',
        'activity-local-1',
        'not-shared',
        '2026-10-0',
      ]) {
        expect(text).not.toContain(local);
      }
      expect(resource.dependsOnIdentities).toEqual([
        pipelineDefinitionIdentity('user', 'pipeline-local-1'),
      ]);
      expect(result.resource && result.notices).toEqual(
        expect.arrayContaining([
          'input_values_stripped',
          'workspace_binding_stripped',
        ]),
      );
    });

    it('downgrades a Cowork chat automation and keeps its Agent and selections', async () => {
      const result = await buildAutomationDefinitionResource(
        {
          activity: activity({
            type: 'worktree_session_prompt',
            workspaceId: 'cowork-local-1',
            worktreeId: 'worktree-local-1',
            chatId: 'chat-local-1',
            prompt: 'Summarize with /helper.',
            model: 'agent_model_reviewer',
            approvalMode: 'full-access',
            pluginSelections: emptySelections({
              skillRefs: [{ sourceId: 'custom:app', skillName: 'helper' }],
              mcpServerRefs: [{ serverId: 'linear', configId: 'cfg-1' }],
            }),
          }),
          containerType: 'cowork',
        },
        dependencies(),
      );
      const resource = built(result);
      const agentResourceId = capabilityPackageDefinitionResourceId(
        'agent_definition',
        agentDefinitionIdentity('agent_model_reviewer'),
      );
      expect(documentOf(resource)).toMatchObject({
        references: [agentResourceId],
        uses: { agent: agentResourceId },
        automation: {
          action: {
            type: 'standalone_prompt',
            target: { kind: 'cowork' },
            prompt: 'Summarize with /helper.',
          },
        },
      });
      const text = new TextDecoder().decode(resource.document);
      expect(text).not.toContain('chat-local-1');
      expect(text).not.toContain('full-access');
      expect(text).not.toContain('cfg-1');
      expect(resource.requestKeys).toEqual([
        { key: 'skill:custom:app:helper', provider: 'claude', required: true },
        { key: 'skill:custom:app:helper', provider: 'codex', required: true },
      ]);
      expect(resource.environmentRequirements).toEqual([
        expect.objectContaining({ id: 'mcp:linear', kind: 'mcp' }),
      ]);
      expect(resource.dependsOnIdentities).toEqual([
        agentDefinitionIdentity('agent_model_reviewer'),
      ]);
    });

    it('omits automations that cannot target a forked container', async () => {
      const resume = await buildAutomationDefinitionResource(
        {
          activity: activity({
            type: 'pipeline_execution_resume',
            executionId: 'execution-local-1',
            statusReasonIds: [],
            provider: 'claude',
            purpose: 'usage_limit_resume',
            pipelineName: 'Review',
          }),
          containerType: 'code',
        },
        dependencies(),
      );
      expect(resume).toEqual({
        resource: undefined,
        reason: 'execution_bound',
      });
      const advisor = await buildAutomationDefinitionResource(
        {
          activity: activity({
            type: 'app_advisor_prompt',
            prompt: 'Check in.',
          }),
          containerType: 'code',
        },
        dependencies(),
      );
      expect(advisor).toEqual({
        resource: undefined,
        reason: 'not_container_targeted',
      });
      const unverified = await buildAutomationDefinitionResource(
        {
          activity: activity({
            type: 'worktree_pipeline',
            workspaceId: 'workspace-local-1',
            pipelineId: 'pipeline-local-1',
            pipelineSource: 'user',
          }),
          containerType: 'code',
        },
        dependencies(),
      );
      expect(unverified.resource === undefined && unverified.reason).toBe(
        'not_portable',
      );
    });
  });

  describe('Agents', () => {
    it('builds a validated shared Agent document with shareable references', async () => {
      const result = await buildAgentDefinitionResource(
        {
          agent: agentModel({
            pluginSelections: emptySelections({
              skillRefs: [{ sourceId: 'custom:app', skillName: 'helper' }],
              mcpHttpAuthPreferences: [],
            }),
          }),
        },
        dependencies({
          mapPluginSelectionsToPortable: () =>
            Promise.resolve({
              refs: [
                {
                  type: 'plugin',
                  marketplace: { type: 'github', repo: 'acme/plugins' },
                  plugin_name: 'browser',
                },
              ],
              mcpServers: [],
              unresolved: ['skill:custom:app/helper'],
            }),
        }),
      );
      const resource = built(result);
      expect(documentOf(resource)).toEqual({
        version: 1,
        kind: 'agent_definition',
        references: [],
        agent: {
          version: 1,
          id: 'agent_model_reviewer',
          name: 'Reviewer',
          baseModel: 'sonnet',
          instructions: 'Review with /helper before replying.',
          plugins: [
            {
              type: 'plugin',
              marketplace: { type: 'github', repo: 'acme/plugins' },
              plugin_name: 'browser',
            },
          ],
        },
      });
      expect(resource.identity).toBe(
        agentDefinitionIdentity('agent_model_reviewer'),
      );
      expect(resource.promptTexts).toEqual([
        { provider: 'claude', text: 'Review with /helper before replying.' },
      ]);
      expect(resource.requestKeys.map((request) => request.key)).toEqual([
        'skill:custom:app:helper',
        'skill:custom:app:helper',
      ]);
      expect(result.resource && result.notices).toEqual([
        'skill:custom:app/helper',
      ]);
    });

    it('refuses an Agent whose document does not validate', async () => {
      const result = await buildAgentDefinitionResource(
        { agent: agentModel({ instructions: 'Use /Users/alice/notes.md' }) },
        dependencies(),
      );
      expect(result.resource === undefined && result.reason).toBe(
        'not_portable',
      );
    });
  });

  describe('hooks', () => {
    it('names the repository portably and strips local bindings', async () => {
      const result = await buildHookDefinitionResource(
        {
          hook: {
            triggerName: 'pr:checks:fail',
            target: 'workspace-repo',
            actions: [
              { type: 'command', command: 'pnpm lint --fix', shell: {} },
              {
                type: 'chat',
                prompt: 'Fix the checks with /helper.',
                model: 'agent_model_reviewer',
                approvalMode: 'full-access',
                executionContext: 'local-owner',
                'if-command': 'git diff --quiet',
                pluginSelections: emptySelections({
                  skillRefs: [{ sourceId: 'custom:app', skillName: 'helper' }],
                }),
              },
              {
                type: 'chat',
                prompt: 'overlay',
                localPluginSelectionOverlay: true,
              },
              {
                type: 'pipeline',
                source: 'local',
                id: 'pipeline-local-1',
                inputs: { branch: 'hook-input-not-shared' },
              },
              { type: 'pipeline', source: 'project', id: 'ci/review.yaml' },
            ],
          },
          repository: {
            remoteUrl: 'https://user:secret@github.com/acme/api.git?x=1',
            layoutName: 'api',
          },
        },
        dependencies(),
      );
      const resource = built(result);
      const pipelineIdentity = pipelineDefinitionIdentity(
        'user',
        'pipeline-local-1',
      );
      const pipelineResourceId = capabilityPackageDefinitionResourceId(
        'pipeline_definition',
        pipelineIdentity,
      );
      const agentResourceId = capabilityPackageDefinitionResourceId(
        'agent_definition',
        agentDefinitionIdentity('agent_model_reviewer'),
      );
      expect(documentOf(resource)).toEqual({
        version: 1,
        kind: 'hook_definition',
        references: [agentResourceId, pipelineResourceId].sort(),
        triggerName: 'pr:checks:fail',
        target: {
          kind: 'workspace-repo',
          repository: {
            remoteUrl: 'https://github.com/acme/api.git',
            layoutName: 'api',
          },
        },
        actions: [
          { type: 'command', command: 'pnpm lint --fix' },
          {
            type: 'chat',
            prompt: 'Fix the checks with /helper.',
            agent: agentResourceId,
            ifCommand: 'git diff --quiet',
            plugins: [],
          },
          {
            type: 'pipeline',
            pipeline: { source: 'packaged', resourceId: pipelineResourceId },
          },
          {
            type: 'pipeline',
            pipeline: { source: 'project', path: 'ci/review.yaml' },
          },
        ],
      });
      expect(resource.dependsOnIdentities).toEqual(
        [
          agentDefinitionIdentity('agent_model_reviewer'),
          pipelineIdentity,
        ].sort(),
      );
      expect(new TextDecoder().decode(resource.document)).not.toContain(
        'hook-input-not-shared',
      );
      expect(result.resource && result.notices).toEqual([
        'approval_mode_stripped',
        'execution_context_stripped',
        'input_values_stripped',
        'local_overlay_stripped',
      ]);
    });

    it('omits hooks without a portable repository or trigger', async () => {
      await expect(
        buildHookDefinitionResource(
          {
            hook: {
              triggerName: 'pr:merged',
              target: 'workspace-repo',
              actions: [{ type: 'command', command: 'echo merged' }],
            },
          },
          dependencies(),
        ),
      ).resolves.toEqual({
        resource: undefined,
        reason: 'repository_unidentified',
      });
      await expect(
        buildHookDefinitionResource(
          {
            hook: {
              triggerName: 'custom:trigger',
              target: 'project',
              actions: [{ type: 'command', command: 'echo hi' }],
            },
          },
          dependencies(),
        ),
      ).resolves.toEqual({
        resource: undefined,
        reason: 'unsupported_trigger',
      });
    });
  });

  it('composes into one analyzed package with a complete dependency graph', async () => {
    const skillsRoot = path.join(root, 'skills');
    await mkdir(path.join(skillsRoot, 'helper'), { recursive: true });
    await writeFile(path.join(skillsRoot, 'helper', 'SKILL.md'), '# Helper\n');
    const deps = dependencies();
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
    const agent = built(
      await buildAgentDefinitionResource({ agent: agentModel() }, deps),
    );
    const automation = built(
      await buildAutomationDefinitionResource(
        {
          activity: activity({
            type: 'worktree_pipeline',
            workspaceId: 'workspace-local-1',
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
      },
      definitionResources: [automation, agent, pipeline].map((resource) =>
        toCapabilityPackageDefinitionResourceInput(resource),
      ),
    });
    expect(analysis.summary.blockers).toEqual([]);
    const manifest = analysis.summary.manifest;
    if (!manifest) throw new Error('missing manifest');
    expect(validatePipelinePackageManifest(manifest)).toEqual({ ok: true });
    const byId = new Map(
      manifest.resources.map((resource) => [resource.id, resource]),
    );
    const skill = manifest.resources.find(
      (resource) => resource.kind === 'standalone_skill',
    );
    const child = manifest.resources.find(
      (resource) => resource.kind === 'child_pipeline',
    );
    expect(skill && child).toBeTruthy();
    expect(byId.get(automation.resourceId)?.dependencyResourceIds).toEqual(
      [
        pipeline.resourceId,
        agent.resourceId,
        skill?.id ?? '',
        child?.id ?? '',
      ].sort(),
    );
  });
});
