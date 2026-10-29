import { extractProposedPlan as sharedExtractProposedPlan } from '../../../codex-plan-mode';
import { cursorCanopyMcpServerNames } from '../../../lib/cursor-mcp-tool-call';
import type { PermissionPreset } from '../../../builtin-actions/agent-prompt/logic';
import {
  createHeadlessCursorHost,
  extractProposedPlan,
  headlessCursorDecision,
  headlessCursorMcpDecision,
} from '../headless-policy';

const payload = (tool: string, input: Record<string, unknown>): unknown => ({
  hook_event_name: 'preToolUse',
  tool_name: tool,
  tool_input: input,
  tool_use_id: 'id',
});

describe('headlessCursorDecision', () => {
  const read = payload('Read', { file_path: '/w/a' });
  const write = payload('Write', { file_path: '/w/a', content: 'x' });
  const shell = payload('Shell', { command: 'ls', cwd: '/w' });
  const mcp = payload('MCP:GetGitPreferences', { type: 'branch-name' });

  it.each([
    ['dangerous_all', read, 'allow'],
    ['dangerous_all', write, 'allow'],
    ['dangerous_all', shell, 'allow'],
    ['dangerous_all', mcp, 'deny'],
    ['read_only', read, 'allow'],
    ['read_only', write, 'deny'],
    ['read_only', shell, 'deny'],
    ['read_only', mcp, 'deny'],
    ['plan', read, 'allow'],
    ['plan', write, 'deny'],
    ['plan', shell, 'deny'],
    ['plan', mcp, 'deny'],
    ['none', read, 'deny'],
    ['none', write, 'deny'],
    ['none', shell, 'deny'],
    ['none', mcp, 'deny'],
  ] as const)('%s preset: %j → %s', (preset, input, decision) => {
    expect(headlessCursorDecision(preset, input).decision).toBe(decision);
  });

  it('fails closed on unknown tools and malformed payloads', () => {
    expect(
      headlessCursorDecision('dangerous_all', payload('Task', {})).decision,
    ).toBe('deny');
    expect(headlessCursorDecision('dangerous_all', null).decision).toBe('deny');
    expect(
      headlessCursorDecision(
        'dangerous_all',
        payload('Write', { file_path: 'relative' }),
      ).decision,
    ).toBe('deny');
  });

  it.each(['none', 'read_only', 'plan', 'dangerous_all'] as const)(
    'gates native network tools with the %s preset',
    (preset) => {
      for (const [tool, input] of [
        ['Fetch', { url: 'https://example.com' }],
        ['WebFetch', { url: 'https://example.com' }],
        ['WebSearch', { search_term: 'docs' }],
      ] as const)
        expect(
          headlessCursorDecision(preset, payload(tool, input)).decision,
        ).toBe(
          preset === 'dangerous_all' || preset === 'plan' ? 'allow' : 'deny',
        );
    },
  );

  it.each(['none', 'read_only', 'plan', 'dangerous_all'] as const)(
    'supports native file searches and diagnostics under %s',
    (preset) => {
      for (const [tool, input] of [
        ['Grep', { pattern: 'needle', file_path: '/w' }],
        ['Glob', { glob_pattern: '**/*.ts', target_directory: '/w' }],
        ['List', { file_path: '/w' }],
        ['ReadLints', { file_path: '/w/a.ts' }],
      ] as const) {
        expect(
          headlessCursorDecision(preset, payload(tool, input)).decision,
        ).toBe(preset === 'none' ? 'deny' : 'allow');
      }
      expect(
        headlessCursorDecision(
          preset,
          payload('Delete', { file_path: '/w/a.ts' }),
        ).decision,
      ).toBe(preset === 'dangerous_all' ? 'allow' : 'deny');
    },
  );

  it.each(['none', 'read_only', 'plan', 'dangerous_all'] as const)(
    'denies malformed native search and fetch inputs under the %s preset',
    (preset) => {
      for (const tool of ['Grep', 'Glob', 'WebFetch', 'WebSearch'])
        expect(
          headlessCursorDecision(preset, payload(tool, { query: 123 }))
            .decision,
        ).toBe('deny');
    },
  );

  it('refuses MCP at the hook because headless steps are given no MCP servers', () => {
    // The hook payload names only the tool, not its server, and a headless
    // step supplies no servers, so any MCP call reaching the hook came from a
    // server the runtime found on its own. The ACP permission request cannot
    // be relied on as the gate: the pinned CLI can run an MCP tool without
    // sending one.
    for (const preset of ['dangerous_all', 'read_only', 'plan'] as const) {
      const decision = headlessCursorDecision(preset, mcp);
      expect(decision).toEqual({
        decision: 'deny',
        message: 'MCP tools are not available on Cursor steps yet.',
      });
    }
  });

  it('carries an agent_message on every denial', () => {
    expect(headlessCursorDecision('read_only', write).message).toMatch(
      /read-only/i,
    );
  });

  it('rejects an unrecognized preset instead of silently behaving as read-only', () => {
    // The exhaustive preset switch inside headlessCursorDecision must reject
    // any PermissionPreset value it does not explicitly handle, so a future
    // preset added to the union is a compile error there (a `never` check)
    // rather than silently falling through to the Write/Shell "not
    // dangerous_all" branch and behaving like read_only.

    // Parsed, as a preset really arrives from pipeline YAML: an out-of-type
    // value is the point of this test.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const invalidPreset: PermissionPreset = JSON.parse('"not-a-real-preset"');
    expect(() => headlessCursorDecision(invalidPreset, write)).toThrow(
      /unhandled.*permission preset/i,
    );
  });
});

describe('headlessCursorMcpDecision', () => {
  const main = cursorCanopyMcpServerNames().main;
  it('allows only read-only app tools below dangerous_all', () => {
    expect(
      headlessCursorMcpDecision('read_only', {
        server: main,
        tool: 'SearchMemory',
        args: {},
      }).decision,
    ).toBe('allow');
    expect(
      headlessCursorMcpDecision('read_only', {
        server: main,
        tool: 'SaveMemory',
        args: {},
      }).decision,
    ).toBe('deny');
    expect(
      headlessCursorMcpDecision('dangerous_all', {
        server: main,
        tool: 'SaveMemory',
        args: {},
      }).decision,
    ).toBe('allow');
    expect(
      headlessCursorMcpDecision('none', {
        server: main,
        tool: 'SearchMemory',
        args: {},
      }).decision,
    ).toBe('deny');
  });
  it('denies servers that are not the app servers', () => {
    expect(
      headlessCursorMcpDecision('dangerous_all', {
        server: 'plugin',
        tool: 'echo',
        args: {},
      }).decision,
    ).toBe('deny');
  });
});

describe('extractProposedPlan', () => {
  it('returns the inner text of the first proposed_plan block', () => {
    expect(
      extractProposedPlan('x <proposed_plan>\nA\n</proposed_plan> y'),
    ).toBe('A');
    expect(extractProposedPlan('no plan')).toBeUndefined();
  });

  it('agrees with every other provider on multiple blocks, casing and empties', () => {
    // These three were exactly where the Cursor-local copy diverged from the
    // established helper, and a `plan_ready` run consumes the result durably.
    expect(
      extractProposedPlan(
        '<proposed_plan>FIRST</proposed_plan> then <proposed_plan>SECOND</proposed_plan>',
      ),
    ).toBe('FIRST');
    expect(extractProposedPlan('<PROPOSED_PLAN>SHOUTED</PROPOSED_PLAN>')).toBe(
      'SHOUTED',
    );
    expect(
      extractProposedPlan('<proposed_plan>   </proposed_plan>'),
    ).toBeUndefined();
    expect(extractProposedPlan(undefined)).toBeUndefined();
    // Identical to what Codex and Claude get from the same text.
    for (const text of [
      '<proposed_plan>FIRST</proposed_plan><proposed_plan>SECOND</proposed_plan>',
      '<PROPOSED_PLAN>SHOUTED</PROPOSED_PLAN>',
      '<proposed_plan>   </proposed_plan>',
      'no plan at all',
    ])
      expect(extractProposedPlan(text)).toBe(sharedExtractProposedPlan(text));
  });
});

describe('createHeadlessCursorHost', () => {
  it('prepends plan steering for the plan preset and includes the plugin warning', async () => {
    const host = createHeadlessCursorHost({
      preset: 'plan',
      instructions: 'Do the task.',
      clientName: 'test',
      emit: () => {},
      pluginWarning: 'Plugins are not available on Cursor steps.',
    });
    const prepared = await host.beforePrompt({
      sessionId: 's',
      contextLost: false,
      mcp: {
        servers: [],
        notes: [],
        notices: [],
        appToolsAvailable: false,
        pluginServerNames: [],
      },
      announce: () => {},
    });
    expect(prepared.instructions).toContain('Read-only plan mode');
    expect(prepared.instructions).toContain('<proposed_plan>');
    expect(prepared.instructions).toContain('Do the task.');
    expect(host.planMode).toBe(true);
  });

  it('announces a notice when the turn driver reports the saved session could not be restored', async () => {
    const host = createHeadlessCursorHost({
      preset: 'read_only',
      instructions: 'Do the task.',
      clientName: 'test',
      emit: () => {},
    });
    const announced: string[] = [];
    await host.beforePrompt({
      sessionId: 's',
      contextLost: true,
      mcp: {
        servers: [],
        notes: [],
        notices: [],
        appToolsAvailable: false,
        pluginServerNames: [],
      },
      announce: (text) => announced.push(text),
    });
    expect(
      announced.some((text) => text.toLowerCase().includes('could not')),
    ).toBe(true);
  });

  it('does not announce a context-loss notice when the session loaded normally', async () => {
    const host = createHeadlessCursorHost({
      preset: 'read_only',
      instructions: 'Do the task.',
      clientName: 'test',
      emit: () => {},
    });
    const announced: string[] = [];
    await host.beforePrompt({
      sessionId: 's',
      contextLost: false,
      mcp: {
        servers: [],
        notes: [],
        notices: [],
        appToolsAvailable: false,
        pluginServerNames: [],
      },
      announce: (text) => announced.push(text),
    });
    expect(announced).toEqual([]);
  });
});

it('denies a preToolUse payload whose tool_use_id exceeds the interactive bound', () => {
  // The headless path omitted the interactive path's
  // 4096-character bound, and these ids are retained in the turn's integrity
  // anchor set for the whole turn.
  const readWithId = (id: string): unknown => ({
    hook_event_name: 'preToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/w/a' },
    tool_use_id: id,
  });
  expect(
    headlessCursorDecision('read_only', readWithId('x'.repeat(4097))),
  ).toMatchObject({
    decision: 'deny',
  });
  expect(
    headlessCursorDecision('read_only', readWithId('x'.repeat(4096))),
  ).toMatchObject({
    decision: 'allow',
  });
});
