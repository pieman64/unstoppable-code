import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedWorktreeChat } from './index.mjs';

// Seeds a Claude chat that ran Claude Code workflows, for the Subagents panel
// and the workflow agent chat. The chat transcript holds each `Workflow` tool
// call and its launch receipt; the run files sit where the Claude CLI writes
// them, under the launch's isolated CLAUDE_CONFIG_DIR
// (`<userDataDir>/provider-state/claude`):
//
//   projects/<cwd>/<session>/subagents/workflows/<runId>/journal.jsonl
//   projects/<cwd>/<session>/subagents/workflows/<runId>/agent-<id>.jsonl
//   projects/<cwd>/<session>/subagents/workflows/<runId>/agent-<id>.meta.json
//   projects/<cwd>/<session>/workflows/<runId>.json   (finished runs only)
//
// The finished run has two failed agents and a final run state. The running
// run has only its journal and agent files, written now so they count as
// recent activity; its last agent has started and not finished.

export const SUBAGENT_VIEWER_WORKFLOW_CHAT_ID = 'subagent-viewer-workflow-chat';
export const SUBAGENT_VIEWER_WORKFLOW_CHAT_TITLE = 'Plan the billing migration';
const SESSION_ID = 'e1572d83-98fd-4b83-8000-00000000wf01';
const PROJECT_DIR_NAME = '-demo-ts-pnpm-vite-demo-main';
const BASE_TIME = 1788825600000;
const MINUTE = 60_000;

export const SUBAGENT_VIEWER_WORKFLOW_RUNS = {
  finished: {
    runId: 'wf_77c0e4d1-5a2',
    taskId: 'w7c695vzr',
    toolUseId: 'toolu_workflow_finished',
    name: 'billing-plan-write',
    summary: 'Write the billing migration plan, then verify it.',
    phases: ['Write', 'Register', 'Verify', 'Consistency'],
  },
  running: {
    runId: 'wf_ea5d2b77-e9f',
    taskId: 'wd4e5xlqr',
    toolUseId: 'toolu_workflow_running',
    name: 'billing-plan-finish',
    summary: 'Finish the register and re-verify the plan.',
    phases: ['Register', 'Verify', 'Consistency'],
  },
};

/** Agents of the finished run: [agentId, label, phase, state]. */
export const SUBAGENT_VIEWER_WORKFLOW_FINISHED_AGENTS = [
  ['b770100000000001', 'write:01-current-state.md', 'Write', 'done'],
  ['b770100000000002', 'write:02-target-ledger.md', 'Write', 'done'],
  ['b770100000000003', 'write:03-webhook-cutover.md', 'Write', 'error'],
  ['b770100000000004', 'write:04-rollback.md', 'Write', 'done'],
  ['b770100000000005', 'write:decisions-and-risks.md', 'Register', 'done'],
  ['b770100000000006', 'write:SOURCES.md', 'Register', 'done'],
  ['b770100000000007', 'verify:r1-state-and-target', 'Verify', 'done'],
  ['b770100000000008', 'verify:r2-cutover-and-rollback', 'Verify', 'error'],
  ['b770100000000009', 'consistency', 'Consistency', 'done'],
];

/** Agents of the running run: [agentId, label, phase, state]. */
export const SUBAGENT_VIEWER_WORKFLOW_RUNNING_AGENTS = [
  ['c9e0100000000001', 'write:decisions-and-risks.md', 'Register', 'done'],
  ['c9e0100000000002', 'write:SOURCES.md', 'Register', 'done'],
  ['c9e0100000000003', 'verify:r1-state-and-target', 'Verify', 'done'],
  ['c9e0100000000004', 'verify:r2-ledger-and-webhooks', 'Verify', 'done'],
  ['c9e0100000000005', 'verify:r3-cutover-and-rollback', 'Verify', 'done'],
  ['c9e0100000000006', 'verify:r4-sequencing', 'Verify', 'done'],
  ['c9e0100000000007', 'consistency', 'Consistency', 'running'],
];

/** The agent every flow opens: a finished fact-checker in the running run. */
export const SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT = {
  runId: SUBAGENT_VIEWER_WORKFLOW_RUNS.running.runId,
  agentId: 'c9e0100000000005',
  label: 'verify:r3-cutover-and-rollback',
  phase: 'Verify',
  task: 'Fact-check 03-webhook-cutover.md and 04-rollback.md against the research findings.',
  result:
    'Both chapters hold up against the findings, with one correction to the dual-write retention.',
};

const SESSION_ERROR = 'Session limit reached';

function claudeConfigDir(userDataDir) {
  return path.join(userDataDir, 'provider-state', 'claude');
}

function sessionDir(userDataDir) {
  return path.join(
    claudeConfigDir(userDataDir),
    'projects',
    PROJECT_DIR_NAME,
    SESSION_ID,
  );
}

/** Absolute transcript dir of a seeded run, as its launch receipt names it. */
export function subagentViewerWorkflowTranscriptDir(userDataDir, runId) {
  return path.join(sessionDir(userDataDir), 'subagents', 'workflows', runId);
}

function writeLines(filePath, rows) {
  writeFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

function taskText(label) {
  if (label === SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.label) {
    return SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.task;
  }
  return `Complete ${label} for the billing migration plan.`;
}

function resultText(label) {
  if (label === SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.label) {
    return SUBAGENT_VIEWER_WORKFLOW_OPEN_AGENT.result;
  }
  return `${label} is complete.`;
}

/** A small Claude sidechain transcript for one workflow agent. */
function agentTranscriptRows({ agentId, label, state, startedAt, cwd }) {
  const common = {
    isSidechain: true,
    agentId,
    sessionId: SESSION_ID,
    userType: 'external',
    entrypoint: 'sdk-ts',
    cwd,
    version: '2.1.293',
    gitBranch: 'main',
  };
  const iso = (offset) => new Date(startedAt + offset).toISOString();
  const rows = [
    {
      ...common,
      parentUuid: null,
      type: 'user',
      uuid: `${agentId}-u1`,
      timestamp: iso(0),
      message: { role: 'user', content: taskText(label) },
    },
    {
      ...common,
      parentUuid: `${agentId}-u1`,
      type: 'assistant',
      uuid: `${agentId}-a1`,
      timestamp: iso(1000),
      message: {
        id: `${agentId}-m1`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'text',
            text: 'I will read the chapter, then check it against the findings.',
          },
          {
            type: 'tool_use',
            id: `${agentId}-read`,
            name: 'Read',
            input: { file_path: 'README.md' },
          },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      ...common,
      parentUuid: `${agentId}-a1`,
      type: 'user',
      uuid: `${agentId}-u2`,
      timestamp: iso(2000),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `${agentId}-read`,
            content: '# Demo',
          },
        ],
      },
    },
  ];
  if (state !== 'running') {
    rows.push({
      ...common,
      parentUuid: `${agentId}-u2`,
      type: 'assistant',
      uuid: `${agentId}-a2`,
      timestamp: iso(3000),
      message: {
        id: `${agentId}-m2`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'text',
            text: state === 'error' ? SESSION_ERROR : resultText(label),
          },
        ],
        stop_reason: 'end_turn',
      },
    });
  }
  return rows;
}

function writeRunFiles({ userDataDir, run, agents, startedAt, finished, cwd }) {
  const transcriptDir = subagentViewerWorkflowTranscriptDir(
    userDataDir,
    run.runId,
  );
  mkdirSync(transcriptDir, { recursive: true });
  const journal = [{ type: 'launched' }];
  const progress = run.phases.map((title, index) => ({
    type: 'workflow_phase',
    index: index + 1,
    title,
  }));
  agents.forEach(([agentId, label, phase, state], index) => {
    const agentStartedAt = startedAt + index * MINUTE;
    const key = `v2:${run.runId}:${agentId}`;
    journal.push({ type: 'started', key, agentId, label, phase });
    if (state === 'done') {
      journal.push({
        type: 'result',
        key,
        agentId,
        result: { summary: resultText(label) },
      });
    } else if (state === 'error') {
      journal.push({ type: 'failed', key, agentId });
    }
    writeFileSync(
      path.join(transcriptDir, `agent-${agentId}.meta.json`),
      JSON.stringify({
        agentType: 'workflow-subagent',
        description: label,
        workflowPhase: phase,
        spawnDepth: 1,
        requestShape: 'foreground',
        requestNonInteractive: true,
      }),
    );
    writeLines(
      path.join(transcriptDir, `agent-${agentId}.jsonl`),
      agentTranscriptRows({
        agentId,
        label,
        state,
        startedAt: agentStartedAt,
        cwd,
      }),
    );
    progress.push({
      type: 'workflow_agent',
      index: index + 1,
      label,
      phaseIndex: run.phases.indexOf(phase) + 1,
      phaseTitle: phase,
      agentId,
      model: 'claude-opus-5-5',
      state,
      startedAt: agentStartedAt,
      queuedAt: agentStartedAt,
      attempt: 1,
      promptPreview: taskText(label),
      promptFramed: true,
      lastProgressAt: agentStartedAt + 3000,
      tokens: 120_000 + index * 10_000,
      toolCalls: 20 + index,
      durationMs: 3 * MINUTE,
      ...(state === 'error'
        ? { error: SESSION_ERROR }
        : { resultPreview: resultText(label) }),
    });
  });
  writeLines(path.join(transcriptDir, 'journal.jsonl'), journal);
  if (finished) {
    const workflowsDir = path.join(sessionDir(userDataDir), 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      path.join(workflowsDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        timestamp: new Date(startedAt + agents.length * MINUTE).toISOString(),
        taskId: run.taskId,
        script: `export const meta = { name: '${run.name}' }`,
        scriptPath: path.join(workflowsDir, 'scripts', `${run.name}.js`),
        args: {},
        result: { written: agents.length },
        agentCount: agents.length,
        logs: [],
        durationMs: agents.length * MINUTE + 2 * MINUTE,
        summary: run.summary,
        workflowName: run.name,
        status: 'completed',
        startTime: startedAt,
        phases: run.phases.map((title) => ({ title })),
        defaultModel: 'claude-opus-5-5',
        workflowProgress: progress,
        totalTokens: progress.reduce(
          (sum, entry) => sum + (entry.tokens ?? 0),
          0,
        ),
        totalToolCalls: progress.reduce(
          (sum, entry) => sum + (entry.toolCalls ?? 0),
          0,
        ),
      }),
    );
  }
  return transcriptDir;
}

function receiptText(run, transcriptDir) {
  const scriptFile = path.join(
    path.dirname(path.dirname(path.dirname(transcriptDir))),
    'workflows',
    'scripts',
    `${run.name}-${run.runId}.js`,
  );
  return [
    `Workflow launched in background. Task ID: ${run.taskId}`,
    `Summary: ${run.summary}`,
    `Transcript dir: ${transcriptDir}`,
    `Script file: ${scriptFile}`,
    `Run ID: ${run.runId}`,
  ].join('\n');
}

function workflowMessages(run, transcriptDir, timestamp) {
  return [
    {
      id: `${run.toolUseId}-dispatch`,
      role: 'assistant',
      timestamp,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: run.toolUseId,
          toolName: 'Workflow',
          input: JSON.stringify({
            script: `export const meta = {\n  name: '${run.name}',\n  description: '${run.summary}',\n}\n`,
          }),
        },
      ],
    },
    {
      id: `${run.toolUseId}-receipt`,
      role: 'assistant',
      timestamp: timestamp + 10,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: run.toolUseId,
          toolName: 'Workflow',
          output: receiptText(run, transcriptDir),
          isError: false,
        },
      ],
    },
  ];
}

/**
 * Write the Claude workflow run files and return the chat tab that launched
 * them, for callers that seed several chats at once.
 *
 * @param {object} options
 * @param {string} options.userDataDir isolated CANOPY_DATA_DIR
 * @param {string} [options.cwd] worktree path written into agent transcripts
 * @param {number} [options.now] wall clock for the running run
 */
export function subagentViewerWorkflowTab(options) {
  const {
    userDataDir,
    cwd = '/tmp/demo-ts-pnpm-vite',
    now = Date.now(),
  } = options ?? {};
  if (!userDataDir) {
    throw new Error('subagentViewerWorkflowTab requires userDataDir');
  }
  const finishedDir = writeRunFiles({
    userDataDir,
    run: SUBAGENT_VIEWER_WORKFLOW_RUNS.finished,
    agents: SUBAGENT_VIEWER_WORKFLOW_FINISHED_AGENTS,
    startedAt: BASE_TIME,
    finished: true,
    cwd,
  });
  const runningStartedAt =
    now - SUBAGENT_VIEWER_WORKFLOW_RUNNING_AGENTS.length * MINUTE;
  const runningDir = writeRunFiles({
    userDataDir,
    run: SUBAGENT_VIEWER_WORKFLOW_RUNS.running,
    agents: SUBAGENT_VIEWER_WORKFLOW_RUNNING_AGENTS,
    startedAt: runningStartedAt,
    finished: false,
    cwd,
  });
  return {
    id: SUBAGENT_VIEWER_WORKFLOW_CHAT_ID,
    title: SUBAGENT_VIEWER_WORKFLOW_CHAT_TITLE,
    providerType: 'claude',
    executionHarness: 'claude',
    model: 'opus',
    sdkSessionId: SESSION_ID,
    messages: [
      {
        id: 'workflow-request',
        role: 'user',
        timestamp: BASE_TIME - 1000,
        blocks: [
          {
            type: 'text',
            text: 'Write the billing migration plan with a workflow.',
          },
        ],
      },
      ...workflowMessages(
        SUBAGENT_VIEWER_WORKFLOW_RUNS.finished,
        finishedDir,
        BASE_TIME - 500,
      ),
      ...workflowMessages(
        SUBAGENT_VIEWER_WORKFLOW_RUNS.running,
        runningDir,
        BASE_TIME + 30 * MINUTE,
      ),
      {
        id: 'workflow-answer',
        role: 'assistant',
        timestamp: BASE_TIME + 30 * MINUTE + 100,
        blocks: [
          {
            type: 'text',
            text: 'The finishing workflow is running in the background.',
          },
        ],
      },
      {
        id: 'workflow-turn-timer',
        role: 'system',
        timestamp: BASE_TIME + 30 * MINUTE + 200,
        blocks: [
          {
            type: 'turn_timer',
            startedAt: BASE_TIME - 1000,
            completedAt: BASE_TIME + 30 * MINUTE + 200,
          },
        ],
      },
    ],
  };
}

/**
 * Seed a Claude chat with one finished and one running workflow run. Callers
 * seed the demo worktree first. This rewrites the worktree's chats file.
 *
 * @param {object} options
 * @param {string} options.userDataDir isolated CANOPY_DATA_DIR
 * @param {string} [options.workspaceId] seeded workspace id
 * @param {string} [options.worktreeId] seeded worktree id
 * @param {string} [options.cwd] worktree path written into agent transcripts
 * @param {number} [options.now] wall clock for the running run
 * @returns {ReturnType<typeof seedWorktreeChat> & {chatId: string}}
 */
export function seedSubagentViewerWorkflowChat(options) {
  const {
    userDataDir,
    workspaceId = 'demo-ts-pnpm-vite',
    worktreeId = 'demo-main',
  } = options ?? {};
  const tab = subagentViewerWorkflowTab(options);
  const seeded = seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    providerType: 'claude',
    activeTabId: tab.id,
    tabs: [tab],
  });
  return { ...seeded, chatId: tab.id };
}
