import {
  MAX_SHARED_CONTAINER_PIPELINE_YAML_BYTES,
  SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
  canonicalizeSharedContainerDefinitionDocument,
  encodeSharedContainerDefinitionDocument,
  parseSharedContainerDefinitionDocument,
  sharedContainerDefinitionTextContainsCredential,
  sharedContainerDefinitionTextContainsMachinePath,
  validateSharedContainerDefinitionDocument,
  type SharedContainerAgentDefinitionDocument,
  type SharedContainerAutomationDefinitionDocument,
  type SharedContainerHookDefinitionDocument,
  type SharedContainerPipelineDefinitionDocument,
} from '../index';

const PIPELINE_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const AGENT_ID = 'f6e5d4c3b2a1f6e5d4c3b2a1';

function pipelineDocument(
  overrides: Partial<SharedContainerPipelineDefinitionDocument> = {},
): SharedContainerPipelineDefinitionDocument {
  return {
    version: 1,
    kind: 'pipeline_definition',
    references: [],
    name: 'Review',
    yaml: 'name: Review\non: dispatch\njobs: {}\n',
    ...overrides,
  };
}

function automationDocument(
  overrides: Partial<SharedContainerAutomationDefinitionDocument> = {},
): SharedContainerAutomationDefinitionDocument {
  return {
    version: 1,
    kind: 'automation_definition',
    references: [PIPELINE_ID],
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
    ...overrides,
  };
}

function agentDocument(): SharedContainerAgentDefinitionDocument {
  return {
    version: 1,
    kind: 'agent_definition',
    references: [],
    agent: {
      version: 1,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review carefully and run /review-helper first.',
      plugins: [],
    },
  };
}

function hookDocument(
  overrides: Partial<SharedContainerHookDefinitionDocument> = {},
): SharedContainerHookDefinitionDocument {
  return {
    version: 1,
    kind: 'hook_definition',
    references: [PIPELINE_ID, AGENT_ID],
    triggerName: 'pr:checks:fail',
    target: {
      kind: 'workspace-repo',
      repository: {
        remoteUrl: 'https://github.com/acme/api.git',
        layoutName: 'api',
      },
    },
    actions: [
      { type: 'command', command: 'pnpm lint --fix', shell: { mac: 'zsh' } },
      {
        type: 'chat',
        prompt: 'Fix the failing checks.',
        agent: AGENT_ID,
        plugins: [],
        autoArchive: true,
      },
      {
        type: 'pipeline',
        pipeline: { source: 'packaged', resourceId: PIPELINE_ID },
        inputs: { branch: '{{CANOPY_PR_BRANCH}}' },
      },
    ],
    ...overrides,
  };
}

describe('shared container definition documents', () => {
  it('names the single read-only document path', () => {
    expect(SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH).toBe('definition.json');
  });

  it.each([
    ['pipeline', pipelineDocument()],
    ['automation', automationDocument()],
    ['agent', agentDocument()],
    ['hook', hookDocument()],
  ])('accepts a valid %s document', (_label, document) => {
    const result = validateSharedContainerDefinitionDocument(document);
    expect(result).toEqual({ ok: true, value: document });
  });

  it('records historical snapshot and substitution provenance', () => {
    for (const provenance of [
      { historicalSnapshot: true as const },
      { substitutedCurrentDefinition: true as const },
    ]) {
      const result = validateSharedContainerDefinitionDocument(
        pipelineDocument({ provenance }),
      );
      expect(result.ok && result.value.provenance).toEqual(provenance);
    }
    expect(
      validateSharedContainerDefinitionDocument({
        ...pipelineDocument(),
        provenance: {
          historicalSnapshot: true,
          substitutedCurrentDefinition: true,
        },
      }).ok,
    ).toBe(false);
  });

  it('rejects unknown fields at every level', () => {
    expect(
      validateSharedContainerDefinitionDocument({
        ...pipelineDocument(),
        updatedAt: '2026-10-21T00:00:00.000Z',
      }).ok,
    ).toBe(false);
    const agent = agentDocument();
    expect(
      validateSharedContainerDefinitionDocument({
        ...agent,
        agent: { ...agent.agent, createdAt: '2026-10-21T00:00:00.000Z' },
      }).ok,
    ).toBe(false);
    const automation = automationDocument();
    expect(
      validateSharedContainerDefinitionDocument({
        ...automation,
        automation: { ...automation.automation, id: 'local-activity' },
      }).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument({
        ...hookDocument(),
        actions: [
          {
            type: 'chat',
            prompt: 'Go',
            plugins: [],
            executionContext: 'local-owner',
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument({
        ...hookDocument(),
        target: { kind: 'workspace-repo', repoId: 'repo-local-1' },
      }).ok,
    ).toBe(false);
  });

  it('rejects credential-shaped values but allows named placeholders', () => {
    const leaked = validateSharedContainerDefinitionDocument(
      hookDocument({
        actions: [
          {
            type: 'command',
            command: 'curl -H "Authorization: Bearer abcdef0123456789" x',
          },
        ],
      }),
    );
    expect(leaked.ok).toBe(false);
    expect(leaked.ok ? [] : leaked.errors.join('\n')).toContain('credential');
    expect(
      sharedContainerDefinitionTextContainsCredential(
        'token: ${{ secrets.GITHUB_TOKEN }}\npassword=$DB_PASSWORD',
      ),
    ).toBe(false);
    expect(
      sharedContainerDefinitionTextContainsCredential(
        'export GH=ghp_abcdefghijklmnopqrstuvwxyz0123',
      ),
    ).toBe(true);
  });

  it.each([
    ['a prefixed token assignment', 'NPM_TOKEN=npm_abc123def456 pnpm publish'],
    [
      'a prefixed password assignment',
      'DATABASE_PASSWORD=hunter2 pnpm migrate',
    ],
    ['a spaced assignment', 'export GITHUB_API_KEY = abc123def456'],
    ['a lowercase assignment', 'aws_access_key=AKIAEXAMPLE pnpm deploy'],
    ['a private key assignment', 'SSH_PRIVATE_KEY="abc123def456" ./ship'],
    ['URL user-info', 'psql postgres://admin:pw@db.example.com/app'],
    ['HTTPS user-info', 'git clone https://bot:s3cret@github.com/acme/api.git'],
    ['a curl user flag', 'curl -u admin:pw https://api.example.com/v1'],
    ['a long user flag', 'curl --user admin:pw https://api.example.com/v1'],
    ['a long user flag with =', 'curl --user=admin:pw https://api.example.com'],
    ['a quoted user flag', 'curl -u "admin:pw" https://api.example.com'],
  ])('rejects %s in command text', (_label, command) => {
    expect(sharedContainerDefinitionTextContainsCredential(command)).toBe(true);
    const result = validateSharedContainerDefinitionDocument(
      hookDocument({ actions: [{ type: 'command', command }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.errors.join('\n')).toContain(
      'actions[0].command may contain a credential',
    );
  });

  it.each([
    ['an exported placeholder', 'export TOKEN=$NPM_TOKEN'],
    ['a prefixed placeholder', 'NPM_TOKEN=$NPM_TOKEN pnpm publish'],
    ['a braced placeholder', 'NPM_TOKEN=${NPM_TOKEN} pnpm publish'],
    ['a quoted placeholder', 'NPM_TOKEN="$NPM_TOKEN" pnpm publish'],
    ['an Actions secret', 'password: ${{ secrets.X }}'],
    ['a prefixed Actions secret', 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'],
    ['a template input', 'API_KEY={{ inputs.api_key }} ./deploy'],
    ['an angle placeholder', 'DATABASE_PASSWORD=<database password> pnpm db'],
    ['a command substitution', 'export GITHUB_TOKEN=$(gh auth token)'],
    ['an environment read', 'const token = process.env.NPM_TOKEN;'],
    ['an empty assignment', 'NPM_TOKEN="" pnpm publish'],
    ['an equality check', "if: ${{ inputs.token == '' }}"],
    ['a plain clone', 'git clone https://github.com/org/repo.git'],
    ['a user without a password', 'git clone https://user@host/org/repo.git'],
    ['a placeholder password', 'git clone https://bot:$TOKEN@github.com/a/b'],
    [
      'an Actions secret password',
      'git clone https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/a/b',
    ],
    ['a port and an at sign', 'open https://example.com:8080/path@v2'],
    ['a pinned image digest', 'uses: docker://alpine:3.18@sha256:abcdef0123'],
    ['a placeholder user flag', 'curl -u "$API_USER:$API_PASSWORD" https://x'],
    ['a numeric user flag', 'docker run -u 1000:1000 node:20 pnpm test'],
    ['an upstream flag', 'git push -u origin main'],
  ])('allows %s', (_label, text) => {
    expect(sharedContainerDefinitionTextContainsCredential(text)).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({ actions: [{ type: 'command', command: text }] }),
      ).ok,
    ).toBe(true);
  });

  it.each([
    ['a single-brace password', 'password={hunter2}'],
    ['a single-brace password value', 'password: {hunter2}'],
    ['a single-brace prefixed password', 'DB_PASSWORD={hunter2} pnpm db'],
    [
      'a single-brace user-info password',
      'git clone https://bot:{s3cret}@x.io/a',
    ],
    ['a compound scheme', 'git clone git+ssh://bot:s3cret@github.com/a/b'],
    ['a dotted scheme prefix', 'see a.b.c+https://bot:s3cret@example.com'],
  ])('rejects %s', (_label, text) => {
    expect(sharedContainerDefinitionTextContainsCredential(text)).toBe(true);
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({ actions: [{ type: 'command', command: text }] }),
      ).ok,
    ).toBe(false);
  });

  it.each([
    ['a template input', 'password={{ inputs.password }}'],
    ['a compact template input', 'password={{CANOPY_DB_PASSWORD}}'],
    ['a braced variable', 'password=${DB_PASSWORD}'],
    ['a nested command substitution', 'export TOKEN=$(cat $(git root)/t)'],
    ['a single-brace name outside an assignment', 'git checkout {branch}'],
    ['a single-brace format string', 'echo "Deploying {name} to {env}"'],
  ])('allows %s', (_label, text) => {
    expect(sharedContainerDefinitionTextContainsCredential(text)).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({ actions: [{ type: 'command', command: text }] }),
      ).ok,
    ).toBe(true);
  });

  it('treats a single-brace value under a secret-named key as a credential', () => {
    const withInputs = (inputs: Record<string, string>): boolean =>
      validateSharedContainerDefinitionDocument(
        hookDocument({
          actions: [
            {
              type: 'pipeline',
              pipeline: { source: 'packaged', resourceId: PIPELINE_ID },
              inputs,
            },
          ],
        }),
      ).ok;
    expect(withInputs({ password: '{hunter2}' })).toBe(false);
    expect(withInputs({ password: '{{ inputs.password }}' })).toBe(true);
    expect(withInputs({ branch: '{name}' })).toBe(true);
  });

  it.each([
    ['api_key', 'a1b2c3d4e5f6'],
    ['GITHUB_TOKEN', 'abc123def456'],
    ['apiKey', 'abc123def456'],
    ['dbPassword', 'hunter2'],
    ['DB_PASSWD', 'hunter2'],
    ['client_secret', 'abc123def456'],
    ['AWS_ACCESS_KEY', 'abc123def456'],
    ['private-key', 'abc123def456'],
    ['credential', 'abc123def456'],
    ['service_credentials', 'abc123def456'],
  ])('rejects a value under the secret-named key %s', (key, secret) => {
    const result = validateSharedContainerDefinitionDocument(
      hookDocument({
        actions: [
          {
            type: 'pipeline',
            pipeline: { source: 'packaged', resourceId: PIPELINE_ID },
            inputs: { [key]: secret },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.errors.join('\n')).toContain(
      `actions[0].inputs.${key} may contain a credential`,
    );
  });

  it.each([
    ['NPM_TOKEN', '$NPM_TOKEN'],
    ['NPM_TOKEN', '${NPM_TOKEN}'],
    ['api_key', '{{ inputs.api_key }}'],
    ['GITHUB_TOKEN', '${{ secrets.GITHUB_TOKEN }}'],
    ['password', '<your password>'],
    ['password', ''],
    ['password', '  '],
    ['token_count', '12'],
    ['secret_name', 'deploy-key'],
    ['branch', 'abc123def456'],
  ])('allows %s set to %j', (key, value) => {
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({
          actions: [
            {
              type: 'pipeline',
              pipeline: { source: 'packaged', resourceId: PIPELINE_ID },
              inputs: { [key]: value },
            },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it('rejects absolute machine paths and file URLs', () => {
    expect(
      validateSharedContainerDefinitionDocument(
        pipelineDocument({ yaml: 'run: /Users/alice/bin/deploy.sh\n' }),
      ).ok,
    ).toBe(false);
    for (const text of [
      'cd /home/bob/project',
      'C:\\Users\\carol\\repo',
      'open file:///tmp/x',
      'cat /private/var/folders/xy/T/out',
    ]) {
      expect(sharedContainerDefinitionTextContainsMachinePath(text)).toBe(true);
    }
    for (const text of [
      '/usr/bin/env node',
      'https://example.com/home/page',
      'pnpm test',
    ]) {
      expect(sharedContainerDefinitionTextContainsMachinePath(text)).toBe(
        false,
      );
    }
  });

  it('rejects oversized fields', () => {
    expect(
      validateSharedContainerDefinitionDocument(
        pipelineDocument({
          yaml: 'a'.repeat(MAX_SHARED_CONTAINER_PIPELINE_YAML_BYTES + 1),
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument(
        pipelineDocument({ name: 'n'.repeat(201) }),
      ).ok,
    ).toBe(false);
  });

  it('reuses the shared automation and Agent validators', () => {
    const automation = automationDocument();
    const invalidAutomation = validateSharedContainerDefinitionDocument({
      ...automation,
      automation: {
        ...automation.automation,
        action: {
          type: 'pipeline_execution_resume',
          executionId: 'local-execution',
        },
      },
    });
    expect(invalidAutomation.ok).toBe(false);
    const agent = agentDocument();
    const invalidAgent = validateSharedContainerDefinitionDocument({
      ...agent,
      agent: { ...agent.agent, baseModel: 'agent_model_other' },
    });
    expect(invalidAgent.ok).toBe(false);
  });

  it('requires a portable target and packaged pipeline for automations', () => {
    expect(
      validateSharedContainerDefinitionDocument({
        ...automationDocument(),
        target: { kind: 'worktree', worktreeId: 'local-worktree' },
      }).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument(
        automationDocument({ uses: undefined }),
      ).ok,
    ).toBe(false);
    const inline = automationDocument();
    expect(
      validateSharedContainerDefinitionDocument({
        ...inline,
        automation: {
          ...inline.automation,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'workspace' },
            pipeline: {
              source: 'inline',
              rawPipeline: 'name: x',
              pipelineContentHash: 'a'.repeat(64),
            },
            inputKeys: [],
          },
        },
      }).ok,
    ).toBe(false);
  });

  it('refuses a uses or agent id that is not also a reference', () => {
    expect(
      validateSharedContainerDefinitionDocument(
        automationDocument({ references: [] }),
      ).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({ references: [PIPELINE_ID] }),
      ).ok,
    ).toBe(false);
  });

  it('rejects credentialed remotes and unsupported triggers for hooks', () => {
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({
          target: {
            kind: 'workspace-repo',
            repository: {
              remoteUrl: 'https://user:pass@github.com/acme/api.git',
              layoutName: 'api',
            },
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument({
        ...hookDocument(),
        triggerName: 'custom:trigger',
      }).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({
          target: {
            kind: 'workspace-repo',
            repository: { remoteUrl: null, layoutName: '../escape' },
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateSharedContainerDefinitionDocument(
        hookDocument({
          target: {
            kind: 'workspace-repo',
            repository: {
              remoteUrl: 'git@github.com:acme/api.git',
              layoutName: 'api',
            },
          },
        }),
      ).ok,
    ).toBe(true);
  });

  it('canonicalizes deterministically with sorted keys and references', () => {
    const left = canonicalizeSharedContainerDefinitionDocument(
      hookDocument({ references: [PIPELINE_ID, AGENT_ID] }),
    );
    const right = canonicalizeSharedContainerDefinitionDocument({
      actions: hookDocument().actions,
      target: hookDocument().target,
      triggerName: 'pr:checks:fail',
      references: [AGENT_ID, PIPELINE_ID],
      kind: 'hook_definition',
      version: 1,
    });
    expect(left).toBe(right);
    const parsed: unknown = JSON.parse(left);
    expect(
      Object.keys(parsed !== null && typeof parsed === 'object' ? parsed : {}),
    ).toEqual([
      'actions',
      'kind',
      'references',
      'target',
      'triggerName',
      'version',
    ]);
    expect(left).toContain(`"references":["${PIPELINE_ID}","${AGENT_ID}"]`);
  });

  it('throws instead of canonicalizing an invalid document', () => {
    expect(() =>
      canonicalizeSharedContainerDefinitionDocument(
        pipelineDocument({ name: '' }),
      ),
    ).toThrow('Invalid shared container definition document');
  });

  describe('scan cost on adversarial text', () => {
    // Every scan pattern must stay linear: a quadratic pattern on a 1 MiB
    // definition would block the main process for minutes during install
    // validation, and a synchronous regex cannot be aborted.
    const ADVERSARIAL_BYTES = 1024 * 1024;
    // Linear scans take tens of milliseconds even on loaded CI workers; the
    // quadratic patterns these guard against took minutes at this size.
    const BUDGET_MS = 2_000;

    function repeatTo(unit: string, bytes: number): string {
      return unit.repeat(Math.max(1, Math.floor(bytes / unit.length)));
    }

    function elapsedMs(run: () => unknown): number {
      const start = performance.now();
      run();
      return performance.now() - start;
    }

    const UNITS = [
      '<',
      '{',
      '{{',
      '${{',
      '$(',
      '$($(x)',
      '$((x)',
      'a.',
      'a-',
      'a:',
      '@',
      '-u ',
      ' -u x:',
      'KEY=',
      'a',
      'TOKEN',
      'token=<',
      'token={',
      'token={{',
      'token=${{',
      'token=$(',
      'password: ',
      'a://',
      'a://u:p:',
      'env.',
      '$a',
      '=\\\\a',
      ' /Users/',
      '<a>',
    ];

    it.each(
      UNITS.flatMap((unit) => [[unit, ''] as const, [unit, '\n'] as const]),
    )(
      'scans %j repeated to 1 MiB (line end %j) within budget',
      (unit, lineEnd) => {
        const text = repeatTo(unit + lineEnd, ADVERSARIAL_BYTES);
        expect(
          elapsedMs(() =>
            sharedContainerDefinitionTextContainsCredential(text),
          ),
        ).toBeLessThan(BUDGET_MS);
        expect(
          elapsedMs(() =>
            sharedContainerDefinitionTextContainsMachinePath(text),
          ),
        ).toBeLessThan(BUDGET_MS);
      },
    );

    it.each(['<', '{', '${{', '$(', 'a.', 'TOKEN'])(
      'scans 4 KiB lines of %j within budget',
      (unit) => {
        const text = repeatTo(
          `${repeatTo(unit, 4 * 1024)}\n`,
          ADVERSARIAL_BYTES,
        );
        expect(
          elapsedMs(() =>
            sharedContainerDefinitionTextContainsCredential(text),
          ),
        ).toBeLessThan(BUDGET_MS);
      },
    );

    it('scans a long scheme run before user-info within budget', () => {
      const text = `${'a.'.repeat(16)}://u:${'p'.repeat(ADVERSARIAL_BYTES)}`;
      expect(
        elapsedMs(() => sharedContainerDefinitionTextContainsCredential(text)),
      ).toBeLessThan(BUDGET_MS);
    });

    it.each(['<', '{', '{{', '$(', 'a.', 'TOKEN', 'token=<'])(
      'parses a 1 MiB pipeline of %j within budget',
      (unit) => {
        const yaml = repeatTo(unit, MAX_SHARED_CONTAINER_PIPELINE_YAML_BYTES);
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            kind: 'pipeline_definition',
            name: 'Review',
            references: [],
            version: 1,
            yaml,
          }),
        );
        expect(
          elapsedMs(() => parseSharedContainerDefinitionDocument(bytes)),
        ).toBeLessThan(BUDGET_MS);
      },
    );

    it.each(['<', '{', '{{', '$(', 'a.'])(
      'validates a 64 KiB command and secret-named input of %j within budget',
      (unit) => {
        const value = repeatTo(unit, 64 * 1024);
        // The command is scanned first; the secret-named input is then
        // checked against the anchored placeholder pattern.
        const document = hookDocument({
          actions: [
            { type: 'command', command: value },
            {
              type: 'pipeline',
              pipeline: { source: 'packaged', resourceId: PIPELINE_ID },
              inputs: { password: value },
            },
          ],
        });
        expect(
          elapsedMs(() => validateSharedContainerDefinitionDocument(document)),
        ).toBeLessThan(BUDGET_MS);
      },
    );
  });

  it('round-trips canonical bytes and rejects non-canonical bytes', () => {
    const bytes = encodeSharedContainerDefinitionDocument(agentDocument());
    expect(parseSharedContainerDefinitionDocument(bytes)).toEqual({
      ok: true,
      value: agentDocument(),
    });
    const pretty = new TextEncoder().encode(
      JSON.stringify(agentDocument(), null, 2),
    );
    expect(parseSharedContainerDefinitionDocument(pretty)).toEqual({
      ok: false,
      errors: ['Definition document is not canonical'],
    });
    expect(
      parseSharedContainerDefinitionDocument(new Uint8Array([0xff, 0xfe])).ok,
    ).toBe(false);
  });
});
