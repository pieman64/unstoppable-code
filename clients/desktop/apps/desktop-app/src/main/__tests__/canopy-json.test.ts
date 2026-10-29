import { validateCanopyJson } from '../lib/canopy-json';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
  MAX_SCRIPT_TIMEOUT_SECONDS,
} from '@canopy/desktop-shared/scripts';

describe('canopy-json script timeoutSeconds', () => {
  it('drops an invalid start page without invalidating scripts', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          scripts: { test: 'npm test' },
          startPage: { kind: 'url', url: 'file:///tmp/index.html' },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({ version: 1, scripts: { test: 'npm test' } });
  });

  it('uses the actual project config filename in top-level validation errors', () => {
    expect(() => validateCanopyJson([], '/tmp/testbrand.json')).toThrow(
      '/tmp/testbrand.json: testbrand.json must contain a JSON object',
    );
    expect(() => validateCanopyJson({}, '/tmp/testbrand.json')).toThrow(
      '/tmp/testbrand.json: testbrand.json version must be 1',
    );
  });

  it('accepts legacy string scripts and object scripts with timeoutSeconds', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            setup: ' npm install ',
            test: {
              command: ' npm test ',
              timeoutSeconds: 900,
              shell: { windows: 'powershell', mac: 'zsh' },
            },
            'long-check': {
              command: './scripts/check.sh',
              timeoutSeconds: null,
            },
            max: {
              command: 'npm run max',
              timeoutSeconds: MAX_SCRIPT_TIMEOUT_SECONDS,
            },
          },
          repos: [
            {
              id: 'web',
              name: 'Web',
              url: 'https://example.com/web.git',
              scripts: {
                setup: {
                  command: 'pnpm install',
                  timeoutSeconds: 1200,
                  shell: { windows: 'bash' },
                },
                launch: null,
              },
            },
          ],
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      scripts: {
        setup: 'npm install',
        test: {
          command: 'npm test',
          timeoutSeconds: 900,
          shell: { windows: 'powershell', mac: 'zsh' },
        },
        'long-check': {
          command: './scripts/check.sh',
          timeoutSeconds: null,
        },
        max: {
          command: 'npm run max',
          timeoutSeconds: MAX_SCRIPT_TIMEOUT_SECONDS,
        },
      },
      repos: [
        {
          id: 'web',
          name: 'Web',
          url: 'https://example.com/web.git',
          scripts: {
            setup: {
              command: 'pnpm install',
              timeoutSeconds: 1200,
              shell: { windows: 'bash' },
            },
            launch: null,
          },
        },
      ],
    });
  });

  it.each([0, -1, 1.5, '900', [], {}, MAX_SCRIPT_TIMEOUT_SECONDS + 1])(
    'rejects invalid timeoutSeconds value %p',
    (timeoutSeconds) => {
      expect(() =>
        validateCanopyJson(
          {
            version: 1,
            scripts: {
              setup: {
                command: 'npm install',
                timeoutSeconds,
              },
            },
          },
          '/tmp/canopy.json',
        ),
      ).toThrow(
        `/tmp/canopy.json: script "setup" timeoutSeconds must be null or between 1 and ${MAX_SCRIPT_TIMEOUT_SECONDS}`,
      );
    },
  );

  it('rejects unsupported keys in script objects', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            setup: {
              command: 'npm install',
              timeoutSeconds: 900,
              color: 'blue',
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: script "setup" contains unsupported key "color"',
    );
  });

  it.each([
    [
      { windows: 'zsh' },
      'shell.windows must be "cmd", "powershell", or "bash"',
    ],
    [{ mac: 'powershell' }, 'shell.mac must be "zsh" or "bash"'],
    [{ linux: 'bash' }, 'shell contains unsupported key "linux"'],
    [{}, 'shell must configure windows or mac'],
    ['zsh', 'shell must be an object'],
  ])('rejects invalid script shell value %#', (shell, message) => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            setup: {
              command: 'npm install',
              shell,
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(`/tmp/canopy.json: script "setup" ${message}`);
  });

  it('compacts object scripts without timeout metadata back to strings', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            setup: {
              command: 'npm install',
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      scripts: {
        setup: 'npm install',
      },
    });
  });
});

describe('canopy-json script devServerPattern', () => {
  it('accepts root and repo string, object, and mixed-array patterns', () => {
    const parsed = validateCanopyJson(
      {
        version: 1,
        scripts: {
          launch: {
            command: 'npm run dev',
            devServerPattern: 'https?://localhost:\\d+\\S*',
          },
          docs: {
            command: 'npm run docs',
            devServerPattern: {
              pattern: 'Docs:\\s+(https?://\\S+)',
              label: 'Docs',
            },
          },
        },
        repos: [
          {
            id: 'web',
            name: 'Web',
            url: 'https://example.com/web.git',
            scripts: {
              launch: {
                command: 'pnpm dev',
                devServerPattern: [
                  { pattern: 'App:\\s+(https?://\\S+)', label: 'App' },
                  'https?://127\\.0\\.0\\.1:\\d+\\S*',
                ],
              },
            },
          },
        ],
      },
      '/tmp/canopy.json',
    );

    expect(parsed.scripts?.launch).toEqual({
      command: 'npm run dev',
      devServerPattern: 'https?://localhost:\\d+\\S*',
    });
    expect(parsed.scripts?.docs).toEqual({
      command: 'npm run docs',
      devServerPattern: {
        pattern: 'Docs:\\s+(https?://\\S+)',
        label: 'Docs',
      },
    });
    expect(parsed.repos?.[0]?.scripts?.launch).toEqual({
      command: 'pnpm dev',
      devServerPattern: [
        { pattern: 'App:\\s+(https?://\\S+)', label: 'App' },
        'https?://127\\.0\\.0\\.1:\\d+\\S*',
      ],
    });
  });

  it('accepts and preserves devServerPattern openTarget values', () => {
    const parsed = validateCanopyJson(
      {
        version: 1,
        scripts: {
          launch: {
            command: 'npm run dev',
            devServerPattern: {
              pattern: 'Local:\\s+(https?://\\S+)',
              openTarget: 'in-app',
            },
          },
          preview: {
            command: 'npm run preview',
            devServerPattern: {
              pattern: 'Preview:\\s+(https?://\\S+)',
              label: 'Preview',
              openTarget: 'external',
            },
          },
        },
      },
      '/tmp/canopy.json',
    );

    expect(parsed.scripts?.launch).toEqual({
      command: 'npm run dev',
      devServerPattern: {
        pattern: 'Local:\\s+(https?://\\S+)',
        openTarget: 'in-app',
      },
    });
    expect(parsed.scripts?.preview).toEqual({
      command: 'npm run preview',
      devServerPattern: {
        pattern: 'Preview:\\s+(https?://\\S+)',
        label: 'Preview',
        openTarget: 'external',
      },
    });
  });

  it('rejects invalid devServerPattern openTarget values', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: {
                pattern: 'Local:\\s+(https?://\\S+)',
                openTarget: 'browser',
              },
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: script "launch" devServerPattern openTarget must be "in-app" or "external"',
    );
  });

  it('accepts repo script string, object, and mixed-array patterns', () => {
    const parsed = validateCanopyJson(
      {
        version: 1,
        repos: [
          {
            id: 'web',
            name: 'Web',
            url: 'https://example.com/web.git',
            scripts: {
              launchString: {
                command: 'pnpm dev',
                devServerPattern: 'https?://localhost:\\d+\\S*',
              },
              launchObject: {
                command: 'pnpm docs',
                devServerPattern: {
                  pattern: 'Docs:\\s+(https?://\\S+)',
                  label: 'Docs',
                },
              },
              launchMixed: {
                command: 'pnpm admin',
                devServerPattern: [
                  { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
                  'https?://127\\.0\\.0\\.1:\\d+\\S*',
                ],
              },
            },
          },
        ],
      },
      '/tmp/canopy.json',
    );

    expect(parsed.repos?.[0]?.scripts).toEqual({
      launchString: {
        command: 'pnpm dev',
        devServerPattern: 'https?://localhost:\\d+\\S*',
      },
      launchObject: {
        command: 'pnpm docs',
        devServerPattern: {
          pattern: 'Docs:\\s+(https?://\\S+)',
          label: 'Docs',
        },
      },
      launchMixed: {
        command: 'pnpm admin',
        devServerPattern: [
          { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
          'https?://127\\.0\\.0\\.1:\\d+\\S*',
        ],
      },
    });
  });

  it('rejects invalid regex patterns with a script-named error', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: '(',
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: script "launch" devServerPattern pattern must be a valid JavaScript regex',
    );
  });

  it('rejects invalid labels, empty arrays, oversized arrays, and nested keys', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: {
                pattern: 'https?://\\S+',
                label: '   ',
              },
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: script "launch" devServerPattern label must be a non-empty string',
    );

    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: {
                pattern: 'https?://\\S+',
                label: 'x'.repeat(MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH + 1),
              },
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/devServerPattern label must be at most/);

    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: [],
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/devServerPattern array must not be empty/);

    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: Array.from(
                { length: MAX_SCRIPT_DEV_SERVER_PATTERNS + 1 },
                (_, index) => `https?://host${index}\\S*`,
              ),
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/devServerPattern array must contain at most/);

    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: {
                pattern: 'https?://\\S+',
                color: 'red',
              },
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: script "launch" devServerPattern contains unsupported key "color"',
    );
  });

  it('rejects invalid repo script patterns with repo-script errors', () => {
    const repoWithPattern = (
      devServerPattern: unknown,
    ): Record<string, unknown> => ({
      version: 1,
      repos: [
        {
          id: 'web',
          name: 'Web',
          url: 'https://example.com/web.git',
          scripts: {
            launch: {
              command: 'pnpm dev',
              devServerPattern,
            },
          },
        },
      ],
    });

    expect(() =>
      validateCanopyJson(repoWithPattern('('), '/tmp/canopy.json'),
    ).toThrow(
      '/tmp/canopy.json: repos[0]: repo script "launch" devServerPattern pattern must be a valid JavaScript regex',
    );

    expect(() =>
      validateCanopyJson(
        repoWithPattern({
          pattern: 'https?://\\S+',
          label: '   ',
        }),
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: repos[0]: repo script "launch" devServerPattern label must be a non-empty string',
    );

    expect(() =>
      validateCanopyJson(repoWithPattern([]), '/tmp/canopy.json'),
    ).toThrow(
      '/tmp/canopy.json: repos[0]: repo script "launch" devServerPattern array must not be empty',
    );

    expect(() =>
      validateCanopyJson(
        repoWithPattern({
          pattern: 'https?://\\S+',
          color: 'red',
        }),
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: repos[0]: repo script "launch" devServerPattern contains unsupported key "color"',
    );
  });
});

describe('canopy-json chat hook if-command', () => {
  it('accepts and trims if-command on chat hooks', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review the PR',
                'if-command': ' test -f "$CANOPY_PR_CURRENT_FILE" ',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review the PR',
            'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
          },
        ],
      },
    });
  });

  it('rejects empty if-command values', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review the PR',
                'if-command': '   ',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: if-command must not be empty',
    );
  });
});

describe('canopy-json command hook shell', () => {
  it('accepts command hook shell overrides per platform', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'command',
                command: ' echo hook ',
                shell: { windows: 'cmd', mac: 'bash' },
                interactive: true,
              },
              {
                type: 'command',
                command: 'echo mac only',
                shell: { mac: 'zsh' },
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'command',
            command: 'echo hook',
            shell: { windows: 'cmd', mac: 'bash' },
            interactive: true,
          },
          {
            type: 'command',
            command: 'echo mac only',
            shell: { mac: 'zsh' },
          },
        ],
      },
    });
  });

  it('normalizes interactive command hook booleans', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              { type: 'command', command: 'read name', interactive: true },
              { type: 'command', command: 'echo done', interactive: false },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          { type: 'command', command: 'read name', interactive: true },
          { type: 'command', command: 'echo done' },
        ],
      },
    });
  });

  it.each([
    [
      { windows: 'zsh' },
      'shell.windows must be "cmd", "powershell", or "bash"',
    ],
    [{ mac: 'powershell' }, 'shell.mac must be "zsh" or "bash"'],
    [{ linux: 'bash' }, 'shell contains unsupported key "linux"'],
    [{}, 'shell must configure windows or mac'],
    ['zsh', 'shell must be an object'],
  ])('rejects invalid command hook shell value %#', (shell, message) => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'command',
                command: 'echo hook',
                shell,
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(`/tmp/canopy.json: hook "pr:create": actions[0]: ${message}`);
  });
});

describe('canopy-json chat hook plugins', () => {
  it('accepts shareable plugin refs on chat hooks', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review the PR',
                plugins: [
                  {
                    type: 'skill',
                    source: { type: 'github', repo: 'Org/Skills' },
                    skill_name: 'reviewer',
                  },
                  {
                    type: 'plugin',
                    marketplace: { type: 'github', repo: 'Org/Marketplace' },
                    plugin_name: 'browser',
                  },
                  {
                    type: 'claude_plugin',
                    marketplace: { type: 'builtin', id: 'app' },
                    plugin_name: 'commit-helper',
                  },
                  {
                    type: 'codex_plugin',
                    marketplace: {
                      type: 'codex-builtin',
                      id: 'openai-curated',
                    },
                    plugin_name: 'codex-security',
                  },
                ],
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review the PR',
            plugins: [
              {
                type: 'skill',
                source: { type: 'github', repo: 'org/skills' },
                skill_name: 'reviewer',
              },
              {
                type: 'plugin',
                marketplace: { type: 'github', repo: 'org/marketplace' },
                plugin_name: 'browser',
              },
              {
                type: 'claude_plugin',
                marketplace: { type: 'builtin', id: 'app' },
                plugin_name: 'commit-helper',
              },
              {
                type: 'codex_plugin',
                marketplace: {
                  type: 'codex-builtin',
                  id: 'openai-curated',
                },
                plugin_name: 'codex-security',
              },
            ],
          },
        ],
      },
    });
  });
});

describe('canopy-json chat hook allowChatConcurrency', () => {
  it('accepts allowChatConcurrency: true on chat hooks', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review the PR',
                allowChatConcurrency: true,
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review the PR',
            allowChatConcurrency: true,
          },
        ],
      },
    });
  });

  it('accepts allowChatConcurrency: false as the default behavior', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review the PR',
                allowChatConcurrency: false,
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review the PR',
          },
        ],
      },
    });
  });

  it('rejects non-boolean allowChatConcurrency values', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review the PR',
                allowChatConcurrency: 'true',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: allowChatConcurrency must be a boolean',
    );
  });
});

describe('canopy-json chat hook autoArchive', () => {
  it('accepts autoArchive: true and drops autoArchive: false', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              { type: 'chat', prompt: 'Archive me', autoArchive: true },
              { type: 'chat', prompt: 'Keep me', autoArchive: false },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          { type: 'chat', prompt: 'Archive me', autoArchive: true },
          { type: 'chat', prompt: 'Keep me' },
        ],
      },
    });
  });

  it('rejects non-boolean autoArchive values', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              { type: 'chat', prompt: 'Review the PR', autoArchive: 'yes' },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: autoArchive must be a boolean',
    );
  });
});

describe('canopy-json pipeline hook actions', () => {
  it('accepts a curated pipeline hook reference', () => {
    const document = {
      version: 1,
      hooks: {
        'pr:create': [
          { type: 'pipeline', source: 'curated', id: 'curated:review' },
        ],
      },
    };
    expect(validateCanopyJson(document, '/tmp/canopy.json')).toEqual(document);
  });

  it('accepts valid bundled, local, and project pipeline actions', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'pipeline',
                source: 'bundled',
                id: 'code-review',
                inputs: {
                  pr_url: '{{CANOPY_PR_URL}}',
                },
                allowPipelineConcurrency: true,
              },
              {
                type: 'pipeline',
                source: 'local',
                id: 'local-review',
              },
              {
                type: 'pipeline',
                source: 'project',
                id: 'ci/review.yaml',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'code-review',
            inputs: {
              pr_url: '{{CANOPY_PR_URL}}',
            },
            allowPipelineConcurrency: true,
          },
          {
            type: 'pipeline',
            source: 'local',
            id: 'local-review',
          },
          {
            type: 'pipeline',
            source: 'project',
            id: 'ci/review.yaml',
          },
        ],
      },
    });
  });

  it('rejects invalid pipeline sources', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'pipeline',
                source: 'remote',
                id: 'review',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: source must be one of "bundled", "local", "project", or "curated"',
    );
  });

  it('rejects blank pipeline ids', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'pipeline',
                source: 'bundled',
                id: '   ',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: id must not be empty',
    );
  });

  it('rejects unsafe project pipeline ids', () => {
    for (const id of [
      '/tmp/review.yaml',
      '../review.yaml',
      'ci//review.yaml',
      'review.json',
    ]) {
      expect(() =>
        validateCanopyJson(
          {
            version: 1,
            hooks: {
              'pr:create': [
                {
                  type: 'pipeline',
                  source: 'project',
                  id,
                },
              ],
            },
          },
          '/tmp/canopy.json',
        ),
      ).toThrow();
    }
  });

  it('rejects non-string pipeline input values', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'pipeline',
                source: 'bundled',
                id: 'review',
                inputs: {
                  pr_url: 42,
                },
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: input "pr_url" must be a string',
    );
  });

  it('rejects non-boolean allowPipelineConcurrency values', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'pipeline',
                source: 'bundled',
                id: 'review',
                allowPipelineConcurrency: 'true',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: allowPipelineConcurrency must be a boolean',
    );
  });
});

describe('canopy-json planDetection', () => {
  it('parses and preserves planDetection rules', () => {
    const manifest = validateCanopyJson(
      {
        version: 1,
        planDetection: {
          rules: [
            {
              id: 'team-specs',
              label: 'Team specs',
              kind: 'include',
              pattern: 'specs/*.md',
              enabled: true,
            },
            { id: 'bad', kind: 'nope' },
          ],
        },
      },
      '/repo/canopy.json',
    );
    expect(manifest.planDetection?.rules).toHaveLength(1);
    expect(manifest.planDetection?.rules?.[0].id).toBe('team-specs');
  });

  it('returns undefined planDetection when the key is absent', () => {
    const manifest = validateCanopyJson({ version: 1 }, '/repo/canopy.json');
    expect(manifest.planDetection).toBeUndefined();
  });

  it('returns undefined planDetection when no rules survive', () => {
    const manifest = validateCanopyJson(
      { version: 1, planDetection: {} },
      '/repo/canopy.json',
    );
    expect(manifest.planDetection).toBeUndefined();
  });

  it('deduplicates planDetection rules by id, keeping the first', () => {
    const manifest = validateCanopyJson(
      {
        version: 1,
        planDetection: {
          rules: [
            {
              id: 'dup',
              label: 'First',
              kind: 'include',
              pattern: 'a/*.md',
              enabled: true,
            },
            {
              id: 'dup',
              label: 'Second',
              kind: 'exclude',
              pattern: 'b/*.md',
              enabled: false,
            },
          ],
        },
      },
      '/repo/canopy.json',
    );
    expect(manifest.planDetection?.rules).toHaveLength(1);
    expect(manifest.planDetection?.rules?.[0].label).toBe('First');
  });
});

describe('canopy-json top-level plugins', () => {
  it('accepts, normalizes, and deduplicates shareable plugin recommendations', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          plugins: [
            {
              type: 'skill',
              source: { type: 'github', repo: 'Org/Skills' },
              skill_name: 'reviewer',
            },
            {
              type: 'skill',
              source: { type: 'github', repo: 'org/skills' },
              skill_name: 'reviewer',
            },
            {
              type: 'skill',
              source: { type: 'builtin', id: 'app' },
              skill_name: 'canopy-config',
            },
            {
              type: 'plugin',
              marketplace: { type: 'github', repo: 'Org/Marketplace' },
              plugin_name: 'dynamic-browser',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'github', repo: 'Org/Marketplace' },
              plugin_name: 'browser',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'builtin', id: 'app' },
              plugin_name: 'commit-helper',
            },
            {
              type: 'codex_plugin',
              marketplace: { type: 'codex-builtin', id: 'openai-curated' },
              plugin_name: 'codex-security',
            },
          ],
          x_canopy_future: true,
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      x_canopy_future: true,
      plugins: [
        {
          type: 'skill',
          source: { type: 'github', repo: 'org/skills' },
          skill_name: 'reviewer',
        },
        {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'canopy-config',
        },
        {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'org/marketplace' },
          plugin_name: 'dynamic-browser',
        },
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'org/marketplace' },
          plugin_name: 'browser',
        },
        {
          type: 'claude_plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'commit-helper',
        },
        {
          type: 'codex_plugin',
          marketplace: { type: 'codex-builtin', id: 'openai-curated' },
          plugin_name: 'codex-security',
        },
      ],
    });
  });

  it('rejects bundles with a top-level-specific error', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          plugins: [{ type: 'bundle', id: 'local-bundle' }],
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      'canopy.json top-level plugins only support shareable skill, plugin, claude_plugin, and codex_plugin refs; Collections are local-only in canopy.json',
    );
  });
});
