import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePipelinePackageManifest } from '@canopy/protocol/pipelines';
import type { Pipeline } from '../../../types/pipeline';
import type {
  InvocableInventoryCache,
  InvocableInventoryEntry,
} from '../../../types/invocable-inventory';
import type { AutomationPipelineInventoryEntry } from '../automation-pipeline-references';
import {
  analyzeCapabilityPackage,
  type AutomationPipelinePortableInput,
  type CapabilityPackageAnalysisInternal,
  type CapabilityPackagePromptSource,
  type FileAssetPortableInput,
  analyzePipelinePackage,
  buildPipelineCapabilityPackageSources,
  pipelinePackageAnalysisIsStale,
} from '../package-analyzer';

function pipeline(prompt: string): Pipeline {
  return {
    name: 'Example',
    on: 'dispatch',
    jobs: {
      review: {
        steps: [
          {
            id: 'loop',
            uses: 'builtin/agent-prompt',
            with: { prompt },
          },
        ],
      },
    },
  };
}

describe('analyzePipelinePackage', () => {
  it('keeps provider-specific capability resources on a generic binding key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-package-request-'));
    try {
      await mkdir(join(root, 'claude-skill'), { recursive: true });
      await mkdir(join(root, 'codex-skill'), { recursive: true });
      await writeFile(join(root, 'claude-skill', 'SKILL.md'), '# Helper\n');
      await writeFile(join(root, 'codex-skill', 'SKILL.md'), '# Helper\n');
      const result = await analyzeCapabilityPackage({
        rawContent: '{"automation":"example"}',
        requests: [
          {
            key: 'skill:custom:local-helper',
            provider: 'claude',
            required: true,
            bindingKey: 'automation\0action',
          },
          {
            key: 'skill:custom:local-helper',
            provider: 'codex',
            required: true,
            bindingKey: 'automation\0action',
          },
        ],
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'local-helper-claude',
              provider: 'claude',
              kind: 'skill',
              name: 'local-helper',
              displayName: 'Local helper',
              description: '',
              insertText: '/local-helper ',
              invocationKey: '/local-helper',
              enableRef: {
                kind: 'skill',
                sourceId: 'custom',
                skillName: 'local-helper',
              },
            },
            {
              id: 'local-helper-codex',
              provider: 'codex',
              kind: 'skill',
              name: 'local-helper',
              displayName: 'Local helper',
              description: '',
              insertText: '$local-helper ',
              invocationKey: '$local-helper',
              enableRef: {
                kind: 'skill',
                sourceId: 'custom',
                skillName: 'local-helper',
              },
            },
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'skill:custom:local-helper': [
            'local-helper-claude',
            'local-helper-codex',
          ],
        },
        sourceByInventoryEntryId: {
          'local-helper-claude': {
            sourceRoot: root,
            memberPath: 'claude-skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'local-helper',
          },
          'local-helper-codex': {
            sourceRoot: root,
            memberPath: 'codex-skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'local-helper',
          },
        },
      });

      expect(result.summary.state).toBe('ready');
      expect(result.summary.manifest?.bindings).toEqual([
        {
          jobId: 'automation',
          stepId: 'action',
          resourceIds: [expect.any(String), expect.any(String)],
        },
      ]);
      expect(
        result.summary.manifest?.resources.flatMap((resource) =>
          resource.trees.map((tree) => tree.provider),
        ),
      ).toEqual(['claude', 'codex']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires every requested provider to have a matching capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-package-provider-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Local helper\n');
      const result = await analyzeCapabilityPackage({
        rawContent: '{"automation":"example"}',
        requests: [
          {
            key: 'skill:custom:local-helper',
            provider: 'claude',
            required: true,
            bindingKey: 'automation\0action',
          },
          {
            key: 'skill:custom:local-helper',
            provider: 'codex',
            required: true,
            bindingKey: 'automation\0action',
          },
        ],
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'local-helper',
              provider: 'claude',
              kind: 'skill',
              name: 'local-helper',
              displayName: 'Local helper',
              description: '',
              insertText: '/local-helper ',
              invocationKey: '/local-helper',
              enableRef: {
                kind: 'skill',
                sourceId: 'custom',
                skillName: 'local-helper',
              },
            },
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'skill:custom:local-helper': ['local-helper'],
        },
        sourceByInventoryEntryId: {
          'local-helper': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'local-helper',
          },
        },
      });

      expect(result.summary.state).toBe('blocked');
      const missingProvider = result.summary.blockers.find(
        (blocker) => blocker.code === 'MISSING_DEPENDENCY_SOURCE',
      );
      expect(missingProvider?.message).toContain('codex');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores unresolved path-shaped prompt tokens but keeps real missing commands', async () => {
    const result = await analyzePipelinePackage({
      rawPipeline: 'name: Example\n',
      pipeline: pipeline(
        'Run /collect.py and read /quality-control-structural-v2.json, then use /missing-command.',
      ),
      providerByStep: { 'review.loop': 'claude' },
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
    });

    expect(result.summary.blockers).toHaveLength(1);
    expect(result.summary.blockers[0]).toMatchObject({
      code: 'UNRESOLVED_INVOCATION',
      subject: '/missing-command',
      origin: 'direct',
      occurrences: [{ jobId: 'review', stepId: 'loop' }],
      dismissal: { provider: 'claude', token: '/missing-command' },
    });
    expect(result.summary.manifest).toBeDefined();
  });

  it('ignores path-shaped tokens even when the prefix matches an installed command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-path-token-'));
    try {
      await mkdir(join(root, 'commands'), { recursive: true });
      await writeFile(join(root, 'commands', 'scripts.md'), '# Scripts\n');
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Run ./scripts/run and $HOME/bin/tool.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'scripts-command',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'scripts',
              displayName: '/scripts',
              description: '',
              insertText: '/scripts ',
              invocationKey: '/scripts',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'tools',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'scripts-command': {
            sourceRoot: root,
            memberPath: 'commands/scripts.md',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'tools',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.manifest?.resources).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('packages an exact dot-named command instead of treating it as a file path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-dot-command-'));
    try {
      await mkdir(join(root, 'commands'), { recursive: true });
      await writeFile(
        join(root, 'commands', 'collect.py.md'),
        '# Collect data\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /collect.py to gather the results.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'collect-command',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'collect.py',
              displayName: '/collect.py',
              description: '',
              insertText: '/collect.py ',
              invocationKey: '/collect.py',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'tools',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'collect-command': {
            sourceRoot: root,
            memberPath: 'commands/collect.py.md',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'tools',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.manifest?.resources).toEqual([
        expect.objectContaining({ invocationKeys: ['/collect.py'] }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated unresolved invocations and records every occurrence', async () => {
    const repeated: Pipeline = {
      name: 'Repeated',
      on: 'dispatch',
      jobs: {
        review: {
          steps: [
            {
              id: 'one',
              uses: 'builtin/agent-prompt',
              with: { prompt: '/gone' },
            },
            {
              id: 'two',
              uses: 'builtin/agent-prompt',
              with: { prompt: '/gone' },
            },
          ],
        },
      },
    };
    const result = await analyzePipelinePackage({
      rawPipeline: 'name: Repeated\n',
      pipeline: repeated,
      providerByStep: { 'review.one': 'claude', 'review.two': 'claude' },
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
    });

    expect(result.summary.blockers).toHaveLength(1);
    expect(result.summary.blockers[0]?.occurrences).toEqual([
      { jobId: 'review', stepId: 'one' },
      { jobId: 'review', stepId: 'two' },
    ]);
  });

  it('turns dismissed prompt invocations into publisher notes without selecting resources', async () => {
    const result = await analyzePipelinePackage({
      rawPipeline: 'name: Example\n',
      pipeline: pipeline('Run /not-a-command.'),
      providerByStep: { 'review.loop': 'claude' },
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
      dismissedInvocations: [{ provider: 'claude', token: '/not-a-command' }],
    });

    expect(result.summary.state).toBe('ready');
    expect(result.summary.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/not-a-command' },
    ]);
    expect(result.summary.manifest?.publisherNotes).toEqual([
      expect.objectContaining({
        kind: 'not_a_command',
        label: '/not-a-command',
        affectedSteps: [{ jobId: 'review', stepId: 'loop' }],
      }),
    ]);
    const directNoteId = result.summary.manifest?.publisherNotes?.[0]?.id;
    expect(directNoteId).toBeDefined();
    expect(result.publisherNoteSources?.[directNoteId ?? '']).toEqual({
      direct: true,
      resourceIds: [],
    });
    expect(result.summary.manifest?.resources).toEqual([]);
  });

  it('resolves a previously dismissed invocation when it becomes available', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-dismissed-ready-'),
    );
    try {
      await mkdir(join(root, 'commands'), { recursive: true });
      await writeFile(join(root, 'commands', 'deploy.md'), '# Deploy\n');
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Run /deploy.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'deploy-command',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'deploy',
              displayName: '/deploy',
              description: '',
              insertText: '/deploy ',
              invocationKey: '/deploy',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'tools',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'deploy-command': {
            sourceRoot: root,
            memberPath: 'commands/deploy.md',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'tools',
          },
        },
        dismissedInvocations: [{ provider: 'claude', token: '/deploy' }],
      });

      expect(result.summary.state).toBe('ready');
      expect(result.summary.dismissedInvocations).toEqual([]);
      expect(result.summary.manifest?.publisherNotes).toBeUndefined();
      expect(result.summary.manifest?.resources).toEqual([
        expect.objectContaining({ invocationKeys: ['/deploy'] }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scopes dismissed invocations to their provider', async () => {
    const mixedProviderPipeline: Pipeline = {
      name: 'Mixed providers',
      on: 'dispatch',
      jobs: {
        review: {
          steps: [
            {
              id: 'claude_step',
              uses: 'builtin/agent-prompt',
              with: { prompt: 'Run /shared-token.' },
            },
            {
              id: 'codex_step',
              uses: 'builtin/agent-prompt',
              with: { prompt: 'Run /shared-token.' },
            },
          ],
        },
      },
    };
    const result = await analyzePipelinePackage({
      rawPipeline: 'name: Mixed providers\n',
      pipeline: mixedProviderPipeline,
      providerByStep: {
        'review.claude_step': 'claude',
        'review.codex_step': 'codex',
      },
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
      dismissedInvocations: [{ provider: 'claude', token: '/shared-token' }],
    });

    expect(result.summary.state).toBe('blocked');
    expect(result.summary.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/shared-token' },
    ]);
    expect(result.summary.blockers).toEqual([
      expect.objectContaining({
        subject: '/shared-token',
        dismissal: { provider: 'codex', token: '/shared-token' },
        occurrences: [{ jobId: 'review', stepId: 'codex_step' }],
      }),
    ]);
    expect(result.summary.manifest?.publisherNotes).toEqual([
      expect.objectContaining({
        label: '/shared-token',
        affectedSteps: [{ jobId: 'review', stepId: 'claude_step' }],
      }),
    ]);
  });

  it('keeps affected steps on dismissals inside nested dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-dismissed-'));
    try {
      await mkdir(join(root, 'skills', 'root'), { recursive: true });
      await mkdir(join(root, 'skills', 'middle'), { recursive: true });
      await writeFile(
        join(root, 'skills', 'root', 'SKILL.md'),
        'Invoke $review:middle.\n',
      );
      await writeFile(
        join(root, 'skills', 'middle', 'SKILL.md'),
        'Mention $not-a-command in the prompt.\n',
      );
      const inventory = {
        version: 5 as const,
        builtAt: new Date().toISOString(),
        entries: ['root', 'middle'].map((name) => ({
          id: `review-${name}`,
          provider: 'codex' as const,
          kind: 'plugin_skill' as const,
          name,
          displayName: `$review:${name}`,
          description: '',
          insertText: `$review:${name} `,
          invocationKey: `$review:${name}`,
          enableRef: {
            kind: 'plugin' as const,
            marketplaceId: 'private',
            pluginName: 'review',
          },
        })),
      };
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $review:root.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: inventory,
        sourceByInventoryEntryId: {
          'review-root': {
            sourceRoot: root,
            memberPath: 'skills/root',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
          'review-middle': {
            sourceRoot: root,
            memberPath: 'skills/middle',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
        dismissedInvocations: [{ provider: 'codex', token: '$not-a-command' }],
      });

      expect(result.summary.manifest?.publisherNotes).toEqual([
        expect.objectContaining({
          label: '$not-a-command',
          affectedSteps: [{ jobId: 'review', stepId: 'loop' }],
        }),
      ]);
      const transitiveNoteId = result.summary.manifest?.publisherNotes?.[0]?.id;
      const middleResourceId = result.summary.manifest?.resources.find(
        (resource) => resource.invocationKeys.includes('$review:middle'),
      )?.id;
      expect(transitiveNoteId).toBeDefined();
      expect(middleResourceId).toBeDefined();
      expect(result.publisherNoteSources?.[transitiveNoteId ?? '']).toEqual({
        direct: false,
        resourceIds: [middleResourceId],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an oversized repo-local skill before retaining its bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-large-repo-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(
        join(root, 'skill', 'SKILL.md'),
        new Uint8Array(4 * 1024 * 1024 + 1),
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /large-skill.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: { version: 5, builtAt: '', entries: [] },
        repoLocalInvocables: {
          entries: [
            {
              id: 'repo:claude:standalone_skill:large-skill',
              provider: 'claude',
              kind: 'standalone_skill',
              invocationKey: '/large-skill',
              displayName: '/large-skill',
              sourceLabel: 'repo',
            },
          ],
          scannedDirectories: [],
        },
        sourceByRepoLocalEntryId: {
          'repo:claude:standalone_skill:large-skill': {
            sourceRoot: join(root, 'skill'),
            memberPath: '.',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'large-skill',
          },
        },
      });

      // The publisher must be told WHICH file to leave out, not handed a
      // byte count or a generic safety failure.
      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'PACKAGE_LIMIT_EXCEEDED',
          limit: 'file_size',
          subject: 'large-skill/SKILL.md',
          relativePath: 'SKILL.md',
        }),
      );
      expect(result.blobs.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('names the largest file when a share passes the total-size limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-total-'));
    try {
      await mkdir(join(root, 'skill', 'assets'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Big skill\n');
      // Nine files just under the per-file cap pass 32 MiB on the ninth. The
      // biggest one is what the publisher should exclude, not whichever file
      // happened to be read last.
      for (let index = 0; index < 9; index += 1) {
        const size = 4 * 1024 * 1024 - (index === 3 ? 0 : 1024);
        await writeFile(
          join(root, 'skill', 'assets', `part-${String(index)}.bin`),
          new Uint8Array(size),
        );
      }
      const result = await analyzeCapabilityPackage({
        rawContent: '# Big skill\n',
        invocableInventory: { version: 5, builtAt: '', entries: [] },
        requests: [],
        repoLocalInvocables: {
          entries: [
            {
              id: 'repo:claude:standalone_skill:big-skill',
              provider: 'claude',
              kind: 'standalone_skill',
              invocationKey: '/big-skill',
              displayName: '/big-skill',
              sourceLabel: 'repo',
            },
          ],
          scannedDirectories: [],
        },
        sourceByRepoLocalEntryId: {
          'repo:claude:standalone_skill:big-skill': {
            sourceRoot: join(root, 'skill'),
            memberPath: '.',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'big-skill',
          },
        },
        promptSources: [
          { target: 'subject', provider: 'claude', text: 'Use /big-skill.' },
        ],
      });

      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'PACKAGE_LIMIT_EXCEEDED',
          limit: 'total_size',
          subject: 'big-skill/assets/part-3.bin',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Writing and hashing ~36 MiB outruns the default 5s on loaded CI runners.
  }, 30_000);

  it('resolves an exact provider invocation and packages only its member directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-'));
    try {
      await mkdir(join(root, 'commands', 'review-loop'), { recursive: true });
      await writeFile(
        join(root, 'commands', 'review-loop', 'COMMAND.md'),
        '# Review loop\n\nSee https://github.com/example/review-loop.\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /review-loop to review this.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'review-loop',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'review-loop',
              displayName: '/review-loop',
              description: '',
              insertText: '/review-loop ',
              invocationKey: '/review-loop',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'review',
              },
              sourceLabel: 'review',
            },
          ],
        },
        sourceByInventoryEntryId: {
          'review-loop': {
            sourceRoot: root,
            memberPath: 'commands/review-loop',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
      });
      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.state).toBe('ready');
      expect(result.summary.manifest?.resources[0]).toMatchObject({
        displayName: '/review-loop',
        sourceVisibility: 'private',
      });
      expect(result.summary.manifest?.totalFiles).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits a minimal plugin manifest without executable or repository configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-manifest-'));
    try {
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await mkdir(join(root, 'commands'), { recursive: true });
      await mkdir(join(root, 'private-commands'), { recursive: true });
      await writeFile(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'review',
          version: '1.2.3',
          description: 'Review commands',
          author: { name: 'Private Author' },
          homepage: 'https://private.example.test/review',
          repository: 'ssh://git@private.example.test/review.git',
          hooks: './hooks/hooks.json',
          mcpServers: './.mcp.json',
          lspServers: './.lsp.json',
          commands: ['./commands', './private-commands'],
        }),
      );
      await writeFile(
        join(root, 'commands', 'review-loop.md'),
        '# Review loop\n',
      );
      await writeFile(
        join(root, 'private-commands', 'undeclared.md'),
        '# Must not be exported\n',
      );

      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /review-loop to review this.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'review-loop',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'review-loop',
              displayName: '/review-loop',
              description: '',
              insertText: '/review-loop ',
              invocationKey: '/review-loop',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'review',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'review-loop': {
            sourceRoot: root,
            memberPath: 'commands/review-loop.md',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      const manifestEntry =
        result.summary.manifest?.resources[0]?.trees[0]?.entries.find(
          (entry) => entry.path === '.claude-plugin/plugin.json',
        );
      expect(manifestEntry).toBeDefined();
      const manifestBytes = manifestEntry
        ? result.blobs.get(manifestEntry.sha256)
        : undefined;
      expect(manifestBytes).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(manifestBytes))).toStrictEqual(
        {
          name: 'review',
          version: '1.2.3',
          description: 'Review commands',
        },
      );
      expect(
        result.summary.manifest?.resources[0]?.trees[0]?.entries.map(
          (entry) => entry.path,
        ),
      ).not.toContain('private-commands/undeclared.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['quoted JSON assignment', '{"api_key":"abcdefghijklmnop"}'],
    ['GitHub token', `github_pat_${'a'.repeat(40)}`],
    ['AWS access key', `AKIA${'A'.repeat(16)}`],
    ['Slack token', `xoxb-${'a'.repeat(24)}`],
    ['authorization header', `Authorization: Bearer ${'a'.repeat(24)}`],
    [
      'control-character-obfuscated assignment',
      'api\u0000_key=abcdefghijklmnop',
    ],
  ])('blocks a %s without returning its value', async (_label, secret) => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-secret-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), secret);
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $secret-skill now.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'secret-skill',
              provider: 'codex',
              kind: 'skill',
              name: 'secret-skill',
              displayName: '$secret-skill',
              description: '',
              insertText: '$secret-skill ',
              invocationKey: '$secret-skill',
              enableRef: {
                kind: 'skill',
                sourceId: 'local',
                skillName: 'secret-skill',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'secret-skill': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'secret-skill',
          },
        },
      });
      expect(result.summary.state).toBe('blocked');
      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'SUSPECTED_SECRET',
          relativePath: 'SKILL.md',
        }),
      );
      expect(result.summary.manifest).toBeDefined();
      expect(JSON.stringify(result.summary)).not.toContain(secret);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('packages repo-local commands ahead of inventory and tracks additions as stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-repo-'));
    const repoClaude = join(root, '.claude');
    const commandsDir = join(repoClaude, 'commands');
    const globalRoot = join(root, 'global');
    try {
      await mkdir(commandsDir, { recursive: true });
      await mkdir(join(repoClaude, '.claude-plugin'), { recursive: true });
      await mkdir(join(globalRoot, 'commands'), { recursive: true });
      await writeFile(join(commandsDir, 'repair-diffs.md'), '# Repo repair\n');
      await writeFile(
        join(globalRoot, 'commands', 'repair-diffs.md'),
        '# Global repair\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /repair-diffs.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'global-repair',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'repair-diffs',
              displayName: '/repair-diffs',
              description: '',
              insertText: '/repair-diffs ',
              invocationKey: '/repair-diffs',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'global',
                pluginName: 'global-tools',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'global-repair': {
            sourceRoot: globalRoot,
            memberPath: 'commands/repair-diffs.md',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'global-tools',
          },
        },
        repoLocalInvocables: {
          entries: [
            {
              id: 'repo:claude:plugin_command:repair-diffs',
              provider: 'claude',
              kind: 'plugin_command',
              invocationKey: '/repair-diffs',
              displayName: '/repair-diffs',
              sourceLabel: 'repo',
            },
          ],
          scannedDirectories: [commandsDir],
        },
        sourceByRepoLocalEntryId: {
          'repo:claude:plugin_command:repair-diffs': {
            sourceRoot: repoClaude,
            memberPath: 'commands/repair-diffs.md',
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'repo',
            syntheticManifestName: 'repo',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.repoLocalScope).toEqual({
        entryCount: 1,
        scannedDirectoryCount: 1,
      });
      expect(result.summary.manifest?.resources).toHaveLength(1);
      expect(result.summary.manifest?.resources[0]).toMatchObject({
        sourceLabel: 'repo',
        sourceVisibility: 'local',
      });
      expect(
        result.summary.manifest?.resources[0]?.trees[0]?.entries.map(
          (entry) => entry.path,
        ),
      ).toEqual(
        expect.arrayContaining([
          '.claude-plugin/plugin.json',
          'commands/repair-diffs.md',
        ]),
      );

      await expect(pipelinePackageAnalysisIsStale(result)).resolves.toBe(false);
      await writeFile(
        join(repoClaude, '.claude-plugin', 'plugin.json'),
        '{"name":"repo-real"}\n',
      );
      await expect(pipelinePackageAnalysisIsStale(result)).resolves.toBe(true);
      await rm(join(repoClaude, '.claude-plugin', 'plugin.json'));

      await writeFile(join(commandsDir, 'new-command.md'), '# New\n');
      await expect(pipelinePackageAnalysisIsStale(result)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks analysis stale when the first repo-local command root appears', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-new-repo-root-'),
    );
    const repoClaude = join(root, '.claude');
    try {
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Read /foo.v2.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [],
        },
        repoLocalInvocables: {
          entries: [],
          scannedDirectories: [repoClaude],
        },
      });

      await expect(pipelinePackageAnalysisIsStale(result)).resolves.toBe(false);
      await mkdir(join(repoClaude, 'commands'), { recursive: true });
      await writeFile(join(repoClaude, 'commands', 'foo.v2.md'), '# Foo\n');
      await expect(pipelinePackageAnalysisIsStale(result)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores nonexistent prose paths while packaging real support files', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-prose-references-'),
    );
    try {
      await mkdir(join(root, 'skill', 'references'), { recursive: true });
      await writeFile(
        join(root, 'skill', 'SKILL.md'),
        [
          '# Documentation helper',
          'Inspect `docs/projects/<repo-name>/` in the target repository.',
          'Use [this placeholder](../path/to/page.md) as a link template.',
          'Read [the bundled guide](references/guide.md) before continuing.',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(root, 'skill', 'references', 'guide.md'),
        '# Bundled guide\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $docs:helper now.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'docs-helper',
              provider: 'codex',
              kind: 'plugin_skill',
              name: 'helper',
              displayName: '$docs:helper',
              description: '',
              insertText: '$docs:helper ',
              invocationKey: '$docs:helper',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'docs',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'docs-helper': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'docs',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(
        result.summary.manifest?.resources[0]?.trees[0]?.entries.map(
          (entry) => entry.path,
        ),
      ).toEqual(
        expect.arrayContaining(['skill/SKILL.md', 'skill/references/guide.md']),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks repo-local command references outside the command export root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-repo-policy-'));
    const claudeRoot = join(root, '.claude');
    const commandsRoot = join(claudeRoot, 'commands');
    try {
      await mkdir(commandsRoot, { recursive: true });
      await writeFile(
        join(commandsRoot, 'review.md'),
        '# Review\n\nRead [local settings](../settings.local.json).\n',
      );
      await writeFile(
        join(claudeRoot, 'settings.local.json'),
        '{"permissions":{"allow":["Bash(*)"]}}\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /review.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'repo-review',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'review',
              displayName: '/review',
              description: '',
              insertText: '/review ',
              invocationKey: '/review',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'repo',
                pluginName: 'repo',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'repo-review': {
            sourceRoot: claudeRoot,
            memberPath: 'commands/review.md',
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'repo',
            exportRoot: commandsRoot,
          },
        },
      });

      expect(result.summary.state).toBe('blocked');
      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({ code: 'SOURCE_PATH_ESCAPE' }),
      );
      expect(
        result.summary.manifest?.resources[0]?.trees[0]?.entries.map(
          (entry) => entry.path,
        ),
      ).not.toContain('settings.local.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks a referenced file reached through a symlinked ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-link-root-'));
    const outside = await mkdtemp(
      join(tmpdir(), 'package-analyzer-link-outside-'),
    );
    try {
      await mkdir(join(root, 'commands'), { recursive: true });
      await writeFile(
        join(root, 'commands', 'review.md'),
        'Read [the private file](../leak/private.txt).\n',
      );
      await writeFile(join(outside, 'private.txt'), 'private local data\n');
      await symlink(outside, join(root, 'leak'), 'dir');

      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /review now.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'review-command',
              provider: 'claude',
              kind: 'plugin_command',
              name: 'review',
              displayName: '/review',
              description: '',
              insertText: '/review ',
              invocationKey: '/review',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'local',
                pluginName: 'repo',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'review-command': {
            sourceRoot: root,
            memberPath: 'commands/review.md',
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'repo',
          },
        },
      });

      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'SYMLINK_BLOCKED',
          relativePath: 'leak',
        }),
      );
      expect(
        result.summary.manifest?.resources[0]?.trees[0]?.entries,
      ).not.toContainEqual(
        expect.objectContaining({ path: 'leak/private.txt' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('packages a repo-local command nested more than one directory deep', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-nested-command-'),
    );
    try {
      await mkdir(join(root, 'commands', 'a', 'b'), { recursive: true });
      await writeFile(join(root, 'commands', 'a', 'b', 'c.md'), '# Nested\n');

      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /a:b:c now.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [],
        },
        repoLocalInvocables: {
          entries: [
            {
              id: 'repo:claude:plugin_command:a:b:c',
              provider: 'claude',
              kind: 'plugin_command',
              invocationKey: '/a:b:c',
              displayName: '/a:b:c',
              sourceLabel: 'repo',
            },
          ],
          scannedDirectories: [join(root, 'commands', 'a', 'b')],
        },
        sourceByRepoLocalEntryId: {
          'repo:claude:plugin_command:a:b:c': {
            sourceRoot: root,
            memberPath: 'commands/a/b/c.md',
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'repo',
            syntheticManifestName: 'repo',
          },
        },
      });

      expect(result.summary.state).toBe('ready');
      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.manifest?.resources[0]?.invocationKeys).toEqual([
        '/a:b:c',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat placeholder secret assignments as credentials', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-secret-placeholder-'),
    );
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(
        join(root, 'skill', 'SKILL.md'),
        'Re-gather with `--state-token=<token>` after each action.\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $docs:helper now.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'docs-helper',
              provider: 'codex',
              kind: 'plugin_skill',
              name: 'helper',
              displayName: '$docs:helper',
              description: '',
              insertText: '$docs:helper ',
              invocationKey: '$docs:helper',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'docs',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'docs-helper': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'docs',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.state).toBe('ready');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still blocks a missing selected dependency member', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-missing-member-'),
    );
    try {
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $docs:helper now.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'docs-helper',
              provider: 'codex',
              kind: 'plugin_skill',
              name: 'helper',
              displayName: '$docs:helper',
              description: '',
              insertText: '$docs:helper ',
              invocationKey: '$docs:helper',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'docs',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'docs-helper': {
            sourceRoot: root,
            memberPath: 'missing-skill',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'docs',
          },
        },
      });

      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'MISSING_DEPENDENCY_SOURCE',
          relativePath: 'missing-skill',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers invocations delimited by Markdown and frontmatter references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-metadata-'));
    try {
      await mkdir(join(root, 'commands'), { recursive: true });
      await mkdir(join(root, 'skills', 'review-multi'), { recursive: true });
      await mkdir(join(root, 'agents'), { recursive: true });
      await writeFile(
        join(root, 'commands', 'review-loop.md'),
        [
          '---',
          'skills:',
          '  - review:review-multi',
          'agent: reviewer',
          '---',
          'Run the configured reviewers.',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(root, 'skills', 'review-multi', 'SKILL.md'),
        '# Multi review\n',
      );
      await writeFile(join(root, 'agents', 'reviewer.md'), '# Reviewer\n');
      const inventory = {
        version: 5 as const,
        builtAt: new Date().toISOString(),
        entries: [
          {
            id: 'review-loop',
            provider: 'claude' as const,
            kind: 'plugin_command' as const,
            name: 'review-loop',
            displayName: '/review-loop',
            description: '',
            insertText: '/review-loop ',
            invocationKey: '/review-loop',
            enableRef: {
              kind: 'plugin' as const,
              marketplaceId: 'private',
              pluginName: 'review',
            },
          },
          {
            id: 'review-multi',
            provider: 'claude' as const,
            kind: 'plugin_skill' as const,
            name: 'review-multi',
            displayName: '/review:review-multi',
            description: '',
            insertText: '/review:review-multi ',
            invocationKey: '/review:review-multi',
            enableRef: {
              kind: 'plugin' as const,
              marketplaceId: 'private',
              pluginName: 'review',
            },
          },
        ],
      };
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Run `(/review-loop)`.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: inventory,
        sourceByInventoryEntryId: {
          'review-loop': {
            sourceRoot: root,
            memberPath: 'commands/review-loop.md',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
          'review-multi': {
            sourceRoot: root,
            memberPath: 'skills/review-multi',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.manifest?.resources).toHaveLength(2);
      expect(result.summary.manifest?.bindings[0]?.resourceIds).toHaveLength(2);
      expect(
        result.summary.manifest?.resources
          .find((resource) => resource.displayName === '/review-loop')
          ?.trees[0]?.entries.map((entry) => entry.path),
      ).toContain('agents/reviewer.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('follows transitive invocations and referenced support files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-closure-'));
    try {
      await mkdir(join(root, 'commands'), { recursive: true });
      await mkdir(join(root, 'skills', 'review-multi'), { recursive: true });
      await mkdir(join(root, 'references'), { recursive: true });
      await writeFile(
        join(root, 'commands', 'review-loop.md'),
        'Run /review:review-multi and read ../references/checklist.md.\n',
      );
      await writeFile(
        join(root, 'skills', 'review-multi', 'SKILL.md'),
        '# Multi review\n',
      );
      await writeFile(join(root, 'references', 'checklist.md'), '# Checks\n');
      const inventory = {
        version: 5 as const,
        builtAt: new Date().toISOString(),
        entries: [
          {
            id: 'review-loop',
            provider: 'claude' as const,
            kind: 'plugin_command' as const,
            name: 'review-loop',
            displayName: '/review-loop',
            description: '',
            insertText: '/review-loop ',
            invocationKey: '/review-loop',
            enableRef: {
              kind: 'plugin' as const,
              marketplaceId: 'private',
              pluginName: 'review',
            },
          },
          {
            id: 'review-multi',
            provider: 'claude' as const,
            kind: 'plugin_command' as const,
            name: 'review-multi',
            displayName: '/review-multi',
            description: '',
            insertText: '/review-multi ',
            invocationKey: '/review-multi',
            enableRef: {
              kind: 'plugin' as const,
              marketplaceId: 'private',
              pluginName: 'review',
            },
          },
        ],
      };
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /review-loop.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: inventory,
        sourceByInventoryEntryId: {
          'review-loop': {
            sourceRoot: root,
            memberPath: 'commands/review-loop.md',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
          'review-multi': {
            sourceRoot: root,
            memberPath: 'skills/review-multi',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.state).toBe('ready');
      expect(
        result.summary.manifest?.resources.map(
          (resource) => resource.displayName,
        ),
      ).toEqual(expect.arrayContaining(['/review-loop', '/review-multi']));
      const direct = result.summary.manifest?.resources.find(
        (resource) => resource.displayName === '/review-loop',
      );
      expect(direct?.dependencyResourceIds).toHaveLength(1);
      expect(result.summary.manifest?.bindings[0]?.resourceIds).toHaveLength(2);
      expect(direct?.trees[0]?.entries.map((entry) => entry.path)).toContain(
        'references/checklist.md',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores shell variables and path fragments while following real transitive skills', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-transitive-shell-'),
    );
    try {
      await mkdir(join(root, 'skills', 'review-loop'), { recursive: true });
      await mkdir(join(root, 'skills', 'review-multi'), { recursive: true });
      await writeFile(
        join(root, 'skills', 'review-loop', 'SKILL.md'),
        [
          '# Review loop',
          'Parse $ARGUMENTS and resolve $OWNER/$REPO#$PR_NUMBER.',
          'Read $HEAD_SHA, $LAST_BODY, $TRAILER, and $COMBINED_SCORE/10.',
          'Use the Perl expression /<!-- data: (\\{.*?\\}) -->/g.',
          'Invoke $review:review-multi after parsing the shell values.',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(root, 'skills', 'review-multi', 'SKILL.md'),
        '# Multi review\n',
      );
      const inventory = {
        version: 5 as const,
        builtAt: new Date().toISOString(),
        entries: [
          {
            id: 'review-loop',
            provider: 'codex' as const,
            kind: 'plugin_skill' as const,
            name: 'review-loop',
            displayName: '$review:review-loop',
            description: '',
            insertText: '$review:review-loop ',
            invocationKey: '$review:review-loop',
            enableRef: {
              kind: 'plugin' as const,
              marketplaceId: 'private',
              pluginName: 'review',
            },
          },
          {
            id: 'review-multi',
            provider: 'codex' as const,
            kind: 'plugin_skill' as const,
            name: 'review-multi',
            displayName: '$review:review-multi',
            description: '',
            insertText: '$review:review-multi ',
            invocationKey: '$review:review-multi',
            enableRef: {
              kind: 'plugin' as const,
              marketplaceId: 'private',
              pluginName: 'review',
            },
          },
        ],
      };
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $review:review-loop.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: inventory,
        sourceByInventoryEntryId: {
          'review-loop': {
            sourceRoot: root,
            memberPath: 'skills/review-loop',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
          'review-multi': {
            sourceRoot: root,
            memberPath: 'skills/review-multi',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(
        result.summary.manifest?.resources.map(
          (resource) => resource.displayName,
        ),
      ).toEqual(
        expect.arrayContaining(['$review:review-loop', '$review:review-multi']),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still blocks explicit missing transitive plugin skills', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-missing-transitive-'),
    );
    try {
      await mkdir(join(root, 'skills', 'review-loop'), { recursive: true });
      await writeFile(
        join(root, 'skills', 'review-loop', 'SKILL.md'),
        'Invoke $missing:review before continuing.\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $review:review-loop.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'review-loop',
              provider: 'codex',
              kind: 'plugin_skill',
              name: 'review-loop',
              displayName: '$review:review-loop',
              description: '',
              insertText: '$review:review-loop ',
              invocationKey: '$review:review-loop',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'review',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'review-loop': {
            sourceRoot: root,
            memberPath: 'skills/review-loop',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
      });

      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'UNRESOLVED_INVOCATION',
          message:
            'Transitive invocation $missing:review could not be resolved.',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks filename-like commands declared in structured frontmatter', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-frontmatter-command-'),
    );
    try {
      await mkdir(join(root, 'commands'), { recursive: true });
      await writeFile(
        join(root, 'commands', 'review.md'),
        ['---', 'commands:', '  - collect.py', '---', '# Review', ''].join(
          '\n',
        ),
      );

      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use /review now.'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [],
        },
        repoLocalInvocables: {
          entries: [
            {
              id: 'repo:claude:plugin_command:review',
              provider: 'claude',
              kind: 'plugin_command',
              invocationKey: '/review',
              displayName: '/review',
              sourceLabel: 'repo',
            },
          ],
          scannedDirectories: [join(root, 'commands')],
        },
        sourceByRepoLocalEntryId: {
          'repo:claude:plugin_command:review': {
            sourceRoot: root,
            memberPath: 'commands/review.md',
            sourceVisibility: 'local',
            runtimeKind: 'plugin_fragment',
            rootName: 'repo',
            syntheticManifestName: 'repo',
          },
        },
      });

      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'UNRESOLVED_INVOCATION',
          message: 'Transitive invocation /collect.py could not be resolved.',
        }),
      );
      expect(
        result.summary.blockers.find(
          (blocker) => blocker.subject === '/collect.py',
        ),
      ).not.toHaveProperty('dismissal');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not offer dismissal when a prompt token is also required by frontmatter', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'package-analyzer-structured-dedup-'),
    );
    try {
      await mkdir(join(root, 'skills', 'review-loop'), { recursive: true });
      await writeFile(
        join(root, 'skills', 'review-loop', 'SKILL.md'),
        ['---', 'skills:', '  - missing', '---', '# Review loop', ''].join(
          '\n',
        ),
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline(
          'Use $review:review-loop, then use $review:missing.',
        ),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'review-loop',
              provider: 'codex',
              kind: 'plugin_skill',
              name: 'review-loop',
              displayName: '$review:review-loop',
              description: '',
              insertText: '$review:review-loop ',
              invocationKey: '$review:review-loop',
              enableRef: {
                kind: 'plugin',
                marketplaceId: 'private',
                pluginName: 'review',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'review-loop': {
            sourceRoot: root,
            memberPath: 'skills/review-loop',
            sourceVisibility: 'private',
            runtimeKind: 'plugin_fragment',
            rootName: 'review',
          },
        },
      });

      const blocker = result.summary.blockers.find(
        (candidate) => candidate.subject === '$review:missing',
      );
      expect(blocker).toMatchObject({
        code: 'UNRESOLVED_INVOCATION',
        origin: 'transitive',
      });
      expect(blocker).not.toHaveProperty('dismissal');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks recursive dependency analysis stale when a file is added', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-stale-dir-'));
    try {
      await mkdir(join(root, 'skills', 'review', 'references'), {
        recursive: true,
      });
      await writeFile(
        join(root, 'skills', 'review', 'SKILL.md'),
        '# Review\nRead references/checklist.md.\n',
      );
      await writeFile(
        join(root, 'skills', 'review', 'references', 'checklist.md'),
        '# Checks\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $review.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'review',
              provider: 'codex',
              kind: 'skill',
              name: 'review',
              displayName: '$review',
              description: '',
              insertText: '$review ',
              invocationKey: '$review',
              enableRef: {
                kind: 'skill',
                sourceId: 'personal',
                skillName: 'review',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          review: {
            sourceRoot: root,
            memberPath: 'skills/review',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'review',
          },
        },
      });
      expect(result.summary.state).toBe('ready');

      await writeFile(
        join(root, 'skills', 'review', 'references', 'new-check.md'),
        '# New check\n',
      );

      await expect(pipelinePackageAnalysisIsStale(result)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('packages required structured dependencies even when the prompt has no invocation text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-declared-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Declared skill\n');
      const declaredPipeline: Pipeline = {
        ...pipeline('Review the change.'),
        dependencies: [
          {
            id: 'declared-skill',
            kind: 'skill',
            required: true,
            steps: ['loop'],
            ref: {
              type: 'skill',
              source: { type: 'builtin', id: 'app' },
              skill_name: 'declared-skill',
            },
          },
        ],
      };
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: declaredPipeline,
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'declared-skill',
              provider: 'claude',
              kind: 'skill',
              name: 'declared-skill',
              displayName: '/declared-skill',
              description: '',
              insertText: '/declared-skill ',
              invocationKey: '/declared-skill',
              enableRef: {
                kind: 'skill',
                sourceId: 'builtin:app',
                skillName: 'declared-skill',
              },
            },
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'skill:builtin:app:declared-skill': ['declared-skill'],
        },
        sourceByInventoryEntryId: {
          'declared-skill': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'builtin',
            runtimeKind: 'standalone_skill',
            rootName: 'declared-skill',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.manifest?.resources).toHaveLength(1);
      expect(result.summary.manifest?.bindings).toEqual([
        expect.objectContaining({ jobId: 'review', stepId: 'loop' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses canonical generated ids when binding dependencies to unnamed steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-unnamed-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(
        join(root, 'skill', 'SKILL.md'),
        '# Unnamed step skill\n',
      );
      const unnamedPipeline = pipeline('Use /unnamed-skill.');
      delete unnamedPipeline.jobs.review.steps[0]?.id;

      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: unnamedPipeline,
        providerByStep: { 'review.__auto_step_0': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'unnamed-skill',
              provider: 'claude',
              kind: 'skill',
              name: 'unnamed-skill',
              displayName: '/unnamed-skill',
              description: '',
              insertText: '/unnamed-skill ',
              invocationKey: '/unnamed-skill',
              enableRef: {
                kind: 'skill',
                sourceId: 'local',
                skillName: 'unnamed-skill',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'unnamed-skill': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'unnamed-skill',
          },
        },
      });

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.manifest?.bindings).toEqual([
        expect.objectContaining({
          jobId: 'review',
          stepId: '__auto_step_0',
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves affected-step bindings for optional structured resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-optional-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Optional skill\n');
      const optionalPipeline: Pipeline = {
        ...pipeline('Review without invoking the optional skill.'),
        dependencies: [
          {
            id: 'optional-skill',
            kind: 'skill',
            required: false,
            steps: ['loop'],
            ref: {
              type: 'skill',
              source: { type: 'builtin', id: 'app' },
              skill_name: 'optional-skill',
            },
          },
        ],
      };
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: optionalPipeline,
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'optional-skill',
              provider: 'claude',
              kind: 'skill',
              name: 'optional-skill',
              displayName: '/optional-skill',
              description: '',
              insertText: '/optional-skill ',
              invocationKey: '/optional-skill',
              enableRef: {
                kind: 'skill',
                sourceId: 'builtin:app',
                skillName: 'optional-skill',
              },
            },
          ],
        },
        capabilityInventoryEntryIdsByKey: {
          'skill:builtin:app:optional-skill': ['optional-skill'],
        },
        sourceByInventoryEntryId: {
          'optional-skill': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'builtin',
            runtimeKind: 'standalone_skill',
            rootName: 'optional-skill',
          },
        },
      });

      expect(result.summary.manifest?.bindings).toEqual([]);
      expect(result.optionalBindings).toEqual([
        {
          jobId: 'review',
          stepId: 'loop',
          resourceIds: [result.summary.manifest?.resources[0]?.id],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['FAT_MAGIC_64', [0xca, 0xfe, 0xba, 0xbf]],
    ['FAT_CIGAM_64', [0xbf, 0xba, 0xfe, 0xca]],
  ])('blocks %s native binaries', async (_label, magic) => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-native-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Native helper\n');
      await writeFile(join(root, 'skill', 'helper'), Uint8Array.from(magic));
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $native-skill.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'native-skill',
              provider: 'codex',
              kind: 'skill',
              name: 'native-skill',
              displayName: '$native-skill',
              description: '',
              insertText: '$native-skill ',
              invocationKey: '$native-skill',
              enableRef: {
                kind: 'skill',
                sourceId: 'local',
                skillName: 'native-skill',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'native-skill': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'native-skill',
          },
        },
      });

      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'NATIVE_EXECUTABLE_BLOCKED',
          relativePath: 'helper',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks opaque executable files without a text-script shebang', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-analyzer-opaque-exec-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Opaque helper\n');
      const helperPath = join(root, 'skill', 'helper');
      await writeFile(helperPath, Uint8Array.from([0xff, 0xfe, 0x00, 0x80]));
      await chmod(helperPath, 0o700);

      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Use $opaque-skill.'),
        providerByStep: { 'review.loop': 'codex' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [
            {
              id: 'opaque-skill',
              provider: 'codex',
              kind: 'skill',
              name: 'opaque-skill',
              displayName: '$opaque-skill',
              description: '',
              insertText: '$opaque-skill ',
              invocationKey: '$opaque-skill',
              enableRef: {
                kind: 'skill',
                sourceId: 'local',
                skillName: 'opaque-skill',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          'opaque-skill': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'opaque-skill',
          },
        },
      });

      expect(result.summary.blockers).toContainEqual(
        expect.objectContaining({
          code: 'OPAQUE_EXECUTABLE_BLOCKED',
          relativePath: 'helper',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat shell variables or non-prompt inputs as skill invocations', async () => {
    const variablePipeline: Pipeline = {
      name: 'Variables',
      on: 'dispatch',
      jobs: {
        review: {
          steps: [
            { id: 'shell', run: 'echo "$repo $pr $source"' },
            {
              id: 'agent',
              uses: 'builtin/agent-prompt',
              with: {
                prompt: 'Read $HOME/bin and review the current change.',
                output_path: '$artifact_path',
              },
            },
          ],
        },
      },
    };
    const result = await analyzePipelinePackage({
      rawPipeline: 'name: Variables\n',
      pipeline: variablePipeline,
      providerByStep: {
        'review.shell': 'claude',
        'review.agent': 'codex',
      },
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
    });

    expect(result.summary.blockers).toEqual([]);
  });
});

describe('analyzeCapabilityPackage prompt sources', () => {
  function helperInventory(): {
    invocableInventory: Parameters<
      typeof analyzeCapabilityPackage
    >[0]['invocableInventory'];
  } {
    return {
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [
          {
            id: 'local-helper-claude',
            provider: 'claude',
            kind: 'skill',
            name: 'local-helper',
            displayName: 'Local helper',
            description: '',
            insertText: '/local-helper ',
            invocationKey: '/local-helper',
            enableRef: {
              kind: 'skill',
              sourceId: 'custom',
              skillName: 'local-helper',
            },
          },
        ],
      },
    };
  }

  it('packages a skill named only in the prompt, with no structured request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-package-prompt-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Local helper\n');
      const result = await analyzeCapabilityPackage({
        rawContent: '{"automation":"example"}',
        requests: [],
        promptSources: [
          {
            jobId: 'automation',
            stepId: 'action',
            provider: 'claude',
            text: 'Say hello with /local-helper name',
          },
        ],
        ...helperInventory(),
        sourceByInventoryEntryId: {
          'local-helper-claude': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'local-helper',
          },
        },
      });

      expect(result.summary.state).toBe('ready');
      expect(
        result.summary.manifest?.resources.map((resource) => resource.kind),
      ).toEqual(['standalone_skill']);
      expect(result.summary.manifest?.bindings).toEqual([
        {
          jobId: 'automation',
          stepId: 'action',
          resourceIds: [expect.any(String)],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('packages an instructions-only subject skill and excludes a dismissed token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-package-subject-'));
    try {
      await mkdir(join(root, 'skill'), { recursive: true });
      await writeFile(join(root, 'skill', 'SKILL.md'), '# Local helper\n');
      const result = await analyzeCapabilityPackage({
        rawContent: '{"blueprint":"example"}',
        requests: [],
        promptSources: [
          {
            target: 'subject',
            provider: 'claude',
            text: 'Use /local-helper but ignore /not-a-command.',
          },
        ],
        dismissedInvocations: [{ provider: 'claude', token: '/not-a-command' }],
        ...helperInventory(),
        sourceByInventoryEntryId: {
          'local-helper-claude': {
            sourceRoot: root,
            memberPath: 'skill',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'local-helper',
          },
        },
      });

      expect(result.summary.state).toBe('ready');
      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.dismissedInvocations).toEqual([
        { provider: 'claude', token: '/not-a-command' },
      ]);
      expect(result.summary.manifest?.resources).toEqual([
        expect.objectContaining({
          kind: 'standalone_skill',
          displayName: 'Local helper',
        }),
      ]);
      expect(result.summary.manifest?.bindings).toEqual([
        { target: 'subject', resourceIds: [expect.any(String)] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks an unresolvable prompt invocation and offers a dismissal', async () => {
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      promptSources: [
        {
          jobId: 'automation',
          stepId: 'action',
          provider: 'claude',
          text: 'Say hello with /invalid-skill name',
        },
      ],
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
    });

    expect(result.summary.state).toBe('blocked');
    expect(result.summary.blockers).toHaveLength(1);
    expect(result.summary.blockers[0]).toMatchObject({
      code: 'UNRESOLVED_INVOCATION',
      subject: '/invalid-skill',
      origin: 'direct',
      occurrences: [{ jobId: 'automation', stepId: 'action' }],
      dismissal: { provider: 'claude', token: '/invalid-skill' },
    });
  });

  it('clears the blocker once the author dismisses the token', async () => {
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      promptSources: [
        {
          jobId: 'automation',
          stepId: 'action',
          provider: 'claude',
          text: 'Say hello with /invalid-skill name',
        },
      ],
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
      dismissedInvocations: [{ provider: 'claude', token: '/invalid-skill' }],
    });

    expect(result.summary.state).toBe('ready');
    expect(result.summary.blockers).toEqual([]);
    expect(result.summary.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/invalid-skill' },
    ]);
  });

  it('analyzes a pipeline as a capability package over its derived sources', async () => {
    // The pipeline entry point is a thin adapter: everything pipeline-shaped,
    // including the `dependencies:` manifest, becomes neutral input, and the
    // subject-neutral analyzer does the rest. Declared requirements must
    // survive that translation rather than being read from the pipeline
    // inside the analyzer.
    const declared: Pipeline = {
      ...pipeline('Use /missing-command here.'),
      dependencies: [
        {
          id: 'github',
          kind: 'connector',
          connector: 'github',
          required: true,
          steps: ['loop'],
        },
      ],
    };
    const providerByStep = { 'review.loop': 'claude' as const };
    const inventory = {
      version: 5 as const,
      builtAt: '2026-09-23T00:00:00.000Z',
      entries: [],
    };
    const sources = buildPipelineCapabilityPackageSources(
      declared,
      providerByStep,
    );

    expect(sources.environmentRequirements).toEqual([
      expect.objectContaining({
        id: 'github',
        kind: 'connector',
        affectedSteps: [{ jobId: 'review', stepId: 'loop' }],
      }),
    ]);

    const viaPipeline = await analyzePipelinePackage({
      rawPipeline: 'name: Example\n',
      pipeline: declared,
      providerByStep,
      invocableInventory: inventory,
    });
    const viaCapability = await analyzeCapabilityPackage({
      rawContent: 'name: Example\n',
      invocableInventory: inventory,
      ...sources,
    });

    // Each analysis gets its own id and expiry; everything else must match.
    expect({
      ...viaCapability.summary,
      analysisId: viaPipeline.summary.analysisId,
      expiresAt: viaPipeline.summary.expiresAt,
    }).toEqual(viaPipeline.summary);
    expect(viaPipeline.summary.manifest?.environmentRequirements).toEqual([
      expect.objectContaining({ id: 'github', kind: 'connector' }),
    ]);
  });

  describe('steps whose model is chosen at run time', () => {
    const selectorPrompt = `\${{ parseJson('{"Claude only":"/open-pr --push","Codex only":"$ud-git:open-pr --push"}')[inputs.providers] }} for \${{ needs.plan.outputs.path }}`;
    const choiceStep: Pipeline = {
      ...pipeline(selectorPrompt),
      dependencies: [
        {
          id: 'helper',
          kind: 'skill',
          required: true,
          steps: ['loop'],
          ref: {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'helper',
          },
        },
      ],
    };

    it('scans each variant prompt under the provider that variant selects', () => {
      const sources = buildPipelineCapabilityPackageSources(choiceStep, {
        'review.loop': [
          { provider: 'claude', inputs: { providers: 'Claude only' } },
          { provider: 'codex', inputs: { providers: 'Codex only' } },
        ],
      });

      // Only expressions over the variant's own inputs are substituted; a
      // run-time value such as a prior job's output stays as authored.
      expect(sources.promptSources).toEqual([
        {
          jobId: 'review',
          stepId: 'loop',
          provider: 'claude',
          text: '/open-pr --push for ${{ needs.plan.outputs.path }}',
        },
        {
          jobId: 'review',
          stepId: 'loop',
          provider: 'codex',
          text: '$ud-git:open-pr --push for ${{ needs.plan.outputs.path }}',
        },
      ]);
      expect(sources.requests).toEqual([
        expect.objectContaining({
          key: 'skill:builtin:app:helper',
          provider: 'claude',
        }),
        expect.objectContaining({
          key: 'skill:builtin:app:helper',
          provider: 'codex',
        }),
      ]);
    });

    it('collapses variants that produce the same provider and prompt', () => {
      const sources = buildPipelineCapabilityPackageSources(
        pipeline('Implement the plan.'),
        {
          'review.loop': [
            { provider: 'codex', inputs: { providers: 'Codex only' } },
            { provider: 'codex', inputs: { providers: 'Claude + Codex' } },
          ],
        },
      );

      expect(sources.promptSources).toEqual([
        {
          jobId: 'review',
          stepId: 'loop',
          provider: 'codex',
          text: 'Implement the plan.',
        },
      ]);
    });

    it('scans the authored prompt for an unconfirmed provider without confirming it', () => {
      const sources = buildPipelineCapabilityPackageSources(choiceStep, {
        'review.loop': [
          { provider: 'claude' },
          { provider: 'codex', unconfirmed: true },
        ],
      });

      expect(
        sources.promptSources.map(({ provider, text, unconfirmed }) => ({
          provider,
          raw: text === selectorPrompt,
          unconfirmed,
        })),
      ).toEqual([
        { provider: 'claude', raw: true, unconfirmed: undefined },
        { provider: 'codex', raw: true, unconfirmed: true },
      ]);
      expect(
        sources.requests.map(({ provider, unconfirmed }) => ({
          provider,
          unconfirmed,
        })),
      ).toEqual([
        { provider: 'claude', unconfirmed: undefined },
        { provider: 'codex', unconfirmed: true },
      ]);
    });

    it('confirms a provider that any variant confirms', () => {
      const sources = buildPipelineCapabilityPackageSources(choiceStep, {
        'review.loop': [
          { provider: 'codex', unconfirmed: true },
          { provider: 'codex', inputs: { providers: 'Codex only' } },
        ],
      });

      expect(sources.requests).toEqual([
        expect.not.objectContaining({ unconfirmed: true }),
      ]);
    });

    it('packages what an unconfirmed provider finds but never blocks on what it misses', async () => {
      const root = await mkdtemp(
        join(tmpdir(), 'package-analyzer-unconfirmed-'),
      );
      try {
        await mkdir(join(root, 'skill'), { recursive: true });
        await writeFile(join(root, 'skill', 'SKILL.md'), '# Declared skill\n');
        const result = await analyzePipelinePackage({
          rawPipeline: 'name: Example\n',
          pipeline: {
            // A Claude command an unconfirmed Codex run would not resolve.
            ...pipeline('Run /declared-skill, then review.'),
            dependencies: [
              {
                id: 'declared-skill',
                kind: 'skill',
                required: true,
                steps: ['loop'],
                ref: {
                  type: 'skill',
                  source: { type: 'builtin', id: 'app' },
                  skill_name: 'declared-skill',
                },
              },
            ],
          },
          providerByStep: {
            'review.loop': [
              { provider: 'claude' },
              { provider: 'codex', unconfirmed: true },
            ],
          },
          invocableInventory: {
            version: 5,
            builtAt: new Date().toISOString(),
            // The capability exists only for Claude.
            entries: [
              {
                id: 'declared-skill',
                provider: 'claude',
                kind: 'skill',
                name: 'declared-skill',
                displayName: '/declared-skill',
                description: '',
                insertText: '/declared-skill ',
                invocationKey: '/declared-skill',
                enableRef: {
                  kind: 'skill',
                  sourceId: 'builtin:app',
                  skillName: 'declared-skill',
                },
              },
            ],
          },
          capabilityInventoryEntryIdsByKey: {
            'skill:builtin:app:declared-skill': ['declared-skill'],
          },
          sourceByInventoryEntryId: {
            'declared-skill': {
              sourceRoot: root,
              memberPath: 'skill',
              sourceVisibility: 'builtin',
              runtimeKind: 'standalone_skill',
              rootName: 'declared-skill',
            },
          },
        });

        // The required capability and the `/declared-skill` token have no
        // Codex match, and neither becomes a blocker.
        expect(result.summary.blockers).toEqual([]);
        expect(result.summary.state).toBe('ready');
        expect(result.summary.manifest?.resources).toHaveLength(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    function helperEntry(
      provider: 'claude' | 'codex',
      id: string,
    ): InvocableInventoryEntry {
      return {
        id,
        provider,
        kind: 'plugin_skill',
        name: 'helper',
        displayName: '/helper',
        description: '',
        insertText: '/helper ',
        invocationKey: '/helper',
        enableRef: {
          kind: 'plugin',
          marketplaceId: `market-${id}`,
          pluginName: 'review',
        },
      };
    }

    const unresolvedModel = {
      'review.loop': [
        { provider: 'claude' as const },
        { provider: 'codex' as const, unconfirmed: true },
      ],
    };

    /** Analyze `Run /helper.` with a Claude twin whose source is available. */
    async function analyzeHelper(
      codexEntries: InvocableInventoryEntry[],
      codexSources: string[],
    ): Promise<Awaited<ReturnType<typeof analyzePipelinePackage>>> {
      const root = await mkdtemp(join(tmpdir(), 'package-analyzer-helper-'));
      try {
        for (const id of ['claude-helper', ...codexSources]) {
          await mkdir(join(root, id), { recursive: true });
          await writeFile(join(root, id, 'SKILL.md'), '# Helper\n');
        }
        return await analyzePipelinePackage({
          rawPipeline: 'name: Example\n',
          pipeline: pipeline('Run /helper.'),
          providerByStep: unresolvedModel,
          invocableInventory: {
            version: 5,
            builtAt: new Date().toISOString(),
            entries: [helperEntry('claude', 'claude-helper'), ...codexEntries],
          },
          sourceByInventoryEntryId: Object.fromEntries(
            ['claude-helper', ...codexSources].map((id) => [
              id,
              {
                sourceRoot: root,
                memberPath: id,
                sourceVisibility: 'local' as const,
                runtimeKind: 'plugin_fragment' as const,
                rootName: id,
              },
            ]),
          ),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    function packagedProviders(
      result: Awaited<ReturnType<typeof analyzePipelinePackage>>,
    ): string[] {
      return (result.summary.manifest?.resources ?? []).flatMap((resource) =>
        resource.trees.map((tree) => tree.provider),
      );
    }

    it('packages a clean match an unconfirmed provider finds', async () => {
      const result = await analyzeHelper(
        [helperEntry('codex', 'codex-helper')],
        ['codex-helper'],
      );

      expect(result.summary.blockers).toEqual([]);
      expect(packagedProviders(result).sort()).toEqual(['claude', 'codex']);
    });

    it('drops what an unconfirmed provider finds when it would add a blocker', async () => {
      // The Codex twin resolves, but its source is unavailable, which would
      // block. The Claude analysis alone has no blocker, so it is the result.
      const result = await analyzeHelper(
        [helperEntry('codex', 'codex-helper')],
        [],
      );

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.state).toBe('ready');
      expect(packagedProviders(result)).toEqual(['claude']);
    });

    it('drops an ambiguous token an unconfirmed provider finds', async () => {
      const result = await analyzeHelper(
        [helperEntry('codex', 'codex-one'), helperEntry('codex', 'codex-two')],
        ['codex-one', 'codex-two'],
      );

      expect(result.summary.blockers).toEqual([]);
      expect(packagedProviders(result)).toEqual(['claude']);
    });

    it('still blocks on what a confirmed Codex variant misses', async () => {
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('Run /gone.'),
        providerByStep: {
          'review.loop': [{ provider: 'codex', inputs: { providers: 'x' } }],
        },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [],
        },
      });

      expect(result.summary.blockers).toMatchObject([
        { code: 'UNRESOLVED_INVOCATION', subject: '/gone' },
      ]);
    });

    it('does not flag the other provider for a command only one variant runs', async () => {
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline(selectorPrompt),
        providerByStep: {
          'review.loop': [
            { provider: 'claude', inputs: { providers: 'Claude only' } },
            { provider: 'codex', inputs: { providers: 'Codex only' } },
          ],
        },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [],
        },
      });

      // `/open-pr` is a Claude command and `$ud-git:open-pr` a Codex one;
      // neither is reported under the provider that never runs it.
      expect(
        result.summary.blockers.map((blocker) => [
          blocker.subject,
          blocker.dismissal?.provider,
        ]),
      ).toEqual([
        ['/open-pr', 'claude'],
        ['$ud-git:open-pr', 'codex'],
      ]);
    });
  });

  it('leaves a pipeline analysis unchanged when it has no prompt sources of its own', async () => {
    const result = await analyzePipelinePackage({
      rawPipeline: 'name: Example\n',
      pipeline: pipeline('Use /missing-command here.'),
      providerByStep: { 'review.loop': 'claude' },
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
    });

    expect(result.summary.blockers).toMatchObject([
      { code: 'UNRESOLVED_INVOCATION', subject: '/missing-command' },
    ]);
  });

  it('packages portable actions and child pipelines on their exact step binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portable-pipeline-resources-'));
    try {
      await mkdir(join(root, 'action'), { recursive: true });
      await mkdir(join(root, 'children'), { recursive: true });
      await writeFile(
        join(root, 'action', 'action.yml'),
        'name: Review\nruns:\n  using: composite\n  steps: []\n',
      );
      await writeFile(
        join(root, 'children', 'review.yaml'),
        'name: Child\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo child\n',
      );
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('hello'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [],
        },
        portableResources: [
          {
            kind: 'pipeline_action',
            displayName: 'project/review',
            invocationKeys: ['project/review'],
            bindingKey: 'review\0loop',
            descriptor: {
              sourceRoot: join(root, 'action'),
              memberPath: '.',
              sourceVisibility: 'local',
              runtimeKind: 'standalone_skill',
              rootName: 'review',
            },
          },
          {
            kind: 'child_pipeline',
            displayName: 'children/review.yaml',
            invocationKeys: ['children/review.yaml'],
            bindingKey: 'review\0loop',
            descriptor: {
              sourceRoot: root,
              memberPath: 'children/review.yaml',
              sourceVisibility: 'local',
              runtimeKind: 'plugin_fragment',
              rootName: 'pipelines-test',
            },
          },
        ],
      });

      expect(result.summary.state).toBe('ready');
      expect(result.summary.manifest?.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'pipeline_action',
            invocationKeys: ['project/review'],
          }),
          expect.objectContaining({
            kind: 'child_pipeline',
            invocationKeys: ['children/review.yaml'],
          }),
        ]),
      );
      const binding = result.summary.manifest?.bindings[0];
      expect(binding).toMatchObject({ jobId: 'review', stepId: 'loop' });
      expect(binding?.resourceIds).toHaveLength(2);
      expect(binding?.resourceIds.every((id) => typeof id === 'string')).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits every invocation key of a portable resource, deduplicated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portable-invocation-keys-'));
    const workerId = '5b0f4c3e-2a1d-4e6f-9c8b-7a6d5e4f3a2b';
    try {
      await writeFile(
        join(root, `${workerId}.yaml`),
        'name: Worker\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo worker\n',
      );
      const descriptor = {
        sourceRoot: root,
        memberPath: `${workerId}.yaml`,
        sourceVisibility: 'local' as const,
        runtimeKind: 'plugin_fragment' as const,
        rootName: 'pipelines-test',
      };
      const result = await analyzePipelinePackage({
        rawPipeline: 'name: Example\n',
        pipeline: pipeline('hello'),
        providerByStep: { 'review.loop': 'claude' },
        invocableInventory: {
          version: 5,
          builtAt: new Date().toISOString(),
          entries: [],
        },
        portableResources: [
          {
            kind: 'child_pipeline',
            displayName: '${{ env.WORKER_PIPELINE }}',
            invocationKeys: [
              '${{ env.WORKER_PIPELINE }}',
              workerId,
              '${{ env.WORKER_PIPELINE }}',
            ],
            bindingKey: 'review\0loop',
            descriptor,
          },
          {
            kind: 'child_pipeline',
            displayName: workerId,
            invocationKeys: [workerId, workerId],
            bindingKey: 'review\0other',
            descriptor,
          },
        ],
      });

      expect(result.summary.state).toBe('ready');
      expect(
        result.summary.manifest?.resources.map((resource) => ({
          displayName: resource.displayName,
          invocationKeys: resource.invocationKeys,
        })),
      ).toEqual([
        {
          displayName: '${{ env.WORKER_PIPELINE }}',
          invocationKeys: ['${{ env.WORKER_PIPELINE }}', workerId],
        },
        { displayName: workerId, invocationKeys: [workerId] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks on host blockers and echoes the reference dismissals it applied', async () => {
    const result = await analyzePipelinePackage({
      rawPipeline: 'name: Example\n',
      pipeline: pipeline('hello'),
      providerByStep: { 'review.loop': 'claude' },
      invocableInventory: {
        version: 5,
        builtAt: new Date().toISOString(),
        entries: [],
      },
      hostBlockers: [
        {
          code: 'UNRESOLVED_CHILD_PIPELINE_REF',
          subject: '${{ inputs.target }}',
          message: 'unresolved',
          jobId: 'review',
          stepId: 'loop',
          occurrences: [],
          referenceDismissal: {
            kind: 'child_pipeline_ref',
            token: '${{ inputs.target }}',
          },
        },
      ],
      dismissedReferences: [
        { kind: 'child_pipeline_ref', token: '${{ steps.a.outputs.b }}' },
      ],
    });

    expect(result.summary.state).toBe('blocked');
    expect(result.summary.blockers).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_CHILD_PIPELINE_REF',
        occurrences: [{ jobId: 'review', stepId: 'loop' }],
        referenceDismissal: {
          kind: 'child_pipeline_ref',
          token: '${{ inputs.target }}',
        },
      }),
    ]);
    expect(result.summary.dismissedReferences).toEqual([
      { kind: 'child_pipeline_ref', token: '${{ steps.a.outputs.b }}' },
    ]);
  });
});

describe('automation pipeline dependencies', () => {
  const ENTRY_ID = '3f2b8c1e-9d4a-4e6b-8f1c-2a7d5e9b0c13';
  const WORKER_ID = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
  const ACTION_BINDING = 'automation\0action';
  const ENTRY_YAML =
    'name: Entry\non: dispatch\nenv:\n  API_TOKEN: ${{ secrets.API_TOKEN }}\n  WORKER_PIPELINE: worker\njobs: {}\n';
  const WORKER_YAML = 'name: Worker\non: dispatch\njobs: {}\n';
  // Assembled so the literal never appears in source.
  const LITERAL_TOKEN = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');

  const emptyInventory = (): InvocableInventoryCache => ({
    version: 5,
    builtAt: new Date().toISOString(),
    entries: [],
  });

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

  function promptSource(text: string): CapabilityPackagePromptSource {
    return {
      jobId: 'automation',
      stepId: 'action',
      provider: 'claude',
      text,
      pipelineReferences: true,
    };
  }

  function pipelineInput(
    pipelineKey: string,
    name: string,
    rawContent: string,
  ): AutomationPipelinePortableInput {
    return {
      pipelineKey,
      name,
      source: 'user',
      rawContent,
      bindingKey: ACTION_BINDING,
    };
  }

  it('packages a pipeline the prompt names by UUID, with every span', async () => {
    const prompt = `\u{1F680} Run ${ENTRY_ID}. Again: ${ENTRY_ID.toUpperCase()}`;
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [promptSource(prompt)],
      pipelineInventory: [
        userPipeline(ENTRY_ID, 'Entry'),
        userPipeline(WORKER_ID, 'Worker'),
      ],
      automationPipelines: [pipelineInput(ENTRY_ID, 'Entry', ENTRY_YAML)],
    });

    expect(result.summary.blockers).toEqual([]);
    expect(result.summary.state).toBe('ready');
    const manifest = result.summary.manifest;
    expect(manifest && validatePipelinePackageManifest(manifest)).toEqual({
      ok: true,
    });
    const resource = manifest?.resources.find(
      (candidate) => candidate.kind === 'automation_pipeline',
    );
    expect(resource).toEqual(
      expect.objectContaining({
        id: `automation-pipeline-${ENTRY_ID}`,
        pipelineKey: ENTRY_ID,
        trees: [
          expect.objectContaining({
            runtimeKind: 'automation_pipeline',
            rootName: ENTRY_ID,
            entries: [
              expect.objectContaining({
                path: 'pipeline.yaml',
                sha256: resource?.pipelineContentHash,
              }),
            ],
          }),
        ],
      }),
    );
    expect(manifest?.bindings).toEqual([
      {
        jobId: 'automation',
        stepId: 'action',
        resourceIds: [`automation-pipeline-${ENTRY_ID}`],
      },
    ]);
    expect(
      new TextDecoder().decode(
        result.blobs.get(resource?.pipelineContentHash ?? ''),
      ),
    ).toBe(ENTRY_YAML);
    expect(result.summary.packagedPipelines).toEqual([
      {
        key: ENTRY_ID,
        resourceId: `automation-pipeline-${ENTRY_ID}`,
        name: 'Entry',
        pipelineContentHash: resource?.pipelineContentHash,
        source: 'user',
        isActionPipeline: false,
        optional: false,
        promptSpans: [
          { textStart: 7, text: ENTRY_ID },
          { textStart: 52, text: ENTRY_ID.toUpperCase() },
        ],
      },
    ]);
  });

  it('lists a name match as an optional suggestion until it is selected', async () => {
    const input = {
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [promptSource('Hand off to Worker when done.')],
      pipelineInventory: [userPipeline(WORKER_ID, 'Worker')],
      automationPipelines: [pipelineInput(WORKER_ID, 'Worker', WORKER_YAML)],
    };
    const suggested = await analyzeCapabilityPackage(input);
    expect(suggested.summary.state).toBe('ready');
    expect(suggested.summary.manifest?.resources).toEqual([]);
    expect(suggested.summary.packagedPipelines).toEqual([
      expect.objectContaining({
        key: WORKER_ID,
        optional: true,
        promptSpans: [],
      }),
    ]);

    const selected = await analyzeCapabilityPackage({
      ...input,
      pipelineSelections: [WORKER_ID],
    });
    expect(selected.summary.manifest?.resources).toEqual([
      expect.objectContaining({ id: `automation-pipeline-${WORKER_ID}` }),
    ]);
    expect(selected.summary.packagedPipelines).toEqual([
      expect.objectContaining({ key: WORKER_ID, optional: true }),
    ]);
  });

  it('blocks an ambiguous name until it is dismissed', async () => {
    const input = {
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [promptSource('Run Review.')],
      pipelineInventory: [
        userPipeline(ENTRY_ID, 'Review'),
        {
          key: 'project-review',
          pipelineId: 'project:review.yaml',
          name: 'Review',
          source: 'project' as const,
          path: '/repo/pipelines/review.yaml',
          hasInstalledPackage: false,
        },
      ],
    };
    const blocked = await analyzeCapabilityPackage(input);
    expect(blocked.summary.blockers).toEqual([
      expect.objectContaining({
        code: 'AMBIGUOUS_PIPELINE_REFERENCE',
        subject: 'Review',
        occurrences: [{ jobId: 'automation', stepId: 'action' }],
        referenceDismissal: { kind: 'pipeline_reference', token: 'Review' },
      }),
    ]);

    const dismissed = await analyzeCapabilityPackage({
      ...input,
      dismissedReferences: [
        { kind: 'pipeline_reference', token: 'Review' },
        { kind: 'pipeline_reference', token: 'Unrelated' },
      ],
    });
    expect(dismissed.summary.state).toBe('ready');
    expect(dismissed.summary.dismissedReferences).toEqual([
      { kind: 'pipeline_reference', token: 'Review' },
    ]);
  });

  it('ignores stray UUIDs', async () => {
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [
        promptSource('Trace 11111111-2222-4333-8444-555555555555 in the logs.'),
      ],
      pipelineInventory: [userPipeline(ENTRY_ID, 'Entry')],
    });
    expect(result.summary.state).toBe('ready');
    expect(result.summary.packagedPipelines).toEqual([]);
  });

  it('packages a stored dependency the prompt only names, and reports a missing one', async () => {
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [promptSource('Hand off to Worker.')],
      pipelineInventory: [userPipeline(WORKER_ID, 'Worker')],
      pipelineRequests: [
        { pipelineId: WORKER_ID, source: 'user' },
        { pipelineId: ENTRY_ID, source: 'user' },
      ],
      automationPipelines: [pipelineInput(WORKER_ID, 'Worker', WORKER_YAML)],
    });
    expect(result.summary.blockers).toEqual([
      expect.objectContaining({
        code: 'MISSING_DEPENDENCY_SOURCE',
        subject: ENTRY_ID,
      }),
    ]);
    expect(result.summary.packagedPipelines).toEqual([
      expect.objectContaining({ key: WORKER_ID, optional: false }),
    ]);
    expect(result.summary.manifest?.resources).toEqual([
      expect.objectContaining({ id: `automation-pipeline-${WORKER_ID}` }),
    ]);
  });

  it('reports a selected pipeline whose YAML the host did not supply', async () => {
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [promptSource(`Run ${ENTRY_ID}.`)],
      pipelineInventory: [userPipeline(ENTRY_ID, 'Entry')],
    });
    expect(result.summary.blockers).toEqual([
      expect.objectContaining({
        code: 'MISSING_DEPENDENCY_SOURCE',
        subject: 'Entry',
      }),
    ]);
  });

  it('blocks a dependency that has its own installed package', async () => {
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [promptSource(`Run ${ENTRY_ID}.`)],
      pipelineInventory: [
        userPipeline(ENTRY_ID, 'Entry', { hasInstalledPackage: true }),
      ],
      automationPipelines: [pipelineInput(ENTRY_ID, 'Entry', ENTRY_YAML)],
    });
    expect(result.summary.blockers).toEqual([
      expect.objectContaining({
        code: 'DEPENDENCY_HAS_INSTALLED_PACKAGE',
        subject: 'Entry',
      }),
    ]);
  });

  it('blocks two project pipelines that travel under one key', async () => {
    const project = (
      fileName: string,
      name: string,
    ): AutomationPipelineInventoryEntry => ({
      key: 'project-nightly-build',
      pipelineId: `project:${fileName}`,
      name,
      source: 'project',
      path: `/repo/pipelines/${fileName}`,
      hasInstalledPackage: false,
    });
    const result = await analyzeCapabilityPackage({
      rawContent: '{"automation":"example"}',
      requests: [],
      invocableInventory: emptyInventory(),
      pipelineInventory: [
        project('Nightly Build.yaml', 'Nightly'),
        project('nightly-build.yaml', 'Nightly two'),
      ],
      pipelineRequests: [
        { pipelineId: 'project:Nightly Build.yaml', source: 'project' },
      ],
      automationPipelines: [
        {
          ...pipelineInput('project-nightly-build', 'Nightly', WORKER_YAML),
          source: 'project',
        },
      ],
    });
    expect(result.summary.blockers).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_PIPELINE_KEY',
        subject: 'project-nightly-build',
      }),
    ]);
  });

  it('scans every packaged pipeline, root included, for literal secrets', async () => {
    const base = {
      rawContent: 'name: Action\n',
      requests: [],
      invocableInventory: emptyInventory(),
    };
    const clean = await analyzeCapabilityPackage({
      ...base,
      automationPipelines: [pipelineInput('action', 'Action', ENTRY_YAML)],
    });
    expect(clean.summary.blockers).toEqual([]);
    expect(clean.summary.packagedPipelines).toEqual([
      expect.objectContaining({
        key: 'action',
        isActionPipeline: true,
        optional: false,
      }),
    ]);

    const leaked = await analyzeCapabilityPackage({
      ...base,
      automationPipelines: [
        pipelineInput(
          'action',
          'Action',
          `name: Action\nenv:\n  API_TOKEN: ${LITERAL_TOKEN}\njobs: {}\n`,
        ),
      ],
    });
    expect(leaked.summary.blockers).toEqual([
      expect.objectContaining({
        code: 'SUSPECTED_SECRET',
        subject: 'Action',
        relativePath: 'pipeline.yaml',
      }),
    ]);
    expect(leaked.blobs.size).toBe(0);
  });

  it('stores identical YAML once when it travels under two keys', async () => {
    const result = await analyzeCapabilityPackage({
      rawContent: WORKER_YAML,
      requests: [],
      invocableInventory: emptyInventory(),
      promptSources: [promptSource(`Then run ${WORKER_ID}.`)],
      pipelineInventory: [userPipeline(WORKER_ID, 'Worker')],
      automationPipelines: [
        pipelineInput('action', 'Worker', WORKER_YAML),
        pipelineInput(WORKER_ID, 'Worker', WORKER_YAML),
      ],
    });
    expect(result.summary.state).toBe('ready');
    expect(result.summary.manifest?.resources).toHaveLength(2);
    expect(result.blobs.size).toBe(1);
  });

  it('keeps skill detection unchanged next to pipeline references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-pipeline-skill-'));
    try {
      await mkdir(join(root, 'helper'), { recursive: true });
      await writeFile(join(root, 'helper', 'SKILL.md'), '# Helper\n');
      const result = await analyzeCapabilityPackage({
        rawContent: '{"automation":"example"}',
        requests: [],
        invocableInventory: {
          ...emptyInventory(),
          entries: [
            {
              id: 'helper',
              provider: 'claude',
              kind: 'skill',
              name: 'helper',
              displayName: 'Helper',
              description: '',
              insertText: '/helper ',
              invocationKey: '/helper',
              enableRef: {
                kind: 'skill',
                sourceId: 'custom',
                skillName: 'helper',
              },
            },
          ],
        },
        sourceByInventoryEntryId: {
          helper: {
            sourceRoot: root,
            memberPath: 'helper',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: 'helper',
          },
        },
        promptSources: [
          promptSource(`Use /helper, then run ${ENTRY_ID}. Skip /missing.`),
        ],
        pipelineInventory: [userPipeline(ENTRY_ID, 'Entry')],
        automationPipelines: [pipelineInput(ENTRY_ID, 'Entry', ENTRY_YAML)],
      });
      expect(result.summary.blockers).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_INVOCATION',
          subject: '/missing',
        }),
      ]);
      expect(
        result.summary.manifest?.resources.map((resource) => resource.kind),
      ).toEqual(['standalone_skill', 'automation_pipeline']);
      const bindings = result.summary.manifest?.bindings ?? [];
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toEqual(
        expect.objectContaining({ jobId: 'automation', stepId: 'action' }),
      );
      const boundIds = bindings[0]?.resourceIds ?? [];
      expect(boundIds).toHaveLength(2);
      expect(boundIds).toContain(`automation-pipeline-${ENTRY_ID}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe('file assets', () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'automation-asset-home-'));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    function assetInput(
      sourcePath: string,
      overrides: Partial<{
        assetId: string;
        required: boolean;
        localState: string[];
      }> = {},
    ): FileAssetPortableInput {
      return {
        pipelineKey: 'action',
        assetId: overrides.assetId ?? 'specialists',
        sourcePath,
        required: overrides.required ?? true,
        installMode: 'seed',
        localState: overrides.localState ?? [],
      };
    }

    function analyzeAssets(
      fileAssets: FileAssetPortableInput[],
    ): Promise<CapabilityPackageAnalysisInternal> {
      return analyzeCapabilityPackage({
        rawContent: ENTRY_YAML,
        requests: [],
        invocableInventory: emptyInventory(),
        automationPipelines: [pipelineInput('action', 'Entry', ENTRY_YAML)],
        fileAssets,
        homedir: home,
      });
    }

    it('withholds credential files, symlinks and git directories', async () => {
      const assetDir = join(home, 'journey', 'specialists');
      await mkdir(join(assetDir, 'nested', '.git'), { recursive: true });
      await writeFile(join(assetDir, 'designer.json'), '{"role":"design"}\n');
      await writeFile(join(assetDir, 'nested', 'notes.md'), '# Notes\n');
      await writeFile(join(assetDir, '.env'), 'PLAIN=1\n');
      await writeFile(
        join(assetDir, 'leaked.json'),
        `{"note": "${LITERAL_TOKEN}"}\n`,
      );
      await writeFile(join(assetDir, 'nested', '.git', 'config'), '[core]\n');
      await symlink(
        join(assetDir, 'designer.json'),
        join(assetDir, 'linked.json'),
      );

      const result = await analyzeAssets([assetInput('~/journey/specialists')]);

      expect(result.summary.blockers).toEqual([]);
      expect(result.summary.state).toBe('ready');
      expect(
        [...(result.summary.withheldFiles ?? [])].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        ),
      ).toEqual([
        {
          pipelineKey: 'action',
          assetId: 'specialists',
          relativePath: '.env',
          reason: 'denied_name',
        },
        {
          pipelineKey: 'action',
          assetId: 'specialists',
          relativePath: 'leaked.json',
          reason: 'suspected_secret',
        },
        {
          pipelineKey: 'action',
          assetId: 'specialists',
          relativePath: 'linked.json',
          reason: 'symlink',
        },
        {
          pipelineKey: 'action',
          assetId: 'specialists',
          relativePath: 'nested/.git',
          reason: 'git_directory',
        },
      ]);
      const manifest = result.summary.manifest;
      expect(manifest && validatePipelinePackageManifest(manifest)).toEqual({
        ok: true,
      });
      const asset = manifest?.resources.find(
        (resource) => resource.kind === 'file_asset',
      );
      expect(asset).toEqual(
        expect.objectContaining({
          id: 'file-asset-action-specialists',
          pipelineKey: 'action',
          assetId: 'specialists',
          installMode: 'seed',
          required: true,
          trees: [
            expect.objectContaining({
              runtimeKind: 'pipeline_asset',
              rootName: 'specialists',
              entries: [
                expect.objectContaining({ path: 'designer.json' }),
                expect.objectContaining({ path: 'nested/notes.md' }),
              ],
            }),
          ],
        }),
      );
      expect(
        manifest?.resources.find(
          (resource) => resource.kind === 'automation_pipeline',
        )?.dependencyResourceIds,
      ).toEqual(['file-asset-action-specialists']);
      expect(manifest?.totalFiles).toBe(3);
    });

    it('still blocks native executables inside an asset', async () => {
      const assetDir = join(home, 'tools');
      await mkdir(assetDir, { recursive: true });
      await writeFile(
        join(assetDir, 'tool'),
        new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0]),
      );
      const result = await analyzeAssets([
        assetInput(assetDir, { assetId: 'tools' }),
      ]);
      expect(result.summary.blockers).toEqual([
        expect.objectContaining({ code: 'NATIVE_EXECUTABLE_BLOCKED' }),
      ]);
    });

    it.each([
      ['local_state inside the asset', '~/journey', ['~/journey/state.db']],
      ['the asset inside local_state', '~/journey/specialists', ['~/journey']],
      ['the same folder', '~/journey', ['~/journey/']],
    ])('blocks %s', async (_label, assetPath, localState) => {
      await mkdir(join(home, 'journey', 'specialists'), { recursive: true });
      const result = await analyzeAssets([
        assetInput(assetPath, { localState }),
      ]);
      expect(result.summary.blockers).toEqual([
        expect.objectContaining({
          code: 'ASSET_OVERLAPS_LOCAL_STATE',
          subject: 'action/specialists',
        }),
      ]);
    });

    it('allows local_state next to the asset', async () => {
      await mkdir(join(home, 'journey', 'specialists'), { recursive: true });
      const result = await analyzeAssets([
        assetInput('~/journey/specialists', {
          localState: ['~/journey/state.db', '~/journey/checkout'],
        }),
      ]);
      expect(result.summary.blockers).toEqual([]);
    });

    it.each([
      ['an absolute path outside home', '/etc'],
      ['a relative path', 'journey/specialists'],
      ['home itself', '~'],
      ['a path that climbs out of home', '~/../elsewhere'],
    ])('blocks %s', async (_label, assetPath) => {
      const result = await analyzeAssets([assetInput(assetPath)]);
      expect(result.summary.blockers).toEqual([
        expect.objectContaining({ code: 'ASSET_PATH_OUTSIDE_HOME' }),
      ]);
    });

    it('blocks a missing required asset and withholds a missing optional one', async () => {
      const required = await analyzeAssets([assetInput('~/absent')]);
      expect(required.summary.blockers).toEqual([
        expect.objectContaining({
          code: 'MISSING_REQUIRED_ASSET',
          subject: 'action/specialists',
        }),
      ]);

      const optional = await analyzeAssets([
        assetInput('~/absent', { required: false }),
      ]);
      expect(optional.summary.blockers).toEqual([]);
      expect(optional.summary.withheldFiles).toEqual([
        {
          pipelineKey: 'action',
          assetId: 'specialists',
          relativePath: '',
          reason: 'missing_optional_asset',
        },
      ]);
      expect(
        optional.summary.manifest?.resources.map((resource) => resource.kind),
      ).toEqual(['automation_pipeline']);
      await expect(pipelinePackageAnalysisIsStale(optional)).resolves.toBe(
        false,
      );
      await mkdir(join(home, 'absent'));
      await expect(pipelinePackageAnalysisIsStale(optional)).resolves.toBe(
        true,
      );
    });

    it('packages an empty asset folder as an empty tree', async () => {
      await mkdir(join(home, 'empty'));
      const result = await analyzeAssets([assetInput('~/empty')]);
      expect(result.summary.blockers).toEqual([]);
      const manifest = result.summary.manifest;
      expect(manifest && validatePipelinePackageManifest(manifest)).toEqual({
        ok: true,
      });
      expect(
        manifest?.resources.find((resource) => resource.kind === 'file_asset')
          ?.trees,
      ).toEqual([
        {
          provider: 'claude',
          runtimeKind: 'pipeline_asset',
          rootName: 'specialists',
          entries: [],
        },
      ]);
    });

    it('ignores assets of a pipeline that is not packaged', async () => {
      await mkdir(join(home, 'journey'), { recursive: true });
      const result = await analyzeCapabilityPackage({
        rawContent: '{"automation":"example"}',
        requests: [],
        invocableInventory: emptyInventory(),
        promptSources: [promptSource('Hand off to Worker.')],
        pipelineInventory: [userPipeline(WORKER_ID, 'Worker')],
        automationPipelines: [pipelineInput(WORKER_ID, 'Worker', WORKER_YAML)],
        fileAssets: [{ ...assetInput('~/journey'), pipelineKey: WORKER_ID }],
        homedir: home,
      });
      expect(result.summary.manifest?.resources).toEqual([]);
      expect(result.summary.withheldFiles).toBeUndefined();
    });
  });
});
