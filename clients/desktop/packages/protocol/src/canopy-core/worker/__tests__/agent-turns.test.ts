import {
  WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES,
  WorkerAgentSubagentRunParamsSchema,
  WorkerAgentSubagentRunResultSchema,
  WorkerAgentTurnEventSchema,
  WorkerAgentTurnRunParamsSchema,
  WorkerAgentTurnRunResultSchema,
} from '../agent-turns';

const turnParams = {
  turnRunId: 'run',
  scope: { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' },
  turnId: 'message',
  eventNamespace: 'initial',
  providerId: 'claude',
  model: null,
  materializationId: null,
};
const subagentParams = {
  subagentRunId: 'sub',
  delegationId: 'delegation',
  runGeneration: 1,
  harnessId: 'local-delegation-claude-v1',
  scope: { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' },
};
const base = { turnRunId: 'run', sequence: 0 };

it('every envelope kind round-trips; unknown kinds and oversize payloads are refused', () => {
  const fixtures = [
    { ...base, kind: 'accepted' },
    {
      ...base,
      kind: 'transcript',
      format: 'canopy.chat-event.v1',
      terminal: false,
      payload: { type: 'assistant', message: { content: [] } },
    },
    { ...base, kind: 'wait_opened', waitId: 'w', waitKind: 'approval' },
    { ...base, kind: 'wait_resolved', waitId: 'w', resolution: 'answered' },
    { ...base, kind: 'terminal', outcome: 'completed' },
  ];
  for (const fixture of fixtures)
    expect(WorkerAgentTurnEventSchema.parse(fixture)).toEqual(fixture);
  expect(
    WorkerAgentTurnEventSchema.safeParse({ ...base, kind: 'progress' }).success,
  ).toBe(false);
  const transcript = {
    ...base,
    kind: 'transcript',
    format: 'canopy.chat-event.v1',
    terminal: false,
  };
  // `"` + text + `"` serializes to exactly one byte over the bound.
  const oversize = 'x'.repeat(WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES - 1);
  expect(
    WorkerAgentTurnEventSchema.safeParse({ ...transcript, payload: oversize })
      .success,
  ).toBe(false);
  expect(
    WorkerAgentTurnEventSchema.safeParse({
      ...transcript,
      payload: oversize.slice(1),
    }).success,
  ).toBe(true);
  expect(
    WorkerAgentTurnEventSchema.safeParse({
      ...transcript,
      payload: { run: () => undefined },
    }).success,
  ).toBe(false);
});

it('turn and subagent params are strict', () => {
  expect(WorkerAgentTurnRunParamsSchema.safeParse(turnParams).success).toBe(
    true,
  );
  expect(
    WorkerAgentTurnRunParamsSchema.safeParse({ ...turnParams, prompt: 'x' })
      .success,
  ).toBe(false);
  const withoutMaterialization: Record<string, unknown> = { ...turnParams };
  delete withoutMaterialization.materializationId;
  expect(
    WorkerAgentTurnRunParamsSchema.safeParse(withoutMaterialization).success,
  ).toBe(false);
  expect(
    WorkerAgentSubagentRunParamsSchema.safeParse(subagentParams).success,
  ).toBe(true);
  expect(
    WorkerAgentSubagentRunParamsSchema.safeParse({
      ...subagentParams,
      repoPath: '/tmp/x',
    }).success,
  ).toBe(false);
});

it('results discriminate on status', () => {
  const error = {
    code: 'worker.agent.turnFailed',
    message: 'The chat turn ended with an error.',
  };
  const turn = { turnRunId: 'run', eventCount: 2 };
  expect(
    WorkerAgentTurnRunResultSchema.safeParse({ ...turn, status: 'failed' })
      .success,
  ).toBe(false);
  expect(
    WorkerAgentTurnRunResultSchema.safeParse({
      ...turn,
      status: 'failed',
      error,
    }).success,
  ).toBe(true);
  expect(
    WorkerAgentTurnRunResultSchema.safeParse({
      ...turn,
      status: 'cancelled',
      error,
    }).success,
  ).toBe(false);
  expect(
    WorkerAgentSubagentRunResultSchema.safeParse({
      subagentRunId: 'sub',
      status: 'failed',
    }).success,
  ).toBe(false);
  expect(
    WorkerAgentSubagentRunResultSchema.safeParse({
      subagentRunId: 'sub',
      status: 'cancelled',
      error: {
        code: 'worker.agent.subagentFailed',
        message: 'The subagent run ended with an error.',
      },
    }).success,
  ).toBe(false);
});
