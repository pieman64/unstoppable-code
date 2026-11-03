import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CORE_INSTRUCTION_DEFINITIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_METADATA_ERROR_CODES,
  CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
  composeCanopyOperationEnvelopes,
  type CoreWorkspaceMetadataOperation,
  type CoreWorkspacePlanDetection,
} from '../canopy-core';
import type { WorkspacePlanDetectionConfig } from '../plan-detection';

// W7a-1a (CAN-5523): the six desktop-owned metadata commands' fixtures must
// validate the same way against their Zod definitions and their pages.

const PAGES = resolve(
  __dirname,
  '../../../../docs/planning/2026-07-31-desktop-core-daemon/protocol/core/workspace',
);
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const definitions = CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS;
const OPERATIONS = [
  'core.workspace.reorder',
  'core.workspace.scripts.update',
  'core.workspace.planDetection.update',
  'core.workspace.privateMemory.update',
  'core.workspace.repository.add',
  'core.workspace.repository.remove',
] as const satisfies readonly CoreWorkspaceMetadataOperation[];
const operations: readonly CoreWorkspaceMetadataOperation[] = OPERATIONS;

function pageSchemas(name: string): {
  request: ValidateFunction;
  response: ValidateFunction;
} {
  const markdown = readFileSync(resolve(PAGES, `${name}.md`), 'utf8');
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match): unknown => JSON.parse(match[1] ?? 'null'),
  );
  const [request, response] = blocks;
  if (
    blocks.length !== 2 ||
    typeof request !== 'object' ||
    request === null ||
    typeof response !== 'object' ||
    response === null
  )
    throw new Error(`${name}: expected a request and a response schema`);
  return { request: ajv.compile(request), response: ajv.compile(response) };
}

const KEY = { idempotencyKey: 'key-1' };
const request = (name: string, params: unknown): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  method: name,
  params,
});
const success = (result: unknown): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  result,
});
const failure = (data: unknown): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  error: { code: -32006, message: 'Refused.', data },
});

interface Fixtures {
  valid: Record<string, unknown>[];
  invalid: [label: string, params: unknown][];
  results: unknown[];
  invalidResults: [label: string, result: unknown][];
}

const repository = { id: 'api', name: 'API', source: 'local' as const };
const selection = { kind: 'local_picker_selection', selectionId: 's' };
const NEW_REPOSITORY_MAX = 128;

const FIXTURES: Record<CoreWorkspaceMetadataOperation, Fixtures> = {
  'core.workspace.reorder': {
    valid: [
      {
        visibleWorkspaceIds: ['a', 'b', 'c'],
        activeWorkspaceId: 'c',
        overWorkspaceId: 'a',
        _meta: KEY,
      },
      {
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
        expectedRevision: 0,
        _meta: { ...KEY, traceparent: 't' },
      },
    ],
    invalid: [
      [
        'no visible workspaces',
        {
          visibleWorkspaceIds: [],
          activeWorkspaceId: 'a',
          overWorkspaceId: 'b',
          _meta: KEY,
        },
      ],
      ['the host-only whole order', { workspaceOrder: ['a', 'b'], _meta: KEY }],
      [
        'too many visible workspaces',
        {
          visibleWorkspaceIds: Array.from({ length: 4097 }, (_, i) => `w${i}`),
          activeWorkspaceId: 'w1',
          overWorkspaceId: 'w2',
          _meta: KEY,
        },
      ],
    ],
    results: [{ acknowledged: true }],
    invalidResults: [
      ['a refusal shaped as success', { acknowledged: false }],
      ['the stored order', { acknowledged: true, workspaceIds: ['a'] }],
    ],
  },
  'core.workspace.scripts.update': {
    valid: [
      {
        workspaceId: 'w',
        change: {
          kind: 'replace',
          scripts: {
            setup: 'pnpm install',
            teardown: null,
            launch: {
              command: 'pnpm dev',
              timeoutSeconds: null,
              devServerPattern: [
                'http://localhost:\\d+',
                { pattern: 'ready', openTarget: 'in-app', autoOpen: true },
              ],
              shell: { mac: 'zsh', windows: 'powershell' },
            },
          },
        },
        _meta: KEY,
      },
      { workspaceId: 'w', change: { kind: 'replace' }, _meta: KEY },
      {
        workspaceId: 'w',
        expectedRevision: 3,
        change: { kind: 'merge-commands', commands: { setup: '' } },
        _meta: KEY,
      },
      {
        workspaceId: 'w',
        change: {
          kind: 'repositories',
          repos: [
            { repoId: 'api', scripts: { setup: 'make' } },
            { repoId: 'x' },
          ],
        },
        _meta: KEY,
      },
      {
        workspaceId: 'w',
        change: {
          kind: 'definition',
          repoId: 'api',
          name: 'lint',
          value: { command: 'pnpm lint', interactive: false },
        },
        _meta: KEY,
      },
      {
        workspaceId: 'w',
        change: { kind: 'remove-definition', name: 'lint' },
        _meta: KEY,
      },
    ],
    invalid: [
      [
        'a timeout above the bound',
        {
          workspaceId: 'w',
          change: {
            kind: 'definition',
            name: 'x',
            value: { command: 'x', timeoutSeconds: 2_000_001 },
          },
          _meta: KEY,
        },
      ],
      [
        'an empty script name',
        {
          workspaceId: 'w',
          change: { kind: 'replace', scripts: { '': 'x' } },
          _meta: KEY,
        },
      ],
      [
        'an unknown shell',
        {
          workspaceId: 'w',
          change: {
            kind: 'definition',
            name: 'x',
            value: { command: 'x', shell: { linux: 'fish' } },
          },
          _meta: KEY,
        },
      ],
      [
        'an unknown change kind',
        { workspaceId: 'w', change: { kind: 'hooks' }, _meta: KEY },
      ],
    ],
    results: [{}, { revision: 4 }],
    invalidResults: [['a non-object result', null]],
  },
  'core.workspace.planDetection.update': {
    valid: [
      { workspaceId: 'w', planDetection: {}, _meta: KEY },
      {
        workspaceId: 'w',
        expectedRevision: 1,
        planDetection: {
          disabledRuleIds: ['builtin-docs'],
          customRules: [
            {
              id: 'plans',
              label: '',
              kind: 'include',
              pattern: 'plans/**/*.md',
              enabled: true,
            },
            // The rules editor defaults the label to the pattern.
            {
              id: 'long',
              label: `${'d/'.repeat(2047)}*`,
              kind: 'exclude',
              pattern: `${'d/'.repeat(2047)}*`,
              enabled: true,
            },
          ],
        },
        _meta: KEY,
      },
    ],
    invalid: [
      [
        'a rule without enabled',
        {
          workspaceId: 'w',
          planDetection: {
            customRules: [
              { id: 'a', label: 'a', kind: 'include', pattern: '*.md' },
            ],
          },
          _meta: KEY,
        },
      ],
      [
        'an unknown rule kind',
        {
          workspaceId: 'w',
          planDetection: {
            customRules: [
              {
                id: 'a',
                label: 'a',
                kind: 'veto',
                pattern: '*.md',
                enabled: true,
              },
            ],
          },
          _meta: KEY,
        },
      ],
      [
        'an empty disabled id',
        {
          workspaceId: 'w',
          planDetection: { disabledRuleIds: [''] },
          _meta: KEY,
        },
      ],
      [
        'a label longer than a pattern may be',
        {
          workspaceId: 'w',
          planDetection: {
            customRules: [
              {
                id: 'a',
                label: 'x'.repeat(4097),
                kind: 'include',
                pattern: '*.md',
                enabled: true,
              },
            ],
          },
          _meta: KEY,
        },
      ],
      [
        'too many rules',
        {
          workspaceId: 'w',
          planDetection: {
            disabledRuleIds: Array.from({ length: 1001 }, (_, i) => `r${i}`),
          },
          _meta: KEY,
        },
      ],
    ],
    results: [{}],
    invalidResults: [
      ['a non-object result', 'ok'],
      // Closed, unlike the first-come #6 result.
      ['a revision', { revision: 4 }],
      ['a host path', { hostPath: '/Users/alice/private' }],
    ],
  },
  'core.workspace.privateMemory.update': {
    valid: [
      { workspaceId: 'w', privateMemory: true, _meta: KEY },
      {
        workspaceId: 'standalone-chats',
        privateMemory: false,
        expectedRevision: 2,
        _meta: KEY,
      },
    ],
    invalid: [
      [
        'the standalone chat sentinel',
        { workspaceId: 'standalone-chat', privateMemory: true, _meta: KEY },
      ],
      [
        'the host-only organization marker',
        {
          workspaceId: 'w',
          privateMemory: true,
          privateMemoryManagedBy: 'organization',
          _meta: KEY,
        },
      ],
      [
        'a non-boolean choice',
        { workspaceId: 'w', privateMemory: 'on', _meta: KEY },
      ],
    ],
    results: [{ workspaceId: 'w', privateMemory: true }],
    invalidResults: [
      ['a missing choice', { workspaceId: 'w' }],
      [
        'the host-only organization marker',
        {
          workspaceId: 'w',
          privateMemory: true,
          privateMemoryManagedBy: 'organization',
        },
      ],
    ],
  },
  'core.workspace.repository.add': {
    valid: [
      {
        workspaceId: 'w',
        repository: {
          selection: { kind: 'local_picker_selection', selectionId: 'sel-1' },
        },
        _meta: KEY,
      },
      {
        workspaceId: 'w',
        expectedRevision: 5,
        repository: {
          selection: { kind: 'local_picker_selection', selectionId: 'sel-1' },
          id: 'api',
          name: 'API',
        },
        _meta: KEY,
      },
      {
        workspaceId: 'w',
        repository: {
          selection,
          id: 'a'.repeat(NEW_REPOSITORY_MAX),
          name: 'N'.repeat(NEW_REPOSITORY_MAX),
        },
        _meta: KEY,
      },
    ],
    invalid: [
      [
        // With a `-<n>` suffix it would outgrow the 512 `repoId` a remove takes.
        'an id over the new repository cap',
        {
          workspaceId: 'w',
          repository: { selection, id: 'a'.repeat(NEW_REPOSITORY_MAX + 1) },
          _meta: KEY,
        },
      ],
      [
        'a name over the new repository cap',
        {
          workspaceId: 'w',
          repository: { selection, name: 'N'.repeat(NEW_REPOSITORY_MAX + 1) },
          _meta: KEY,
        },
      ],
      [
        'a host path',
        {
          workspaceId: 'w',
          repository: { repoPath: '/Users/me/api' },
          _meta: KEY,
        },
      ],
      [
        'a host path beside the selection',
        {
          workspaceId: 'w',
          repository: {
            selection: { kind: 'local_picker_selection', selectionId: 's' },
            repoPath: '/Users/me/api',
          },
          _meta: KEY,
        },
      ],
      [
        'another selection kind',
        {
          workspaceId: 'w',
          repository: { selection: { kind: 'git_url', value: 'x' } },
          _meta: KEY,
        },
      ],
      [
        'a host-only source',
        {
          workspaceId: 'w',
          source: 'temporary_combine',
          repository: {
            selection: { kind: 'local_picker_selection', selectionId: 's' },
          },
          _meta: KEY,
        },
      ],
      [
        'a blank name',
        {
          workspaceId: 'w',
          repository: {
            selection: { kind: 'local_picker_selection', selectionId: 's' },
            name: '   ',
          },
          _meta: KEY,
        },
      ],
    ],
    results: [
      { repository },
      {
        repository: {
          ...repository,
          source: 'manifest',
          manifestUrl: 'https://example.com/m.json',
        },
      },
      {
        repository: {
          ...repository,
          source: 'manifest',
          manifestUrl: 'git@github.com:org/api.git',
        },
      },
      {
        repository: {
          ...repository,
          manifestUrl: 'ssh://github.com:22/org/api.git',
        },
      },
      // Generated in the decision: a cap checked after the commit would make
      // the committed add undeliverable.
      {
        repository: {
          id: `${'a'.repeat(1000)}-2`,
          name: 'N'.repeat(5000),
        },
      },
    ],
    invalidResults: [
      [
        'a host path',
        { repository: { ...repository, repoPath: '/Users/me/api' } },
      ],
      [
        'the host-only operation id',
        { repository, scriptActionsOperationId: 'o' },
      ],
      ['an empty id', { repository: { ...repository, id: '' } }],
      // `sanitizeRemoteUrl` never returns these; the projection omits them.
      ...[
        '/Users/alice/api',
        'file:///Users/alice/api',
        'FILE://host/api',
        '~/api',
        'C:\\Users\\alice\\api',
        'c://host/api',
        '\\\\server\\share\\api',
        'https://alice:token@example.com/m.json',
        'https://example.com/m.json?token=x',
        'https://example.com/m.json#x',
        'https:///no-host',
        'deploy@host:org/api.git',
        'api',
        '',
      ].map((manifestUrl): [string, unknown] => [
        `manifestUrl ${JSON.stringify(manifestUrl)}`,
        { repository: { ...repository, manifestUrl } },
      ]),
    ],
  },
  'core.workspace.repository.remove': {
    valid: [
      { workspaceId: 'w', repoId: 'api', _meta: KEY },
      { workspaceId: 'w', repoId: 'api', expectedRevision: 0, _meta: KEY },
    ],
    invalid: [
      [
        'the host-only revert source',
        {
          workspaceId: 'w',
          repoId: 'api',
          source: 'organization_sync_revert',
          _meta: KEY,
        },
      ],
      [
        'a non-slug repository id',
        { workspaceId: 'w', repoId: 'API', _meta: KEY },
      ],
    ],
    results: [
      { removed: repository },
      { removed: null },
      // Stored state: a long legacy name stays deliverable.
      { removed: { id: 'api', name: 'N'.repeat(5000) } },
    ],
    invalidResults: [
      ['a host path', { removed: { ...repository, repoPath: '/r' } }],
      ['scripts', { removed: { ...repository, scripts: { setup: 'x' } } }],
      ['an absent removal', {}],
      [
        'a file manifest URL',
        { removed: { ...repository, manifestUrl: 'file:///Users/alice/api' } },
      ],
    ],
  },
};

// Refused on every one of the six: no source, scope, key-less call, or
// non-slug or negative-revision request crosses the wire.
function commonInvalid(
  valid: Record<string, unknown>,
): [label: string, params: unknown][] {
  const withoutMeta = Object.fromEntries(
    Object.entries(valid).filter(([key]) => key !== '_meta'),
  );
  return [
    ['an unknown property', { ...valid, unknown: true }],
    ['a caller source', { ...valid, source: 'desktop' }],
    ['a scope', { ...valid, scope: { workspaceId: 'w' } }],
    ['no idempotency key', { ...valid, _meta: {} }],
    ['no metadata', withoutMeta],
    ['a negative revision', { ...valid, expectedRevision: -1 }],
    ['a fractional revision', { ...valid, expectedRevision: 1.5 }],
    ...('workspaceId' in valid
      ? ([
          ['an uppercase workspace id', { ...valid, workspaceId: 'W' }],
          ['an empty workspace id', { ...valid, workspaceId: '' }],
          ['a path workspace id', { ...valid, workspaceId: '../w' }],
        ] satisfies [string, unknown][])
      : []),
  ];
}

describe.each(operations)('%s', (name) => {
  const definition = definitions[name];
  const page = pageSchemas(name);
  const envelopes = composeCanopyOperationEnvelopes(name, definition);
  const fixtures = FIXTURES[name];
  const both = (
    validate: ValidateFunction,
    envelope: typeof envelopes.request,
    value: unknown,
  ): [boolean, boolean] => [validate(value), envelope.safeParse(value).success];

  it('is a keyed core.workspace.write instruction', () => {
    expect(definition).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
    });
  });

  it('accepts the valid requests on the page and the Zod envelope', () => {
    for (const params of fixtures.valid)
      expect(
        both(page.request, envelopes.request, request(name, params)),
      ).toEqual([true, true]);
  });

  it('refuses the invalid requests on both', () => {
    const [first] = fixtures.valid;
    if (!first) throw new Error('no valid fixture');
    for (const [label, params] of [
      ...fixtures.invalid,
      ...commonInvalid(first),
    ])
      expect([
        label,
        ...both(page.request, envelopes.request, request(name, params)),
      ]).toEqual([label, false, false]);
  });

  it('accepts the results and refuses the others on both', () => {
    for (const result of fixtures.results)
      expect(both(page.response, envelopes.response, success(result))).toEqual([
        true,
        true,
      ]);
    for (const [label, result] of fixtures.invalidResults)
      expect([
        label,
        ...both(page.response, envelopes.response, success(result)),
      ]).toEqual([label, false, false]);
  });

  it('accepts each declared code with a keyed retry, and nothing else', () => {
    for (const code of CORE_WORKSPACE_METADATA_ERROR_CODES[name])
      for (const retry of [
        { kind: 'never' },
        { kind: 'same_idempotency_key', delayMs: 10 },
        { kind: 'after_refresh', resource: 'core.workspace.get' },
      ])
        expect(
          both(
            page.response,
            envelopes.response,
            failure({
              kind: 'failed_precondition',
              message: 'Refused.',
              code,
              details: { reason: 'r' },
              retry,
            }),
          ),
        ).toEqual([true, true]);
    for (const data of [
      {
        kind: 'failed_precondition',
        message: 'Refused.',
        code: 'core.workspace.unknownCode',
        retry: { kind: 'never' },
      },
      {
        kind: 'unavailable',
        message: 'Busy.',
        retry: { kind: 'same_request' },
      },
    ])
      expect(both(page.response, envelopes.response, failure(data))).toEqual([
        false,
        false,
      ]);
    expect(
      both(
        page.response,
        envelopes.response,
        failure({
          kind: 'failed_precondition',
          message: 'Refused.',
          retry: { kind: 'never' },
        }),
      ),
    ).toEqual([true, true]);
  });
});

describe('the W7a metadata registry', () => {
  it('is not composed into any served registry (W7a-2, W7a-3 register it)', () => {
    for (const name of operations) {
      expect(Object.hasOwn(CANOPY_INSTRUCTION_DEFINITIONS, name)).toBe(false);
      expect(Object.hasOwn(CORE_INSTRUCTION_DEFINITIONS, name)).toBe(false);
      expect(
        Object.hasOwn(CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS, name),
      ).toBe(false);
    }
  });

  it('defines exactly the six commands, each with one error enum', () => {
    expect(Object.keys(definitions).sort()).toEqual([...operations].sort());
    expect(Object.keys(CORE_WORKSPACE_METADATA_ERROR_CODES).sort()).toEqual(
      [...operations].sort(),
    );
    for (const name of operations) {
      const codes = CORE_WORKSPACE_METADATA_ERROR_CODES[name];
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes.every((code) => code.startsWith('core.workspace.'))).toBe(
        true,
      );
    }
  });

  it('takes the plan detection configuration the manifest stores', () => {
    const toStored = (
      wire: CoreWorkspacePlanDetection,
    ): WorkspacePlanDetectionConfig => wire;
    const toWire = (
      stored: WorkspacePlanDetectionConfig,
    ): CoreWorkspacePlanDetection => stored;
    const config = {
      disabledRuleIds: ['a'],
      customRules: [
        {
          id: 'b',
          label: 'b',
          kind: 'exclude' as const,
          pattern: 'drafts/**',
          enabled: false,
        },
      ],
    };
    expect(toWire(toStored(config))).toBe(config);
  });
});
