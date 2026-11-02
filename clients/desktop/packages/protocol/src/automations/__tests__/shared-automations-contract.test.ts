import type { ShareablePluginRef } from '../../plugins';
import {
  CANOPY_SERVER_CAPABILITIES,
  REQUIRED_CANOPY_SERVER_CAPABILITIES,
} from '../../canopy-server';
import {
  AUTOMATION_SHARE_SCOPES,
  CODEX_SPEEDS,
  isCodexSpeed,
  MAX_SHARED_AUTOMATION_BYTES,
  MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES,
  MAX_SHARED_AUTOMATION_NAME_LENGTH,
  MAX_SHARED_AUTOMATION_PROMPT_BYTES,
  MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS,
  SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
  SHARED_AUTOMATION_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY,
  SHARED_AUTOMATION_RUN_CONDITION_API_VERSION,
  SHARED_AUTOMATION_RUN_CONDITION_CAPABILITY,
  SHARED_AUTOMATION_INTERFACE_MODES,
  SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY,
  SHARED_AUTOMATION_THINKING_LEVELS,
  isSharedAutomationContentHash,
  canonicalizeSharedAutomationPrompt,
  isSharedAutomationDocument,
  sharedAutomationPromptSpansError,
  validateSharedAutomationDocument,
  type AutomationShareScope,
  type CreateSharedAutomationRequest,
  type DeleteSharedAutomationRequest,
  type GetSharedAutomationRequest,
  type ListSharedAutomationsRequest,
  type ListSharedAutomationsResponse,
  type SharedAutomationAction,
  type SharedAutomationActionType,
  type SharedAutomationDetail,
  type SharedAutomationDocument,
  type SharedAutomationSummary,
  type UpdateSharedAutomationRequest,
} from '../index';
import { PIPELINE_PACKAGE_MAX_FILE_BYTES } from '../../pipelines/package';

const pluginRef: ShareablePluginRef = {
  type: 'skill',
  source: { type: 'builtin', id: 'app' },
  skill_name: 'commit-messages',
};

function makeDocument(
  overrides: Partial<SharedAutomationDocument> = {},
): SharedAutomationDocument {
  return {
    version: 1,
    name: 'Nightly triage',
    description: 'Runs a triage prompt every night.',
    trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'app_advisor_prompt',
      prompt: 'Triage the inbox.',
      plugins: [pluginRef],
    },
    hasRunCondition: false,
    ...overrides,
  };
}

/**
 * Build a document with contract-violating overrides. Returns `unknown` so
 * invalid shapes can be represented without forcing values past type checking
 * with non-const assertions.
 */
function makeInvalidDocument(overrides: Record<string, unknown>): unknown {
  return { ...makeDocument(), ...overrides };
}

function makeWorktreePromptAction(): SharedAutomationAction {
  return {
    type: 'worktree_prompt',
    target: { kind: 'workspace' },
    existingBranch: 'develop',
    prompt: 'Fix the flaky tests.',
    modelConfig: { model: 'sonnet', thinkingLevel: 'high', fastMode: false },
    plugins: [pluginRef],
    planMode: true,
    interfaceMode: 'canopy',
  };
}

function makeWorktreePipelineAction(): SharedAutomationAction {
  return {
    type: 'worktree_pipeline',
    target: { kind: 'workspace' },
    pipeline: { source: 'bundled', pipelineId: 'code-review', name: 'Review' },
    inputKeys: ['branch', 'ticket'],
  };
}

function expectRejected(value: unknown, errorFragment: string): void {
  const result = validateSharedAutomationDocument(value);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain(errorFragment);
  }
}

describe('shared-Automation API contract', () => {
  it('preserves and normalizes version-3 target declarations', () => {
    const result = validateSharedAutomationDocument({
      ...makeDocument({ action: makeWorktreePipelineAction() }),
      version: 3,
      targetRequirement: { contexts: ['worktree', 'cowork'] },
    });
    expect(result).toMatchObject({
      ok: true,
      document: {
        version: 3,
        targetRequirement: { contexts: ['cowork', 'worktree'] },
      },
    });
  });

  it.each([
    { contexts: [] },
    { contexts: ['cowork', 'cowork'] },
    { contexts: ['unknown'] },
    { contexts: ['cowork'], extra: true },
    { contexts: ['app_advisor'] },
  ])('rejects invalid pipeline declarations: %j', (targetRequirement) => {
    expect(
      validateSharedAutomationDocument({
        ...makeDocument({ action: makeWorktreePipelineAction() }),
        version: 3,
        targetRequirement,
      }).ok,
    ).toBe(false);
  });

  it.each([1, 2])('rejects targetRequirement on version %s', (version) => {
    expect(
      validateSharedAutomationDocument({
        ...makeDocument(),
        version,
        targetRequirement: { contexts: ['app_advisor'] },
      }).ok,
    ).toBe(false);
  });

  it('accepts v3 without a declaration and preserves v2 prompt references', () => {
    expect(
      validateSharedAutomationDocument({ ...makeDocument(), version: 3 }),
    ).toMatchObject({ ok: true });
    const action = {
      type: 'standalone_prompt',
      target: { kind: 'cowork' },
      prompt: 'Read README.md',
      plugins: [],
      promptReferences: [
        {
          kind: 'file',
          textStart: 5,
          displayText: 'README.md',
          root: { kind: 'workspace' },
          relativePath: 'README.md',
        },
      ],
    };
    expect(
      validateSharedAutomationDocument({
        ...makeDocument(),
        version: 3,
        action,
        targetRequirement: { contexts: ['cowork'] },
      }),
    ).toMatchObject({ ok: true, document: { action } });
  });

  it('accepts a version-2 prompt with a portable logical file reference', () => {
    const action = {
      type: 'worktree_prompt',
      target: { kind: 'workspace' },
      prompt: 'Read src/a.ts',
      plugins: [],
      promptReferences: [
        {
          kind: 'file',
          textStart: 5,
          displayText: 'src/a.ts',
          root: { kind: 'workspace' },
          relativePath: 'src/a.ts',
        },
      ],
    };
    const result = validateSharedAutomationDocument(
      makeInvalidDocument({ version: 2, action }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.document.action.type === 'worktree_prompt') {
      expect(result.document.action.promptReferences).toEqual(
        action.promptReferences,
      );
    }
  });

  it('rejects a prompt plugin that is absent from the shared install review list', () => {
    const action = {
      type: 'app_advisor_prompt',
      prompt: 'Use plugin',
      plugins: [],
      promptReferences: [
        {
          kind: 'plugin',
          textStart: 4,
          displayText: 'plugin',
          plugin: { kind: 'portable', ref: pluginRef },
        },
      ],
    };
    expectRejected(
      makeInvalidDocument({ version: 2, action }),
      'must also be listed',
    );
  });

  it('accepts a prompt plugin included in the shared install review list', () => {
    const action = {
      type: 'app_advisor_prompt',
      prompt: 'Use plugin',
      plugins: [pluginRef],
      promptReferences: [
        {
          kind: 'plugin',
          textStart: 4,
          displayText: 'plugin',
          plugin: { kind: 'portable', ref: pluginRef },
        },
      ],
    };
    expect(
      validateSharedAutomationDocument(
        makeInvalidDocument({ version: 2, action }),
      ).ok,
    ).toBe(true);
  });

  it('pins version, scope set, byte ceilings, and portable enums', () => {
    expect(SHARED_AUTOMATION_API_VERSION).toBe(1);
    expect(MAX_SHARED_AUTOMATION_BYTES).toBe(256 * 1024);
    expect(MAX_SHARED_AUTOMATION_NAME_LENGTH).toBe(200);
    expect(MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES).toBe(4 * 1024);
    expect(MAX_SHARED_AUTOMATION_PROMPT_BYTES).toBe(64 * 1024);
    expect(AUTOMATION_SHARE_SCOPES).toEqual([
      'private',
      'team',
      'organization',
    ]);
    expect(SHARED_AUTOMATION_THINKING_LEVELS).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(SHARED_AUTOMATION_INTERFACE_MODES).toEqual([
      'canopy',
      'claude-code',
      'auto',
    ]);
  });

  it('AutomationShareScope union spans the scope tuple', () => {
    const cases: AutomationShareScope[] = ['private', 'team', 'organization'];
    for (const value of cases) {
      expect(AUTOMATION_SHARE_SCOPES).toContain(value);
    }
  });

  it('SharedAutomationActionType includes the portable Cowork action', () => {
    const actionType: SharedAutomationActionType = 'standalone_prompt';
    expect(actionType).toBe('standalone_prompt');
  });

  it('advertises shared Automation CRUD as optional server capability', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('automations-crud-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'automations-crud-v1',
    );
  });

  describe('validateSharedAutomationDocument — accepted documents', () => {
    it('recognizes only canonical shared automation content hashes', () => {
      expect(isSharedAutomationContentHash('a'.repeat(64))).toBe(true);
      expect(isSharedAutomationContentHash('A'.repeat(64))).toBe(false);
      expect(isSharedAutomationContentHash('a'.repeat(63))).toBe(false);
      expect(isSharedAutomationContentHash(undefined)).toBe(false);
    });

    it('accepts a well-formed app_advisor_prompt document', () => {
      const result = validateSharedAutomationDocument(makeDocument());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.document).toEqual(makeDocument());
      }
      expect(isSharedAutomationDocument(makeDocument())).toBe(true);
    });

    it('accepts a worktree_prompt document with full optional fields', () => {
      const document = makeDocument({ action: makeWorktreePromptAction() });
      const result = validateSharedAutomationDocument(document);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.document).toEqual(document);
      }
    });

    it('accepts a worktree_pipeline document with a bundled pipeline ref', () => {
      const document = makeDocument({ action: makeWorktreePipelineAction() });
      const result = validateSharedAutomationDocument(document);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.document).toEqual(document);
      }
    });

    it('accepts a worktree_pipeline document with a shared pipeline ref', () => {
      const document = makeDocument({
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'shared',
            remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
            name: 'Team review',
            installPin: {
              pipelineContentHash: 'a'.repeat(64),
              distributionMode: 'package',
              packageDigest: `pp:v1:${'a'.repeat(43)}`,
            },
          },
          inputKeys: [],
        },
      });
      expect(validateSharedAutomationDocument(document).ok).toBe(true);
    });

    it.each([
      ['without origin', undefined],
      [
        'with origin',
        {
          remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
          installPin: {
            pipelineContentHash: 'a'.repeat(64),
            distributionMode: 'package' as const,
            packageDigest: `pp:v1:${'a'.repeat(43)}`,
          },
        },
      ],
    ])('accepts an inline pipeline ref %s', (_label, origin) => {
      const pipeline = {
        source: 'inline' as const,
        name: 'Team review',
        rawPipeline: 'pipeline:\n  id: review\n  jobs: []\n',
        pipelineContentHash: 'a'.repeat(64),
        ...(origin === undefined ? {} : { origin }),
      };
      const document = makeDocument({
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline,
          inputKeys: [],
        },
      });

      const result = validateSharedAutomationDocument(document);
      expect(result.ok).toBe(true);
      if (result.ok && result.document.action.type === 'worktree_pipeline') {
        expect(result.document.action.pipeline).toEqual(pipeline);
      }
    });

    it('keeps legacy v1 shared pipeline refs readable without making them installable', () => {
      const document = makeInvalidDocument({
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'shared',
            remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
            name: 'Legacy team review',
            contentHash: 'legacy-content-hash',
          },
          inputKeys: [],
        },
      });

      const result = validateSharedAutomationDocument(document);
      expect(result.ok).toBe(true);
      if (!result.ok || result.document.action.type !== 'worktree_pipeline') {
        return;
      }
      expect(result.document.action.pipeline).toEqual({
        source: 'shared',
        remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
        name: 'Legacy team review',
        contentHash: 'legacy-content-hash',
      });
    });

    it('accepts and rebuilds portable Cowork, curated, and unresolved variants', () => {
      const coworkDocument = makeDocument({
        action: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: 'Summarize the project.',
          modelConfig: { model: 'sonnet', thinkingLevel: 'medium' },
          plugins: [pluginRef],
        },
      });
      const curatedDocument = makeDocument({
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'curated',
            curatedKey: 'review/default',
            name: 'Review',
          },
          inputKeys: [],
        },
      });
      const unresolvedDocument = makeDocument({
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: { source: 'unresolved', name: 'Local review' },
          inputKeys: [],
        },
      });

      for (const document of [
        coworkDocument,
        curatedDocument,
        unresolvedDocument,
      ]) {
        const result = validateSharedAutomationDocument(document);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.document).toEqual(document);
        }
      }
    });

    it('accepts an optional capability package ref', () => {
      const document = makeDocument({
        capabilityPackage: {
          version: 1,
          digest: `pp:v1:${'b'.repeat(43)}`,
        },
      });
      const result = validateSharedAutomationDocument(document);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.document).toEqual(document);
      }
    });

    it('accepts a one_time trigger with a parseable ISO timestamp', () => {
      const document = makeDocument({
        trigger: {
          kind: 'one_time',
          runAt: '2026-09-01T09:00:00.000Z',
          timezone: 'local',
        },
      });
      expect(validateSharedAutomationDocument(document).ok).toBe(true);
    });

    it('accepts an empty description and empty plugin list', () => {
      const document = makeDocument({
        description: '',
        action: { type: 'app_advisor_prompt', prompt: 'Go.', plugins: [] },
      });
      expect(validateSharedAutomationDocument(document).ok).toBe(true);
    });

    it('accepts cron expressions using ranges, lists, and steps', () => {
      const document = makeDocument({
        trigger: {
          kind: 'cron',
          expression: '*/15 0-6 1,15 * 1-5',
          timezone: 'local',
        },
      });
      expect(validateSharedAutomationDocument(document).ok).toBe(true);
    });

    it('rebuilds plugin refs through normalization so unknown fields are stripped', () => {
      const document = makeInvalidDocument({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Go.',
          plugins: [
            {
              type: 'skill',
              source: { type: 'builtin', id: 'app' },
              skill_name: 'Commit-Messages ',
              apiToken: 'secret-value',
              localPath: '/Users/author/.canopy/skills',
            },
          ],
        },
      });
      const result = validateSharedAutomationDocument(document);
      expect(result.ok).toBe(true);
      if (result.ok && result.document.action.type === 'app_advisor_prompt') {
        expect(result.document.action.plugins).toEqual([
          {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'Commit-Messages',
          },
        ]);
      }
    });

    it('sorts and dedupes worktree_pipeline inputKeys in the rebuilt document', () => {
      const document = makeDocument({
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: { source: 'bundled', pipelineId: 'code-review' },
          inputKeys: ['ticket', 'branch', 'ticket'],
        },
      });
      const result = validateSharedAutomationDocument(document);
      expect(result.ok).toBe(true);
      if (result.ok && result.document.action.type === 'worktree_pipeline') {
        expect(result.document.action.inputKeys).toEqual(['branch', 'ticket']);
      }
    });
  });

  describe('version-4 run conditions', () => {
    function makeV4(overrides: Record<string, unknown> = {}): unknown {
      return {
        ...makeDocument({ hasRunCondition: true }),
        version: SHARED_AUTOMATION_RUN_CONDITION_API_VERSION,
        runCondition: { command: '  test -f ready  ' },
        ...overrides,
      };
    }

    it('advertises the v4 capability from the server capability list', () => {
      expect(SHARED_AUTOMATION_RUN_CONDITION_API_VERSION).toBe(4);
      expect(CANOPY_SERVER_CAPABILITIES).toContain(
        SHARED_AUTOMATION_RUN_CONDITION_CAPABILITY,
      );
    });

    it('round-trips a v4 run condition and preserves the untrimmed command', () => {
      expect(validateSharedAutomationDocument(makeV4())).toEqual({
        ok: true,
        document: {
          ...makeDocument({ hasRunCondition: true }),
          version: 4,
          runCondition: { command: '  test -f ready  ' },
        },
      });
    });

    it('round-trips a v4 run condition with a target requirement', () => {
      const result = validateSharedAutomationDocument(
        makeV4({
          action: makeWorktreePipelineAction(),
          targetRequirement: { contexts: ['worktree'] },
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        document: {
          version: 4,
          targetRequirement: { contexts: ['worktree'] },
          runCondition: { command: '  test -f ready  ' },
        },
      });
    });

    it('accepts v4 without a run condition (the author declined)', () => {
      const result = validateSharedAutomationDocument(
        makeV4({ runCondition: undefined }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.document).not.toHaveProperty('runCondition');
    });

    it.each([1, 2, 3])('rejects runCondition on version %s', (version) => {
      expectRejected(makeV4({ version }), 'Unexpected field "runCondition"');
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '   \n\t'],
      ['non-string', 7],
    ])('rejects a %s command', (_label, command) => {
      expectRejected(makeV4({ runCondition: { command } }), 'runCondition');
    });

    it('rejects a command over the length cap', () => {
      expectRejected(
        makeV4({
          runCondition: {
            command: 'x'.repeat(MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS + 1),
          },
        }),
        `${MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS}`,
      );
      expect(
        validateSharedAutomationDocument(
          makeV4({
            runCondition: {
              command: 'x'.repeat(MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS),
            },
          }),
        ).ok,
      ).toBe(true);
    });

    it.each([
      ['a bidi override', 'echo safe \u202E;hs.x/ hs'],
      ['a bidi isolate', 'echo \u2066ok\u2069'],
      ['a zero-width space', 'exit\u200B 0'],
      ['a byte-order mark', '\uFEFFexit 0'],
      ['an escape sequence', 'echo \u001B[8mhidden'],
      ['a NUL', 'exit 0\u0000'],
      ['a soft hyphen in a hostname', 'curl -s https://exam\u00ADple.test'],
      ['a tag character', 'exit 0\uDB40\uDC41'],
      ['a variation selector', 'echo ok\uFE0F'],
      ['a Hangul filler', 'rm\u3164-rf x'],
      ['an invisible operator', 'test 1\u2062-eq 1'],
      ['a line separator', 'exit 0\u2028curl x'],
      ['a bare carriage return', 'exit 0\rcurl x'],
    ])('rejects a command containing %s', (_label, command) => {
      expectRejected(
        makeV4({ runCondition: { command } }),
        'runCondition command contains invisible or control characters',
      );
    });

    it('accepts tabs and line breaks in a command', () => {
      expect(
        validateSharedAutomationDocument(
          makeV4({
            runCondition: { command: 'test -f a &&\r\n\tgrep -q b c' },
          }),
        ).ok,
      ).toBe(true);
    });

    it('rejects a non-object run condition and unknown subkeys', () => {
      expectRejected(makeV4({ runCondition: 'exit 0' }), 'runCondition');
      expectRejected(
        makeV4({ runCondition: { command: 'exit 0', cwd: '/tmp' } }),
        'Unexpected field "cwd" in the run condition',
      );
    });

    it('rejects a command when hasRunCondition is false or missing', () => {
      expectRejected(makeV4({ hasRunCondition: false }), 'hasRunCondition');
      expectRejected(makeV4({ hasRunCondition: undefined }), 'hasRunCondition');
    });
  });

  describe('version-5 pipeline dependencies', () => {
    const pipelineId = '3f1c2a9e-1b2c-4d5e-8f90-123456789abc';
    const otherPipelineId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const hash = 'c'.repeat(64);
    const capabilityPackage = {
      version: 1,
      digest: `pp:v1:${'b'.repeat(43)}`,
    } as const;
    const prompt = `Run ${pipelineId} then ${otherPipelineId}, and ${pipelineId} again.`;

    function packagedDependency(
      key: string,
      spans: unknown[],
    ): Record<string, unknown> {
      return {
        key,
        pipeline: { source: 'packaged', key, pipelineContentHash: hash },
        promptSpans: spans,
      };
    }

    function spansOf(
      text: string,
      within: string = prompt,
    ): Array<{ textStart: number; text: string }> {
      const spans: Array<{ textStart: number; text: string }> = [];
      let index = within.indexOf(text);
      while (index !== -1) {
        spans.push({ textStart: index, text });
        index = within.indexOf(text, index + text.length);
      }
      return spans;
    }

    function makeV5(
      dependencies: unknown,
      overrides: Record<string, unknown> = {},
      actionPrompt: string = prompt,
    ): unknown {
      return {
        ...makeDocument(),
        version: SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION,
        capabilityPackage,
        action: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: actionPrompt,
          plugins: [],
          pipelineDependencies: dependencies,
        },
        ...overrides,
      };
    }

    function makeV5Pipeline(
      pipeline: unknown,
      overrides: Record<string, unknown> = {},
    ): unknown {
      return {
        ...makeDocument(),
        version: SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION,
        capabilityPackage,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline,
          inputKeys: [],
        },
        ...overrides,
      };
    }

    it('advertises the v5 capability from the server capability list', () => {
      expect(SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION).toBe(5);
      expect(SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY).toBe(
        'automations-pipeline-dependencies-v5',
      );
      expect(CANOPY_SERVER_CAPABILITIES).toContain(
        SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY,
      );
      expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
        SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY,
      );
    });

    it('round-trips packaged and plain dependencies with repeated spans', () => {
      const dependencies = [
        packagedDependency(pipelineId, spansOf(pipelineId)),
        packagedDependency(otherPipelineId, spansOf(otherPipelineId)),
        {
          key: 'shared-reviewer',
          pipeline: { source: 'shared', remoteId: 'remote-1', name: 'Review' },
          promptSpans: [],
        },
        {
          key: 'bundled-triage',
          pipeline: { source: 'bundled', pipelineId: 'triage' },
          promptSpans: [],
        },
        {
          key: 'curated-digest',
          pipeline: { source: 'curated', curatedKey: 'digest' },
          promptSpans: [],
        },
      ];
      const document = makeV5(dependencies);
      expect(validateSharedAutomationDocument(document)).toEqual({
        ok: true,
        document,
      });
      expect(spansOf(pipelineId)).toHaveLength(2);
    });

    it.each(['app_advisor_prompt', 'worktree_prompt'])(
      'accepts dependencies on %s',
      (type) => {
        const base =
          type === 'worktree_prompt'
            ? { type, target: { kind: 'workspace' } }
            : { type };
        const result = validateSharedAutomationDocument(
          makeV5(undefined, {
            action: {
              ...base,
              prompt,
              plugins: [],
              pipelineDependencies: [
                packagedDependency(pipelineId, spansOf(pipelineId)),
              ],
            },
          }),
        );
        expect(result.ok).toBe(true);
      },
    );

    it('accepts a packaged worktree_pipeline action keyed "action" and a v5 run condition', () => {
      const document = makeV5Pipeline(
        {
          source: 'packaged',
          key: 'action',
          pipelineContentHash: hash,
          name: 'Entry',
        },
        { hasRunCondition: true, runCondition: { command: 'test -f ready' } },
      );
      expect(validateSharedAutomationDocument(document)).toEqual({
        ok: true,
        document,
      });
    });

    it('rejects a packaged action pipeline with a key other than "action"', () => {
      expectRejected(
        makeV5Pipeline({
          source: 'packaged',
          key: pipelineId,
          pipelineContentHash: hash,
        }),
        'must use the key "action"',
      );
    });

    it('rejects packaged refs without a capability package', () => {
      expectRejected(
        makeV5Pipeline(
          { source: 'packaged', key: 'action', pipelineContentHash: hash },
          { capabilityPackage: undefined },
        ),
        'require the document to carry a capability package',
      );
      expectRejected(
        makeV5([packagedDependency(pipelineId, spansOf(pipelineId))], {
          capabilityPackage: undefined,
        }),
        'require the document to carry a capability package',
      );
    });

    it.each([1, 2, 3, 4])(
      'rejects packaged refs and pipelineDependencies on version %s',
      (version) => {
        expectRejected(
          makeV5Pipeline(
            { source: 'packaged', key: 'action', pipelineContentHash: hash },
            { version },
          ),
          'require version 5',
        );
        expectRejected(
          makeV5([packagedDependency(pipelineId, spansOf(pipelineId))], {
            version,
          }),
          'Unexpected field "pipelineDependencies"',
        );
      },
    );

    it('rejects malformed packaged refs', () => {
      expectRejected(
        makeV5Pipeline({ source: 'packaged', key: 'action' }),
        'invalid content hash',
      );
      expectRejected(
        makeV5Pipeline({
          source: 'packaged',
          key: '../escape',
          pipelineContentHash: hash,
        }),
        'invalid key',
      );
      expectRejected(
        makeV5Pipeline({
          source: 'packaged',
          key: 'action',
          pipelineContentHash: hash,
          rawPipeline: 'name: x',
        }),
        'Unexpected field "rawPipeline"',
      );
    });

    it('rejects duplicate, invalid, and reserved dependency keys', () => {
      expectRejected(
        makeV5([
          packagedDependency(pipelineId, []),
          packagedDependency(pipelineId, []),
        ]),
        'Duplicate automation pipeline dependency key',
      );
      for (const key of ['', 'has space', '../escape', 'action', 7]) {
        expectRejected(
          makeV5([
            {
              key,
              pipeline: { source: 'bundled', pipelineId: 'triage' },
              promptSpans: [],
            },
          ]),
          'invalid key',
        );
      }
    });

    it('rejects a packaged dependency whose pipeline key differs from the dependency key', () => {
      expectRejected(
        makeV5([
          {
            ...packagedDependency(pipelineId, []),
            key: otherPipelineId,
          },
        ]),
        'dependency key must equal its pipeline key',
      );
    });

    it('rejects inline and unresolved dependencies and unknown fields', () => {
      expectRejected(
        makeV5([
          {
            key: 'inline-one',
            pipeline: {
              source: 'inline',
              rawPipeline: 'name: x',
              pipelineContentHash: hash,
            },
            promptSpans: [],
          },
        ]),
        'must be packaged, bundled, curated, or shared',
      );
      expectRejected(
        makeV5([
          {
            key: 'unresolved-one',
            pipeline: { source: 'unresolved' },
            promptSpans: [],
          },
        ]),
        'must be packaged, bundled, curated, or shared',
      );
      expectRejected(
        makeV5([{ ...packagedDependency(pipelineId, []), localPath: '/x' }]),
        'Unexpected field "localPath"',
      );
      expectRejected(makeV5({}), 'pipelineDependencies must be an array');
    });

    it('rejects prompt spans on non-packaged dependencies', () => {
      expectRejected(
        makeV5([
          {
            key: 'bundled-triage',
            pipeline: { source: 'bundled', pipelineId: 'triage' },
            promptSpans: spansOf(pipelineId).slice(0, 1),
          },
        ]),
        'Only packaged automation pipeline dependencies may carry prompt spans',
      );
    });

    it('rejects overlapping spans within and across dependencies', () => {
      const [first] = spansOf(pipelineId);
      expectRejected(
        makeV5([packagedDependency(pipelineId, [first, first])]),
        'must not overlap',
      );
      expectRejected(
        makeV5([
          packagedDependency(pipelineId, [first]),
          packagedDependency(otherPipelineId, [
            {
              textStart: first.textStart + 4,
              text: prompt.slice(first.textStart + 4, first.textStart + 10),
            },
          ]),
        ]),
        'must not overlap',
      );
    });

    it('accepts adjacent spans that touch without overlapping', () => {
      const adjacentPrompt = `${pipelineId}${otherPipelineId}`;
      const result = validateSharedAutomationDocument(
        makeV5(
          [
            packagedDependency(pipelineId, spansOf(pipelineId, adjacentPrompt)),
            packagedDependency(
              otherPipelineId,
              spansOf(otherPipelineId, adjacentPrompt),
            ),
          ],
          {},
          adjacentPrompt,
        ),
      );
      expect(result.ok).toBe(true);
    });

    it('rejects a span whose text no longer matches the prompt slice', () => {
      const [first] = spansOf(pipelineId);
      expectRejected(
        makeV5([
          packagedDependency(pipelineId, [
            { textStart: first.textStart + 1, text: pipelineId },
          ]),
        ]),
        'span text does not match the prompt',
      );
    });

    it.each([
      ['past the end', { textStart: prompt.length - 2, text: 'abc' }],
      ['negative', { textStart: -1, text: 'R' }],
      ['fractional', { textStart: 1.5, text: 'u' }],
      ['empty', { textStart: 0, text: '' }],
    ])('rejects a span that is %s', (_label, span) => {
      expectRejected(
        makeV5([packagedDependency(pipelineId, [span])]),
        'outside the prompt',
      );
    });

    it('rejects malformed span objects', () => {
      expectRejected(
        makeV5([
          packagedDependency(pipelineId, [{ textStart: '4', text: 'x' }]),
        ]),
        'promptSpans must be',
      );
      expectRejected(
        makeV5([
          packagedDependency(pipelineId, [
            { textStart: 4, text: pipelineId, extra: true },
          ]),
        ]),
        'Unexpected field "extra"',
      );
    });

    it('validates spans against the canonical prompt with CRLF and leading whitespace', () => {
      const rawPrompt = `\r\n  \tUse ${pipelineId}\r\nthen stop.  `;
      expect(canonicalizeSharedAutomationPrompt(rawPrompt)).toBe(rawPrompt);
      const canonical = canonicalizeSharedAutomationPrompt(rawPrompt);
      const document = makeV5(
        [packagedDependency(pipelineId, spansOf(pipelineId, canonical))],
        {},
        rawPrompt,
      );
      expect(validateSharedAutomationDocument(document)).toEqual({
        ok: true,
        document,
      });
      // Offsets computed on a trimmed or LF-normalized prompt never shift into
      // place: they are rejected.
      const trimmed = rawPrompt.trim();
      expectRejected(
        makeV5(
          [packagedDependency(pipelineId, spansOf(pipelineId, trimmed))],
          {},
          rawPrompt,
        ),
        'span text does not match the prompt',
      );
      expect(
        sharedAutomationPromptSpansError(canonical, [
          {
            key: pipelineId,
            pipeline: {
              source: 'packaged',
              key: pipelineId,
              pipelineContentHash: hash,
            },
            promptSpans: spansOf(pipelineId, canonical),
          },
        ]),
      ).toBeNull();
    });

    it('leaves v1 through v4 documents unchanged', () => {
      const documents: SharedAutomationDocument[] = [
        makeDocument(),
        makeDocument({ version: 2 }),
        makeDocument({
          version: 3,
          action: makeWorktreePipelineAction(),
          targetRequirement: { contexts: ['worktree'] },
        }),
        makeDocument({
          version: 4,
          hasRunCondition: true,
          runCondition: { command: 'exit 0' },
          capabilityPackage,
        }),
      ];
      for (const document of documents) {
        expect(validateSharedAutomationDocument(document)).toEqual({
          ok: true,
          document,
        });
      }
    });
  });

  describe('validateSharedAutomationDocument — structural rejection', () => {
    it('rejects non-object values', () => {
      expectRejected(null, 'must be an object');
      expectRejected('automation', 'must be an object');
      expectRejected([makeDocument()], 'must be an object');
    });

    it('rejects an unsupported version', () => {
      expectRejected(makeInvalidDocument({ version: 7 }), 'version');
      expectRejected(
        makeInvalidDocument({ version: 7 }),
        'Unsupported shared Automation version',
      );
    });

    it('rejects unknown top-level fields so non-portable state cannot ride along', () => {
      expectRejected(
        makeInvalidDocument({ workspaceId: 'ws-1' }),
        'Unexpected field',
      );
    });

    it('rejects a missing or blank name', () => {
      expectRejected(makeDocument({ name: '' }), 'name');
      expectRejected(makeDocument({ name: '   ' }), 'name');
    });

    it('rejects a name over the length cap', () => {
      expectRejected(
        makeDocument({
          name: 'x'.repeat(MAX_SHARED_AUTOMATION_NAME_LENGTH + 1),
        }),
        `${MAX_SHARED_AUTOMATION_NAME_LENGTH}`,
      );
    });

    it('rejects a non-string description and one over the byte cap', () => {
      expectRejected(makeInvalidDocument({ description: 7 }), 'description');
      expectRejected(
        makeDocument({
          description: 'x'.repeat(MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES + 1),
        }),
        `${MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES}`,
      );
    });

    it('rejects a non-boolean hasRunCondition', () => {
      expectRejected(
        makeInvalidDocument({ hasRunCondition: 'yes' }),
        'hasRunCondition',
      );
    });
  });

  describe('validateSharedAutomationDocument — trigger rejection', () => {
    it('rejects an unknown trigger kind', () => {
      expectRejected(
        makeInvalidDocument({
          trigger: { kind: 'interval', timezone: 'local' },
        }),
        'trigger',
      );
    });

    it('rejects a cron expression without exactly five fields', () => {
      expectRejected(
        makeDocument({
          trigger: { kind: 'cron', expression: '* * * *', timezone: 'local' },
        }),
        'five',
      );
      expectRejected(
        makeDocument({
          trigger: { kind: 'cron', expression: '', timezone: 'local' },
        }),
        'five',
      );
    });

    it('rejects cron expressions with malformed field grammar', () => {
      const malformed = [
        '0 2 * * MON', // non-numeric token
        '61 2 * * *', // minute out of range
        '0 24 * * *', // hour out of range
        '0 2 0 * *', // day-of-month out of range
        '0 2 * 13 *', // month out of range
        '0 2 * * 8', // day-of-week out of range
        '5-1 * * * *', // inverted range
        '*/0 * * * *', // zero step
        '5/2 * * * *', // step on a single value (desktop parser rejects)
        `*/${'9'.repeat(320)} * * * *`, // step overflows to Infinity
        '0- 2 * * *', // dangling range
      ];
      for (const expression of malformed) {
        expectRejected(
          makeDocument({
            trigger: { kind: 'cron', expression, timezone: 'local' },
          }),
          'cron',
        );
      }
    });

    it('rejects a non-local timezone', () => {
      expectRejected(
        makeInvalidDocument({
          trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'UTC' },
        }),
        'local',
      );
    });

    it('rejects an unparseable one_time runAt', () => {
      expectRejected(
        makeDocument({
          trigger: { kind: 'one_time', runAt: 'tomorrow', timezone: 'local' },
        }),
        'runAt',
      );
    });

    it('rejects unknown trigger fields', () => {
      expectRejected(
        makeInvalidDocument({
          trigger: {
            kind: 'cron',
            expression: '0 2 * * *',
            timezone: 'local',
            lastRunAt: '2026-01-01',
          },
        }),
        'Unexpected field',
      );
    });
  });

  describe('validateSharedAutomationDocument — action rejection', () => {
    it('rejects malformed inline pipeline refs', () => {
      const inlineAction = (
        pipeline: Record<string, unknown>,
      ): Record<string, unknown> => ({
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline,
        inputKeys: [],
      });

      expectRejected(
        makeInvalidDocument({
          action: inlineAction({
            source: 'inline',
            rawPipeline: '',
            pipelineContentHash: 'a'.repeat(64),
          }),
        }),
        'raw pipeline',
      );
      expectRejected(
        makeInvalidDocument({
          action: inlineAction({
            source: 'inline',
            rawPipeline: 'x'.repeat(PIPELINE_PACKAGE_MAX_FILE_BYTES + 1),
            pipelineContentHash: 'a'.repeat(64),
          }),
        }),
        `${PIPELINE_PACKAGE_MAX_FILE_BYTES}`,
      );
      expectRejected(
        makeInvalidDocument({
          action: inlineAction({
            source: 'inline',
            rawPipeline: 'pipeline: {}',
            pipelineContentHash: 'short',
          }),
        }),
        'content hash',
      );
      expectRejected(
        makeInvalidDocument({
          action: inlineAction({
            source: 'inline',
            rawPipeline: 'pipeline: {}',
            pipelineContentHash: 'a'.repeat(64),
            localPath: '/private/pipeline.yaml',
          }),
        }),
        'Unexpected field',
      );
    });

    it('rejects only the execution-bound action type with an explicit reason', () => {
      expectRejected(
        makeInvalidDocument({ action: { type: 'pipeline_execution_resume' } }),
        'cannot be shared',
      );
      expectRejected(
        makeInvalidDocument({ action: { type: 'worktree_session_prompt' } }),
        'Unknown automation action type',
      );
    });

    it('rejects unknown action types', () => {
      expectRejected(
        makeInvalidDocument({ action: { type: 'mystery' } }),
        'action',
      );
    });

    it('rejects Object.prototype member names as action types with a string error', () => {
      for (const type of ['toString', 'hasOwnProperty', 'constructor']) {
        expectRejected(makeInvalidDocument({ action: { type } }), 'action');
      }
    });

    it('rejects unknown action fields so machine-local ids cannot leak through', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Go.',
            plugins: [],
            pluginSelections: { collectionIds: ['local'] },
          },
        }),
        'Unexpected field',
      );
    });

    it('rejects unexpected fields on the portable Cowork action', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'standalone_prompt',
            target: { kind: 'cowork' },
            prompt: 'Go.',
            plugins: [],
            chatProjectId: 'local-project',
          },
        }),
        'Unexpected field',
      );
    });

    // A share must never hand a recipient a pinned approval mode. The share
    // builder drops it; this pins that no document can carry one regardless.
    it.each([
      { type: 'app_advisor_prompt', prompt: 'Go.', plugins: [] },
      {
        type: 'standalone_prompt',
        target: { kind: 'cowork' },
        prompt: 'Go.',
        plugins: [],
      },
      {
        type: 'worktree_prompt',
        target: { kind: 'workspace' },
        prompt: 'Go.',
        plugins: [],
      },
    ])('rejects an approval mode on a $type action', (action) => {
      expectRejected(
        makeInvalidDocument({
          action: { ...action, approvalMode: 'full-access' },
        }),
        'Unexpected field',
      );
    });

    it('rejects a missing or blank prompt', () => {
      expectRejected(
        makeDocument({
          action: { type: 'app_advisor_prompt', prompt: '  ', plugins: [] },
        }),
        'prompt',
      );
    });

    it('rejects a prompt over the byte cap', () => {
      expectRejected(
        makeDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'x'.repeat(MAX_SHARED_AUTOMATION_PROMPT_BYTES + 1),
            plugins: [],
          },
        }),
        `${MAX_SHARED_AUTOMATION_PROMPT_BYTES}`,
      );
    });

    it('rejects non-shareable plugin refs', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Go.',
            plugins: [{ marketplaceId: 'local-only' }],
          },
        }),
        'plugin',
      );
    });

    it('rejects a model that references a local custom Agent', () => {
      expectRejected(
        makeDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Go.',
            plugins: [],
            modelConfig: { model: 'agent_model_code_reviewer' },
          },
        }),
        'Agent',
      );
    });

    it('rejects an unknown thinkingLevel and non-boolean fastMode', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Go.',
            plugins: [],
            modelConfig: { thinkingLevel: 'extreme' },
          },
        }),
        'thinkingLevel',
      );
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Go.',
            plugins: [],
            modelConfig: { fastMode: 'yes' },
          },
        }),
        'fastMode',
      );
    });

    it('accepts all three Codex speeds and derives the legacy fastMode projection', () => {
      for (const speed of CODEX_SPEEDS) {
        const result = validateSharedAutomationDocument(
          makeDocument({
            action: {
              type: 'app_advisor_prompt',
              prompt: 'Go.',
              plugins: [],
              modelConfig: { model: 'gpt-6-astra', speed },
            },
          }),
        );
        expect(result.ok).toBe(true);
        if (result.ok && result.document.action.type === 'app_advisor_prompt') {
          expect(result.document.action.modelConfig).toEqual({
            model: 'gpt-6-astra',
            speed,
            fastMode: speed === 'fast',
          });
        }
      }
      expect(isCodexSpeed('ultrafast')).toBe(true);
      expect(isCodexSpeed('priority')).toBe(false);
    });

    it('rejects an unknown speed and a fastMode that contradicts its speed', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Go.',
            plugins: [],
            modelConfig: { speed: 'priority' },
          },
        }),
        'speed',
      );
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Go.',
            plugins: [],
            modelConfig: { speed: 'ultrafast', fastMode: true },
          },
        }),
        'fastMode',
      );
    });

    it('rejects a worktree_prompt without the workspace rebind target', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'worktree_prompt',
            target: { kind: 'worktree' },
            prompt: 'Go.',
            plugins: [],
          },
        }),
        'target',
      );
    });

    it('rejects an invalid interfaceMode', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            ...makeWorktreePromptAction(),
            interfaceMode: 'terminal',
          },
        }),
        'interfaceMode',
      );
    });

    it('rejects local-only pipeline sources with travel-inside guidance', () => {
      for (const source of ['user', 'project']) {
        expectRejected(
          makeInvalidDocument({
            action: {
              type: 'worktree_pipeline',
              target: { kind: 'workspace' },
              pipeline: { source, pipelineId: 'mine' },
              inputKeys: [],
            },
          }),
          'must travel inside the shared automation',
        );
      }
    });

    it('rejects a bundled pipeline ref without a pipelineId', () => {
      expectRejected(
        makeDocument({
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: { source: 'bundled', pipelineId: '' },
            inputKeys: [],
          },
        }),
        'pipelineId',
      );
    });

    it('rejects a shared pipeline ref without a remoteId', () => {
      expectRejected(
        makeDocument({
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'shared',
              remoteId: '',
              installPin: {
                pipelineContentHash: 'a'.repeat(64),
                distributionMode: 'definition_only',
              },
            },
            inputKeys: [],
          },
        }),
        'remoteId',
      );
    });

    it('rejects a malformed shared pipeline install pin', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'shared',
              remoteId: 'shared-pipeline',
              installPin: {
                pipelineContentHash: 'a'.repeat(64),
                distributionMode: 'package',
              },
            },
            inputKeys: [],
          },
        }),
        'package digest',
      );
    });

    it('rejects invalid curated and unresolved pipeline fields', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: { source: 'curated', curatedKey: '' },
            inputKeys: [],
          },
        }),
        'curatedKey',
      );
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: { source: 'unresolved', pipelineId: 'local-id' },
            inputKeys: [],
          },
        }),
        'Unexpected field',
      );
    });

    it('rejects malformed capability package refs', () => {
      expectRejected(
        makeInvalidDocument({
          capabilityPackage: { version: 1, digest: 'not-a-digest' },
        }),
        'capability package',
      );
    });

    it('rejects unknown pipeline ref fields such as local serverId', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'shared',
              remoteId: 'abc',
              serverId: 'srv-local',
            },
            inputKeys: [],
          },
        }),
        'Unexpected field',
      );
    });

    it('rejects non-string inputKeys entries', () => {
      expectRejected(
        makeInvalidDocument({
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: { source: 'bundled', pipelineId: 'code-review' },
            inputKeys: ['branch', 7],
          },
        }),
        'inputKeys',
      );
    });
  });

  describe('validateSharedAutomationDocument — pipeline destinations (v6)', () => {
    function pipelineDocument(
      kind: string,
      version: number,
      extra: Record<string, unknown> = {},
    ): unknown {
      return makeInvalidDocument({
        version,
        action: {
          type: 'worktree_pipeline',
          target: { kind },
          pipeline: { source: 'bundled', pipelineId: 'bundled-review' },
          inputKeys: [],
        },
        ...extra,
      });
    }

    it('advertises the v6 capability without requiring it', () => {
      expect(SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION).toBe(6);
      expect(CANOPY_SERVER_CAPABILITIES).toContain(
        SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY,
      );
      expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
        SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY,
      );
    });

    it.each(['workspace', 'global', 'new_worktree', 'task', 'project'])(
      'accepts a %s destination in v6',
      (kind) => {
        const result = validateSharedAutomationDocument(
          pipelineDocument(kind, 6),
        );
        expect(result.ok).toBe(true);
        if (result.ok && result.document.action.type === 'worktree_pipeline')
          expect(result.document.action.target).toEqual({ kind });
      },
    );

    it.each([1, 2, 3, 4, 5])(
      'rejects new destination kinds in v%s',
      (version) => {
        for (const kind of ['global', 'new_worktree', 'task', 'project'])
          expectRejected(pipelineDocument(kind, version), 'workspace');
      },
    );

    it('rejects unknown kinds and local ids on a destination', () => {
      expectRejected(pipelineDocument('elsewhere', 6), 'target kind');
      expectRejected(
        makeInvalidDocument({
          version: 6,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'task', taskId: 'wt-1' },
            pipeline: { source: 'bundled', pipelineId: 'bundled-review' },
            inputKeys: [],
          },
        }),
        'Unexpected field',
      );
    });

    it('keeps v3 requirements in v6 but refuses them on a global destination', () => {
      const requirement = { targetRequirement: { contexts: ['worktree'] } };
      expect(
        validateSharedAutomationDocument(
          pipelineDocument('task', 6, requirement),
        ).ok,
      ).toBe(true);
      expectRejected(
        pipelineDocument('global', 6, requirement),
        'targetRequirement',
      );
    });

    it('keeps worktree prompts workspace-only in v6', () => {
      expectRejected(
        makeInvalidDocument({
          version: 6,
          action: {
            ...makeWorktreePromptAction(),
            target: { kind: 'global' },
          },
        }),
        'workspace',
      );
    });

    it('carries a v4 run condition alongside a v6 destination', () => {
      const result = validateSharedAutomationDocument(
        pipelineDocument('task', 6, {
          hasRunCondition: true,
          runCondition: { command: 'test -f ready' },
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        document: {
          version: 6,
          action: { target: { kind: 'task' } },
          runCondition: { command: 'test -f ready' },
        },
      });
    });

    it('keeps v5 packaged pipelines alongside a v6 destination', () => {
      const result = validateSharedAutomationDocument(
        makeInvalidDocument({
          version: 6,
          capabilityPackage: { version: 1, digest: `pp:v1:${'b'.repeat(43)}` },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'task' },
            pipeline: {
              source: 'packaged',
              key: SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
              pipelineContentHash: 'c'.repeat(64),
            },
            inputKeys: [],
          },
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        document: {
          version: 6,
          action: {
            target: { kind: 'task' },
            pipeline: { source: 'packaged' },
          },
        },
      });
    });
  });

  describe('validateSharedAutomationDocument — total size', () => {
    it('rejects a document over the total byte cap', () => {
      const result = validateSharedAutomationDocument(
        makeDocument({
          action: {
            type: 'app_advisor_prompt',
            // Individually under the prompt cap, but pushes the whole
            // serialized document over MAX_SHARED_AUTOMATION_BYTES once the
            // description is included.
            prompt: 'x'.repeat(MAX_SHARED_AUTOMATION_PROMPT_BYTES - 1),
            plugins: [],
          },
          description: 'y'.repeat(MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES - 1),
        }),
      );
      // 64 KiB prompt + 4 KiB description is far below 256 KiB, so this
      // combination is actually valid; the cap needs an oversized plugin list.
      expect(result.ok).toBe(true);

      const manyPlugins: ShareablePluginRef[] = Array.from(
        { length: 6000 },
        (_, index) => ({
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: `skill-${index}-${'pad'.repeat(8)}`,
        }),
      );
      const oversized = makeDocument({
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Go.',
          plugins: manyPlugins,
        },
      });
      expectRejected(oversized, `${MAX_SHARED_AUTOMATION_BYTES}`);
    });
  });

  it('request/response DTOs compile with the documented shapes', () => {
    const summary: SharedAutomationSummary = {
      id: '0b8f5c6e-1111-4222-8333-444455556666',
      name: 'Nightly triage',
      description: 'Runs a triage prompt every night.',
      triggerKind: 'cron',
      actionType: 'app_advisor_prompt',
      contentHash: 'c'.repeat(64),
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Platform',
        organization: { id: 'org-1', name: 'Canopy' },
      },
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
      canUpdate: true,
      canDelete: true,
    };
    const detail: SharedAutomationDetail = {
      ...summary,
      savedFrom: {
        automationId: '9c8d7e6f-1111-4222-8333-444455556666',
        contentHash: 'd'.repeat(64),
      },
      automation: makeDocument(),
    };
    const list: ListSharedAutomationsRequest = {
      serverId: 'srv-1',
      limit: 20,
      cursor: 'cursor',
      query: 'triage',
      createdBy: 'me',
    };
    const listResponse: ListSharedAutomationsResponse = {
      automations: [summary],
      nextCursor: undefined,
    };
    const get: GetSharedAutomationRequest = {
      serverId: 'srv-1',
      automationId: summary.id,
    };
    const create: CreateSharedAutomationRequest = {
      serverId: 'srv-1',
      automation: makeDocument(),
      shareScope: 'team',
      teamId: 'team-1',
      savedFrom: { remoteId: summary.id, contentHash: summary.contentHash },
    };
    const update: UpdateSharedAutomationRequest = {
      serverId: 'srv-1',
      automationId: summary.id,
      automation: makeDocument(),
      expectedContentHash: summary.contentHash,
      shareScope: 'organization',
      organizationId: 'org-1',
    };
    const remove: DeleteSharedAutomationRequest = {
      serverId: 'srv-1',
      automationId: summary.id,
    };

    expect(detail.automation.version).toBe(SHARED_AUTOMATION_API_VERSION);
    expect(listResponse.automations).toHaveLength(1);
    expect([list, get, create, update, remove].every(Boolean)).toBe(true);
  });
});
