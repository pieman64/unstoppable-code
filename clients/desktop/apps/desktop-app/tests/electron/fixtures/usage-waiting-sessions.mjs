import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import {
  seedUsageLimitedChats,
  seedWorktreeChat,
  seedPipelineExecution,
} from '../seeders/index.mjs';

export const WAITING_WORKSPACE = 'demo-ts-pnpm-vite';
export const WAITING_WORKTREE = 'demo-main';
export const WAITING_EXECUTION = 'usage-waiting-pipeline';
export const WAITING_RESET = '2099-01-05T18:13:00.000Z';

export function waitingUsageScenario({ unknownReset = false } = {}) {
  return {
    authUsage: {
      codex: {
        account: {
          type: 'chatgpt',
          email: 'waiting@example.test',
          planType: 'plus',
        },
        rateLimits: [
          {
            limitId: 'codex',
            primary: {
              usedPercent: 40,
              windowDurationMins: 300,
              resetsAt: WAITING_RESET,
            },
            secondary: {
              usedPercent: 100,
              windowDurationMins: 10080,
              ...(unknownReset ? {} : { resetsAt: WAITING_RESET }),
            },
          },
        ],
      },
    },
  };
}

/** Real persisted transcripts, interruption notices and registry identities. */
export function seedWaitingSessions({ kind = 'chat' } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-usage-waiting-'),
  );
  const { workspaces } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const ids =
    kind === 'multiple'
      ? ['waiting-chat-one', 'waiting-chat-two']
      : ['waiting-chat-one'];
  const chatProject =
    kind === 'review' ? 'code-review-chat' : WAITING_WORKSPACE;
  const chatWorktree =
    kind === 'review' ? 'waiting-review-scope' : WAITING_WORKTREE;
  const entries = ids.map((chatId) => ({
    projectId: chatProject,
    worktreeId: chatWorktree,
    chatId,
    provider: 'codex',
    detectedAt: 1784808000000,
    workspaceName: 'TypeScript pnpm Vite',
    chatTitle: chatId,
    resetsAt: Date.parse(WAITING_RESET),
  }));
  seedWorktreeChat({
    userDataDir,
    workspaceId: chatProject,
    worktreeId: chatWorktree,
    providerType: 'codex',
    tabs: ids.map((id) => ({
      id,
      title: id,
      blocks: [{ type: 'text', text: `Interrupted transcript for ${id}` }],
      ...(kind === 'review'
        ? {
            messages: [
              {
                id: `${id}-user`,
                role: 'user',
                timestamp: 1784807998000,
                blocks: [{ type: 'text', text: 'Review this change.' }],
              },
              {
                id: `${id}-assistant`,
                role: 'assistant',
                timestamp: 1784808000000,
                blocks: [
                  { type: 'text', text: `Interrupted transcript for ${id}` },
                ],
              },
              {
                id: `${id}-timer`,
                role: 'assistant',
                timestamp: 1784807999000,
                blocks: [
                  {
                    type: 'turn_timer',
                    startedAt: 1784807998000,
                    completedAt: 1784808000000,
                  },
                ],
              },
            ],
          }
        : {}),
      claudeUsageLimitBanner: {
        provider: 'codex',
        message: 'Codex usage limit reached.',
        detectedAt: 1784808000000,
        requestId: `request-${id}`,
        dismissKey: `usage-limit:${id}`,
        resetsAt: Date.parse(WAITING_RESET),
      },
    })),
  });
  if (kind === 'review') {
    writeFileSync(
      path.join(
        userDataDir,
        'workspaces',
        chatProject,
        'chats',
        'registry.json',
      ),
      JSON.stringify({
        version: 1,
        targets: {
          [chatWorktree]: {
            projectId: WAITING_WORKSPACE,
            worktreeId: WAITING_WORKTREE,
          },
        },
      }),
    );
  }
  seedUsageLimitedChats({
    userDataDir,
    entries: kind === 'pipeline' ? [] : entries,
  });
  let pipeline;
  if (kind === 'pipeline' || kind === 'mixed') {
    pipeline = seedPipelineExecution({
      userDataDir,
      workspaceId: WAITING_WORKSPACE,
      worktreeId: WAITING_WORKTREE,
      execution: {
        id: WAITING_EXECUTION,
        pipelineName: 'Waiting Codex pipeline',
        status: 'paused',
        cwd: workspaces[0].worktreePath,
        stepResults: {
          'build.compile': {
            status: 'paused',
            recovery_count: 0,
            agent_recovery: {
              version: 1,
              reason_id: '123e4567-e89b-42d3-a456-426614174000',
              action: 'agent-prompt',
              provider: 'codex',
              had_agent_activity: false,
              strategy: 'restart_step',
              recovery_count: 0,
              paused_at: '2026-07-23T12:00:00.000Z',
              failure_message: 'usage exhausted',
            },
          },
        },
        stateOverrides: {
          version: 6,
          status_reasons: [
            {
              id: '123e4567-e89b-42d3-a456-426614174000',
              kind: 'provider_usage_limit',
              code: 'rate_limit',
              provider: 'codex',
              account_scope: 'native',
              detected_at: '2026-07-23T12:00:00.000Z',
              resets_at: WAITING_RESET,
              source: {
                job_id: 'build',
                step_id: 'compile',
                attempt: 0,
                iteration: 1,
              },
            },
          ],
        },
      },
    });
  }
  return { userDataDir, ids, pipeline };
}
