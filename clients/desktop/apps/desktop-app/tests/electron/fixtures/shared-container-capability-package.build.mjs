/**
 * CAN-4655 fixture generator: a real Cowork shared-container capability
 * package for the Electron fork flow.
 *
 * The package comes from the production definition builders and the
 * production package analyzer, the same way
 * `src/main/__tests__/shared-container-capability-install.test.ts` builds
 * one, so the flow installs canonical documents rather than hand-written
 * approximations. It carries one standalone skill (with an executable
 * script), one Agent, one user pipeline with a child pipeline, one Cowork
 * automation and one hook.
 *
 * The output is checked in next to this file so the flow itself does not
 * need a TypeScript runner. This script loads the production TypeScript
 * through tsx's CommonJS API. Regenerate the fixture after a definition or
 * manifest format change, from the repository root:
 *
 *   node apps/desktop-app/tests/electron/fixtures/shared-container-capability-package.build.mjs
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(HERE, '../../..');
process.env.TSX_TSCONFIG_PATH ??= path.join(DESKTOP_ROOT, 'tsconfig.node.json');
const { require: tsxRequire } = await import('tsx/cjs/api');
const load = (specifier) => tsxRequire(specifier, import.meta.url);
const { analyzeCapabilityPackage, computePipelinePackageDigestSync } = load(
  '@canopy/desktop-shared/node',
);
const { buildPortablePipelineResources, capabilityInventoryEntryIdsByKey } =
  load('../../../src/main/pipelines/pipeline-package-service.ts');
const {
  buildAgentDefinitionResource,
  buildAutomationDefinitionResource,
  buildHookDefinitionResource,
  buildPipelineDefinitionResource,
  toCapabilityPackageDefinitionResourceInput,
} = load(
  '../../../src/main/shared-containers/capability-package/definitions.ts',
);

const OUTPUT = path.join(HERE, 'shared-container-capability-package.json');

const SKILL_NAME = 'customer-helper';
const AGENT_NAME = 'Customer reviewer';
const PIPELINE_NAME = 'Customer review';
const AUTOMATION_NAME = 'Weekly customer summary';

const PIPELINE_YAML = [
  `name: ${PIPELINE_NAME}`,
  'on: dispatch',
  'jobs:',
  '  review:',
  '    steps:',
  '      - id: loop',
  '        uses: builtin/agent-prompt',
  '        with:',
  `          prompt: Run /${SKILL_NAME} on the follow-up.`,
  '          model: agent_model_customer_reviewer',
  '      - id: nested',
  '        uses: builtin/run-pipeline',
  '        with:',
  '          pipeline: child.yaml',
  '',
].join('\n');

const EMPTY_INVENTORY = {
  version: 2,
  builtAt: new Date(0).toISOString(),
  entries: [],
};

function selections(overrides = {}) {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

function builderDependencies() {
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

function built(result) {
  if (!result.resource)
    throw new Error(`Expected a resource, got ${result.reason}`);
  return result.resource;
}

function coworkActivity() {
  return {
    version: 1,
    id: 'activity-cowork',
    name: AUTOMATION_NAME,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * 1', timezone: 'local' },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'cowork-local-1',
      worktreeId: 'entry-local-1',
      chatId: 'chat-local-1',
      prompt: `Summarize the week with /${SKILL_NAME}.`,
      pluginSelections: selections({
        skillRefs: [{ sourceId: 'custom:app', skillName: SKILL_NAME }],
      }),
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    failureCount: 0,
  };
}

async function main() {
  // A fixed source directory: the child pipeline's package label derives
  // from it, so a random temporary name would change the digest every run.
  const root = path.join(os.tmpdir(), 'canopy-can4655-capability-package');
  await rm(root, { recursive: true, force: true });
  try {
    const skillsRoot = path.join(root, 'skills');
    const skillDir = path.join(skillsRoot, SKILL_NAME);
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${SKILL_NAME}\ndescription: Summarize a customer follow-up.\n---\n\n# Customer helper\n\nSummarize the follow-up in three bullets.\n`,
    );
    const script = path.join(skillDir, 'scripts', 'summarize.sh');
    await writeFile(script, '#!/bin/sh\necho "summary"\n');
    await chmod(script, 0o755);
    await writeFile(
      path.join(root, 'child.yaml'),
      'name: Customer review child\non: dispatch\njobs: {}\n',
    );

    const deps = builderDependencies();
    const pipeline = built(
      await buildPipelineDefinitionResource(
        {
          pipeline: {
            id: 'pipeline-local-1',
            source: 'user',
            name: PIPELINE_NAME,
          },
          rawYaml: PIPELINE_YAML,
          pipelineFileDir: root,
        },
        deps,
      ),
    );
    const agent = built(
      await buildAgentDefinitionResource(
        {
          agent: {
            id: 'agent_model_customer_reviewer',
            name: AGENT_NAME,
            baseModel: 'sonnet',
            instructions: `Review with /${SKILL_NAME} before replying.`,
            pluginSelections: selections(),
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
        },
        deps,
      ),
    );
    const automation = built(
      await buildAutomationDefinitionResource(
        { activity: coworkActivity(), containerType: 'cowork' },
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
    const skillEntry = (provider) => ({
      id: `${SKILL_NAME}-${provider}`,
      provider,
      kind: 'skill',
      name: SKILL_NAME,
      displayName: SKILL_NAME,
      description: '',
      insertText: `${provider === 'claude' ? '/' : '$'}${SKILL_NAME} `,
      invocationKey: `${provider === 'claude' ? '/' : '$'}${SKILL_NAME}`,
      enableRef: {
        kind: 'skill',
        sourceId: 'custom:app',
        skillName: SKILL_NAME,
      },
    });
    const skillSource = {
      sourceRoot: skillsRoot,
      memberPath: SKILL_NAME,
      sourceVisibility: 'local',
      runtimeKind: 'standalone_skill',
      rootName: SKILL_NAME,
    };
    const analysis = await analyzeCapabilityPackage({
      rawContent: '{"container":"customer-follow-up"}',
      requests: [],
      invocableInventory: {
        ...EMPTY_INVENTORY,
        entries: [skillEntry('claude'), skillEntry('codex')],
      },
      sourceByInventoryEntryId: {
        [`${SKILL_NAME}-claude`]: skillSource,
        [`${SKILL_NAME}-codex`]: skillSource,
      },
      definitionResources: [pipeline, agent, automation, hook].map((resource) =>
        toCapabilityPackageDefinitionResourceInput(resource),
      ),
    });
    if (analysis.summary.blockers.length > 0)
      throw new Error(
        `Package blockers: ${JSON.stringify(analysis.summary.blockers)}`,
      );
    const manifest = analysis.summary.manifest;
    if (!manifest) throw new Error('The analyzer produced no manifest.');
    const blobs = {};
    for (const [sha256, bytes] of analysis.blobs)
      blobs[sha256] = Buffer.from(bytes).toString('base64');
    const fixture = {
      generatedBy:
        'apps/desktop-app/tests/electron/fixtures/shared-container-capability-package.build.mjs',
      names: {
        skill: SKILL_NAME,
        agent: AGENT_NAME,
        pipeline: PIPELINE_NAME,
        automation: AUTOMATION_NAME,
      },
      resourceIds: {
        pipeline: pipeline.resourceId,
        agent: agent.resourceId,
        automation: automation.resourceId,
        hook: hook.resourceId,
      },
      digest: computePipelinePackageDigestSync(manifest),
      manifest,
      blobs,
    };
    await writeFile(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${OUTPUT} (${fixture.digest})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
