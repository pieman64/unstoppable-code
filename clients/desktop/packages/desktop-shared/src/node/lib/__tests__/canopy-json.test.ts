import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
  MAX_SCRIPT_TIMEOUT_SECONDS,
} from '../../../scripts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCanopyJson,
  validateCanopyJson,
  writeCanopyJson,
} from '../canopy-json';

describe('dev-server autoOpen', () => {
  it.each([true, false])(
    'preserves boolean autoOpen %s at root and repo scope',
    (autoOpen) => {
      const script = {
        command: 'npm run dev',
        devServerPattern: { pattern: 'https?://\\S+', autoOpen },
      };
      const config = validateCanopyJson(
        {
          version: 1,
          scripts: { launch: script },
          repos: [
            {
              id: 'web',
              name: 'Web',
              url: 'https://github.com/example/web.git',
              scripts: { launch: script },
            },
          ],
        },
        '/tmp/canopy.json',
      );
      expect(config.scripts?.launch).toEqual(script);
      expect(config.repos?.[0]?.scripts?.launch).toEqual(script);
    },
  );

  it.each(['true', 1, null, {}, []])(
    'rejects non-boolean autoOpen %j',
    (autoOpen) => {
      expect(() =>
        validateCanopyJson(
          {
            version: 1,
            scripts: {
              launch: {
                command: 'npm run dev',
                devServerPattern: [{ pattern: 'https?://\\S+', autoOpen }],
              },
            },
          },
          '/tmp/canopy.json',
        ),
      ).toThrow('devServerPattern autoOpen must be a boolean');
    },
  );
});

describe('desktop-shared node canopy-json script timeoutSeconds', () => {
  it('keeps valid start pages and drops invalid ones without rejecting other config', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          scripts: { test: 'npm test' },
          startPage: { kind: 'file', path: 'README.md' },
        },
        '/tmp/canopy.json',
      ),
    ).toMatchObject({
      scripts: { test: 'npm test' },
      startPage: { kind: 'file', path: 'README.md' },
    });
    expect(
      validateCanopyJson(
        {
          version: 1,
          scripts: { test: 'npm test' },
          startPage: { kind: 'file', path: '../secret' },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({ version: 1, scripts: { test: 'npm test' } });
  });

  it('accepts interactive script definitions at project and repo scope', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            setup: { command: 'npm run setup-wizard', interactive: true },
          },
          repos: [
            {
              id: 'web',
              name: 'Web',
              url: 'https://example.test/web.git',
              scripts: {
                launch: { command: 'npm run dev', interactive: true },
              },
            },
          ],
        },
        '/tmp/canopy.json',
      ),
    ).toMatchObject({
      scripts: {
        setup: { command: 'npm run setup-wizard', interactive: true },
      },
      repos: [
        {
          scripts: {
            launch: { command: 'npm run dev', interactive: true },
          },
        },
      ],
    });
  });

  it('rejects non-boolean interactive script metadata', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            setup: { command: 'npm install', interactive: 'yes' },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow('/tmp/canopy.json: script "setup" interactive must be a boolean');
  });

  it('canonicalizes an explicitly disabled interactive flag to legacy string form', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            test: { command: 'npm test', interactive: false },
          },
        },
        '/tmp/canopy.json',
      ).scripts,
    ).toEqual({ test: 'npm test' });
  });

  it('uses the actual project config filename in top-level validation errors', () => {
    expect(() => validateCanopyJson([], '/tmp/testbrand.json')).toThrow(
      '/tmp/testbrand.json: testbrand.json must contain a JSON object',
    );
    expect(() => validateCanopyJson({}, '/tmp/testbrand.json')).toThrow(
      '/tmp/testbrand.json: testbrand.json version must be 1',
    );
  });

  it('accepts legacy strings and object scripts with timeoutSeconds', () => {
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
            disabled: {
              command: './scripts/watch.sh',
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
                  timeoutSeconds: 1,
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
        disabled: {
          command: './scripts/watch.sh',
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
              timeoutSeconds: 1,
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

  it('rejects unsupported script object keys', () => {
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
    [{ solaris: 'bash' }, 'shell contains unsupported key "solaris"'],
    [{}, 'shell must configure windows, mac, or linux'],
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

  it('compacts command-only object scripts to strings', () => {
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

describe('desktop-shared node canopy-json script devServerPattern', () => {
  it('accepts string, object, and array devServerPattern shapes', () => {
    const parsed = validateCanopyJson(
      {
        version: 1,
        scripts: {
          launchString: {
            command: 'npm run dev',
            devServerPattern: 'https?://localhost:\\d+\\S*',
          },
          launchObject: {
            command: 'npm run dev',
            devServerPattern: {
              pattern: 'Local:\\s+(https?://\\S+)',
              label: 'Web App',
            },
          },
          launchObjectNoLabel: {
            command: 'npm run dev',
            devServerPattern: {
              pattern: 'Docs:\\s+(https?://\\S+)',
            },
          },
          launchArray: {
            command: 'npm run dev',
            devServerPattern: [
              { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
              'https?://localhost:\\d+\\S*',
            ],
          },
        },
        repos: [
          {
            id: 'api',
            name: 'API',
            url: 'https://example.com/api.git',
            scripts: {
              launch: {
                command: 'npm run api',
                devServerPattern: [
                  'API:\\s+(https?://\\S+)',
                  { pattern: 'Health:\\s+(https?://\\S+)', label: 'Health' },
                ],
              },
            },
          },
        ],
      },
      '/tmp/canopy.json',
    );
    expect(parsed.scripts).toEqual({
      launchString: {
        command: 'npm run dev',
        devServerPattern: 'https?://localhost:\\d+\\S*',
      },
      launchObject: {
        command: 'npm run dev',
        devServerPattern: {
          pattern: 'Local:\\s+(https?://\\S+)',
          label: 'Web App',
        },
      },
      launchObjectNoLabel: {
        command: 'npm run dev',
        devServerPattern: {
          pattern: 'Docs:\\s+(https?://\\S+)',
        },
      },
      launchArray: {
        command: 'npm run dev',
        devServerPattern: [
          { pattern: 'Admin:\\s+(https?://\\S+)', label: 'Admin' },
          'https?://localhost:\\d+\\S*',
        ],
      },
    });
    expect(parsed.repos?.[0]?.scripts?.launch).toEqual({
      command: 'npm run api',
      devServerPattern: [
        'API:\\s+(https?://\\S+)',
        { pattern: 'Health:\\s+(https?://\\S+)', label: 'Health' },
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

  it('accepts repo script string, object, and mixed-array devServerPattern shapes', () => {
    const parsed = validateCanopyJson(
      {
        version: 1,
        repos: [
          {
            id: 'api',
            name: 'API',
            url: 'https://example.com/api.git',
            scripts: {
              launchString: {
                command: 'npm run api',
                devServerPattern: 'API:\\s+(https?://\\S+)',
              },
              launchObject: {
                command: 'npm run docs',
                devServerPattern: {
                  pattern: 'Docs:\\s+(https?://\\S+)',
                  label: 'Docs',
                },
              },
              launchMixed: {
                command: 'npm run admin',
                devServerPattern: [
                  'Admin:\\s+(https?://\\S+)',
                  { pattern: 'Health:\\s+(https?://\\S+)', label: 'Health' },
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
        command: 'npm run api',
        devServerPattern: 'API:\\s+(https?://\\S+)',
      },
      launchObject: {
        command: 'npm run docs',
        devServerPattern: {
          pattern: 'Docs:\\s+(https?://\\S+)',
          label: 'Docs',
        },
      },
      launchMixed: {
        command: 'npm run admin',
        devServerPattern: [
          'Admin:\\s+(https?://\\S+)',
          { pattern: 'Health:\\s+(https?://\\S+)', label: 'Health' },
        ],
      },
    });
  });

  it('rejects unparseable regex patterns', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: '(unclosed',
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/devServerPattern pattern must be a valid JavaScript regex/);
  });

  it('rejects an empty devServerPattern string', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: '   ',
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/devServerPattern pattern must be a non-empty string/);
  });

  it('rejects a pattern longer than the documented cap', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: 'a'.repeat(
                MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH + 1,
              ),
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/devServerPattern pattern must be at most/);
  });

  it('rejects empty array and oversized arrays', () => {
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
  });

  it('rejects unsupported keys on entry objects', () => {
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
    ).toThrow(/devServerPattern contains unsupported key "color"/);
  });

  it('rejects labels that are empty or exceed the cap', () => {
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
    ).toThrow(/devServerPattern label must be a non-empty string/);
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
  });

  it('rejects entries that are neither strings nor records', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern: [42],
            },
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/devServerPattern must be a string, object, or array/);
  });

  it('rejects invalid repo script devServerPattern values', () => {
    const repoWithPattern = (
      devServerPattern: unknown,
    ): Record<string, unknown> => ({
      version: 1,
      repos: [
        {
          id: 'api',
          name: 'API',
          url: 'https://example.com/api.git',
          scripts: {
            launch: {
              command: 'npm run api',
              devServerPattern,
            },
          },
        },
      ],
    });

    expect(() =>
      validateCanopyJson(repoWithPattern('(unclosed'), '/tmp/canopy.json'),
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

describe('desktop-shared node canopy-json shared desktop behavior', () => {
  it('round-trips portable configured file references and plan mode', () => {
    const action = {
      type: 'chat',
      prompt: 'Read src/a.ts',
      planMode: true,
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
    expect(
      validateCanopyJson(
        { version: 1, hooks: { 'pr:create': [action] } },
        '/tmp/canopy.json',
      ),
    ).toMatchObject({ hooks: { 'pr:create': [action] } });
  });

  it('rejects installed-only plugin references in source-controlled hooks', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Use Notes',
                promptReferences: [
                  {
                    kind: 'plugin',
                    textStart: 4,
                    displayText: 'Notes',
                    plugin: {
                      kind: 'installed',
                      marketplaceId: 'local',
                      pluginName: 'notes',
                    },
                  },
                ],
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/promptReferences|installed/);
  });

  it('parses planDetection rules', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          planDetection: {
            rules: [
              {
                id: 'team-specs',
                label: 'Team Specs',
                kind: 'include',
                pattern: 'docs/specs/*.md',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      planDetection: {
        rules: [
          {
            id: 'team-specs',
            label: 'Team Specs',
            kind: 'include',
            pattern: 'docs/specs/*.md',
            enabled: true,
          },
        ],
      },
    });
  });

  it('retains all three chat-hook Codex speeds with the derived legacy boolean', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Ultra',
                modelConfig: { speed: 'ultrafast' },
              },
              {
                type: 'chat',
                prompt: 'Fast',
                modelConfig: { speed: 'fast', fastMode: true },
              },
              {
                type: 'chat',
                prompt: 'Regular',
                modelConfig: { speed: 'standard', thinkingLevel: 'low' },
              },
              { type: 'chat', prompt: 'Legacy', codexFastMode: true },
              { type: 'chat', prompt: 'Inherit' },
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
            prompt: 'Ultra',
            modelConfig: { speed: 'ultrafast', fastMode: false },
          },
          {
            type: 'chat',
            prompt: 'Fast',
            modelConfig: { speed: 'fast', fastMode: true },
          },
          {
            type: 'chat',
            prompt: 'Regular',
            modelConfig: {
              speed: 'standard',
              fastMode: false,
              thinkingLevel: 'low',
            },
          },
          {
            type: 'chat',
            prompt: 'Legacy',
            modelConfig: { fastMode: true },
          },
          { type: 'chat', prompt: 'Inherit' },
        ],
      },
    });
  });

  it('rejects invalid or contradictory chat-hook speeds', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              { type: 'chat', prompt: 'Bad', modelConfig: { speed: 'turbo' } },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow('modelConfig.speed');
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Bad',
                modelConfig: { speed: 'ultrafast', fastMode: true },
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow('modelConfig.fastMode');
  });

  it('keeps pipeline hooks boolean and explicitly rejects Ultra fast', () => {
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
                modelConfig: { speed: 'fast' },
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
            modelConfig: { fastMode: true },
          },
        ],
      },
    });
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'pipeline',
                source: 'bundled',
                id: 'code-review',
                modelConfig: { speed: 'ultrafast' },
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow('Ultra fast');
  });

  it('accepts autoArchive: true and drops autoArchive: false on chat hooks', () => {
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

  it('round-trips non-escalating chat hook modes and drops invalid or full-access modes', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              { type: 'chat', prompt: 'Auto fix', approvalMode: 'auto' },
              {
                type: 'chat',
                prompt: 'Unsafe mode',
                approvalMode: 'full-access',
              },
              { type: 'chat', prompt: 'Bad mode', approvalMode: 'garbage' },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      hooks: {
        'pr:create': [
          { type: 'chat', prompt: 'Auto fix', approvalMode: 'auto' },
          { type: 'chat', prompt: 'Unsafe mode' },
          { type: 'chat', prompt: 'Bad mode' },
        ],
      },
    });
  });

  it('rejects machine-local plugin selections in source-controlled hooks', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              {
                type: 'chat',
                prompt: 'Review with local tools',
                pluginSelections: {
                  collectionIds: ['team-tools'],
                  skillRefs: [
                    {
                      sourceId: 'custom:local',
                      skillName: 'review-checklist',
                    },
                  ],
                  pluginRefs: [],
                  mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
                },
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(/pluginSelections.*not allowed in canopy\.json/);
  });

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
                command: 'echo windows only',
                shell: { windows: 'bash' },
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
            command: 'echo windows only',
            shell: { windows: 'bash' },
          },
        ],
      },
    });
  });

  it('accepts interactive command hooks and drops explicit false', () => {
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

  it('rejects non-boolean interactive command hook values', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          hooks: {
            'pr:create': [
              { type: 'command', command: 'read name', interactive: 'yes' },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: hook "pr:create": actions[0]: interactive must be a boolean',
    );
  });

  it.each([
    [
      { windows: 'zsh' },
      'shell.windows must be "cmd", "powershell", or "bash"',
    ],
    [{ mac: 'powershell' }, 'shell.mac must be "zsh" or "bash"'],
    [{ solaris: 'bash' }, 'shell contains unsupported key "solaris"'],
    [{}, 'shell must configure windows, mac, or linux'],
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

describe('desktop-shared node canopy-json top-level plugins', () => {
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

  it('rejects non-array top-level plugins', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          plugins: { type: 'skill' },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow('/tmp/canopy.json: plugins must be an array');
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

describe('desktop-shared node canopy-json approvals', () => {
  it('parses defaultMode and rules, stamping rule origin as canopy-json', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          approvals: {
            defaultMode: 'auto',
            rules: [
              {
                id: 'allow-npm-test',
                behavior: 'allow',
                target: { kind: 'command', pattern: 'npm test' },
                createdAt: '2026-07-20T00:00:00.000Z',
                origin: 'prompt',
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      approvals: {
        defaultMode: 'auto',
        rules: [
          {
            id: 'allow-npm-test',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'npm test' },
            createdAt: '2026-07-20T00:00:00.000Z',
            origin: 'canopy-json',
          },
        ],
      },
    });
  });

  it('assigns stable synthetic ids to manifest approval rules without ids', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          approvals: {
            rules: [
              {
                behavior: 'deny',
                target: { kind: 'command', pattern: 'rm -rf *' },
              },
              {
                behavior: 'deny',
                target: { kind: 'network', host: 'example.com' },
              },
            ],
          },
        },
        '/tmp/canopy.json',
      ).approvals?.rules,
    ).toEqual([
      expect.objectContaining({ id: 'canopy-json:0', origin: 'canopy-json' }),
      expect.objectContaining({ id: 'canopy-json:1', origin: 'canopy-json' }),
    ]);
  });

  it('silently drops a full-access defaultMode (non-escalation)', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          approvals: {
            defaultMode: 'full-access',
          },
        },
        '/tmp/canopy.json',
      ),
    ).toEqual({
      version: 1,
      approvals: {},
    });
  });

  it('throws on an invalid defaultMode string', () => {
    expect(() =>
      validateCanopyJson(
        {
          version: 1,
          approvals: {
            defaultMode: 'garbage',
          },
        },
        '/tmp/canopy.json',
      ),
    ).toThrow(
      '/tmp/canopy.json: approvals.defaultMode must be "ask" or "auto"',
    );
  });

  it('omits approvals from the manifest when absent', () => {
    expect(validateCanopyJson({ version: 1 }, '/tmp/canopy.json')).toEqual({
      version: 1,
    });
  });

  it('normalizes portable environment dependencies', () => {
    expect(
      validateCanopyJson(
        {
          version: 1,
          dependencies: [
            {
              id: 'linear',
              kind: 'mcp',
              server: { catalog_id: 'linear' },
              required: true,
            },
            {
              id: 'github',
              kind: 'connector',
              connector: 'github',
            },
          ],
        },
        '/tmp/canopy.json',
      ).dependencies,
    ).toEqual([
      expect.objectContaining({ id: 'linear', kind: 'mcp', required: true }),
      expect.objectContaining({
        id: 'github',
        kind: 'connector',
        required: false,
      }),
    ]);
  });

  it.each(['skill', 'plugin'])(
    'rejects %s dependencies in favor of plugins',
    (kind) => {
      const dependency =
        kind === 'skill'
          ? {
              id: 'reviewer',
              kind,
              ref: {
                type: 'skill',
                source: { type: 'builtin', id: 'canopy' },
                skill_name: 'reviewer',
              },
            }
          : {
              id: 'browser',
              kind,
              ref: {
                type: 'claude_plugin',
                marketplace: { type: 'builtin', id: 'canopy' },
                plugin_name: 'browser',
              },
            };
      expect(() =>
        validateCanopyJson(
          { version: 1, dependencies: [dependency] },
          '/tmp/canopy.json',
        ),
      ).toThrow('plugins');
    },
  );
});

describe('Linux script and hook shells', () => {
  function manifest(linux: unknown): unknown {
    const script = { command: 'echo script', shell: { linux } };
    const hook = { type: 'command', command: 'echo hook', shell: { linux } };
    return {
      version: 1,
      scripts: { setup: script },
      hooks: { 'pr:create': [hook] },
      repos: [
        {
          id: 'web',
          name: 'Web',
          url: 'https://example.com/web.git',
          scripts: { setup: script },
          hooks: { 'pr:create': [hook] },
        },
      ],
    };
  }

  it.each(['bash', 'zsh'])(
    'accepts Linux %s at project and repo scope',
    (linux) => {
      const config = manifest(linux);
      expect(validateCanopyJson(config, '/tmp/canopy.json')).toEqual(config);
    },
  );

  it.each(['fish', 'cmd', 'powershell', '', null, 1, {}, []])(
    'rejects unsupported Linux shell %j for scripts and hooks',
    (linux) => {
      const shell = { linux };
      const script = { command: 'echo script', shell };
      const hook = { type: 'command', command: 'echo hook', shell };
      for (const config of [
        { version: 1, scripts: { setup: script } },
        { version: 1, hooks: { 'pr:create': [hook] } },
        {
          version: 1,
          repos: [
            {
              id: 'web',
              name: 'Web',
              url: 'https://example.com/web.git',
              scripts: { setup: script },
            },
          ],
        },
        {
          version: 1,
          repos: [
            {
              id: 'web',
              name: 'Web',
              url: 'https://example.com/web.git',
              hooks: { 'pr:create': [hook] },
            },
          ],
        },
      ]) {
        expect(() => validateCanopyJson(config, '/tmp/canopy.json')).toThrow(
          'shell.linux must be "bash" or "zsh"',
        );
      }
    },
  );

  it('preserves the existing macOS and Windows overrides alongside Linux', () => {
    const shell = { windows: 'cmd', mac: 'zsh', linux: 'bash' };
    const script = { command: 'echo script', shell };
    const hook = { type: 'command', command: 'echo hook', shell };
    const config = {
      version: 1,
      scripts: { setup: script },
      hooks: { 'pr:create': [hook] },
    };
    expect(validateCanopyJson(config, '/tmp/canopy.json')).toEqual(config);
  });

  it('reads and writes the legacy config fixture byte-for-byte without adding Linux defaults', async () => {
    const original = await readFile(
      join(__dirname, 'fixtures', 'legacy-shell-config.json'),
    );
    const repoPath = await mkdtemp(join(tmpdir(), 'canopy-linux-shell-'));
    try {
      const configPath = join(repoPath, 'canopy.json');
      await writeFile(configPath, original);
      const config = await readCanopyJson(repoPath);
      expect(config).not.toBeNull();
      if (config === null) throw new Error('Expected legacy config fixture');
      await writeCanopyJson(repoPath, config);
      expect(await readFile(configPath)).toEqual(original);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
