import {
  SkillSuggestionTurnRecorder,
  toolEntriesFromEvent,
  type RecordedTurn,
  type TurnRecorderBeginOptions,
} from '../turn-recorder';

jest.mock('../feature-gate', () => ({
  isSkillSuggestionsEnabled: (): boolean => true,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const KEY = 'chat:p/w/c';
const options: TurnRecorderBeginOptions = {
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
  userMessageId: 'msg-1',
  originalUserText: '/review check the release branch carefully',
  skillSuggestionEligible: true,
};

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function recorderWith(enabled = true): {
  recorder: SkillSuggestionTurnRecorder;
  turns: RecordedTurn[];
} {
  const turns: RecordedTurn[] = [];
  const recorder = new SkillSuggestionTurnRecorder(
    () => enabled,
    () => 1000,
  );
  recorder.setSink((turn) => {
    turns.push(turn);
  });
  return { recorder, turns };
}

describe('skill suggestion turn recorder', () => {
  it('records the leading skill and Claude tools, skipping subagent calls', async () => {
    const { recorder, turns } = recorderWith();
    recorder.begin(KEY, 'audit-1', options);
    recorder.observe(KEY, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', name: 'Read', input: {} },
          { type: 'tool_use', name: 'Task', input: {} },
          { type: 'tool_use', name: 'Skill', input: { skill: 'push-branch' } },
          { type: 'tool_use', name: 'mcp__linear__get_issue', input: {} },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    });
    recorder.observe(KEY, {
      type: 'assistant',
      parent_tool_use_id: 'tool-1',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    });
    recorder.complete(KEY, 'audit-1', 'success');
    await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      userMessageId: 'msg-1',
      auditEntryId: 'audit-1',
      status: 'success',
      tools: ['skill:review', 'Read', 'skill:push-branch', 'mcp:linear'],
    });
  });

  it('maps Codex MCP items and skips spawned agents', () => {
    expect(
      toolEntriesFromEvent({
        type: 'codex',
        event: {
          type: 'item.started',
          item: { type: 'mcp_tool_call', server: 'github', tool: 'x' },
        },
      }),
    ).toEqual(['mcp:github']);
    expect(
      toolEntriesFromEvent({
        type: 'codex',
        event: {
          type: 'item.started',
          item: { type: 'collab_agent_tool_call', tool: 'spawnAgent' },
        },
      }),
    ).toEqual([]);
    expect(
      toolEntriesFromEvent({
        type: 'codex',
        event: { type: 'item.completed', item: { type: 'mcp_tool_call' } },
      }),
    ).toEqual([]);
  });

  it('ignores unknown provider event shapes', () => {
    expect(toolEntriesFromEvent({ type: 'canopy_assistant_patch' })).toEqual(
      [],
    );
    expect(toolEntriesFromEvent({ type: 'tool_use', name: 'Bash' })).toEqual(
      [],
    );
  });

  it('requires explicit eligibility and skips assistant and terminal chats', async () => {
    const { recorder, turns } = recorderWith();
    const cases: TurnRecorderBeginOptions[] = [
      { ...options, skillSuggestionEligible: undefined },
      { ...options, skillSuggestionEligible: false },
      { ...options, assistantMode: 'app-advisor' },
      { ...options, chatMode: 'terminal' },
      { ...options, userMessageId: undefined },
    ];
    for (const entry of cases) {
      recorder.begin(KEY, 'audit-1', entry);
      expect(recorder.hasOpenTurn(KEY)).toBe(false);
      recorder.complete(KEY, 'audit-1', 'success');
    }
    await flush();
    expect(turns).toEqual([]);
  });

  it('records nothing while the gate is closed', async () => {
    const { recorder, turns } = recorderWith(false);
    recorder.begin(KEY, 'audit-1', options);
    recorder.complete(KEY, 'audit-1', 'success');
    await flush();
    expect(turns).toEqual([]);
  });

  it('treats observe and complete without an open turn as no-ops', async () => {
    const { recorder, turns } = recorderWith();
    const data = {
      get type(): string {
        throw new Error('observe must not read the event without a turn');
      },
    };
    expect(() => recorder.observe(KEY, data)).not.toThrow();
    recorder.complete('chat:unknown', 'audit-x', 'success');
    recorder.begin(KEY, 'audit-1', options);
    recorder.complete(KEY, 'audit-other', 'success');
    await flush();
    expect(turns).toEqual([]);
  });

  it('isolates exceptions from the observability service', async () => {
    const recorder = new SkillSuggestionTurnRecorder(() => true);
    recorder.setSink(() => {
      throw new Error('sink failed');
    });
    recorder.begin(KEY, 'audit-1', options);
    const explosive = {
      type: 'assistant',
      get message(): unknown {
        throw new Error('bad event');
      },
    };
    expect(() => recorder.observe(KEY, explosive)).not.toThrow();
    expect(() => recorder.complete(KEY, 'audit-1', 'success')).not.toThrow();
    await flush();
  });

  it('drops open turns when the gate closes', async () => {
    const { recorder, turns } = recorderWith();
    recorder.begin(KEY, 'audit-1', options);
    recorder.dropOpenTurns();
    recorder.complete(KEY, 'audit-1', 'success');
    await flush();
    expect(turns).toEqual([]);
  });
});
