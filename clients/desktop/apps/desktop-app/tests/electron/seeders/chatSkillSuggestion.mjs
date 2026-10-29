import { readFileSync } from 'node:fs';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedPreferences } from '../codexPipelineRuntime.mjs';
import { seedWorktreeChat, writeJson } from './index.mjs';

export const SUGGESTION_WORKSPACE = 'demo-ts-pnpm-vite';
export const SUGGESTION_WORKTREE = 'demo-main';
export const SUGGESTION_CHAT = 'skill-suggestion-chat';
export const SUGGESTION_ID = 'sug-release-review';
export const SECOND_SUGGESTION_ID = 'sug-standup-notes';
/** Normalizes to the seeded member tokens, so a live turn matches. */
export const MATCHING_PROMPT =
  'Summarize the open review comments on the release checklist';
export const NON_MATCHING_PROMPT = 'What time is it in Tokyo right now';

function suggestion(id, overrides = {}) {
  const now = Date.now();
  return {
    id,
    kind: 'prompt',
    state: 'confirmed',
    partition: 'personal',
    title: 'Summarize release review comments',
    summary: 'Collects open review comments on the release checklist.',
    proposedSkillName: 'release-review-summary',
    proposedDescription: 'Summarize open review comments for a release.',
    parameters: ['release'],
    chainSkills: [],
    exemplars: ['summarize the open review comments on the release checklist'],
    members: [
      {
        tokens: [
          'checklist',
          'comments',
          'open',
          'release',
          'review',
          'summarize',
        ],
        tools: [],
      },
    ],
    matchedTurnIds: [`${id}:a`, `${id}:b`, `${id}:c`],
    showCount: 0,
    createdAt: now - 86_400_000,
    lastMatchedAt: now - 3_600_000,
    ...overrides,
  };
}

/**
 * A confirmed repeat-task suggestion (CAN-385) with backfill finished, so no
 * scan runs and the next matching turn surfaces the banner.
 */
export function seedChatSkillSuggestion(userDataDir, { second = false } = {}) {
  seedPreferences(userDataDir);
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  writeJson(path.join(userDataDir, 'skill-suggestions.json'), {
    version: 1,
    suggestions: [
      suggestion(SUGGESTION_ID),
      ...(second
        ? [
            suggestion(SECOND_SUGGESTION_ID, {
              title: 'Draft standup notes',
              summary: 'Turns yesterday’s merged work into standup notes.',
              proposedSkillName: 'standup-notes',
              members: [{ tokens: ['draft', 'notes', 'standup'], tools: [] }],
              exemplars: [],
            }),
          ]
        : []),
    ],
    lastBannerShownAt: null,
    lastScanAt: {},
    consecutiveBannerDismissals: 0,
    bannerPausedUntil: null,
    backfill: { done: true, nextChatIndex: 0 },
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: SUGGESTION_WORKSPACE,
    worktreeId: SUGGESTION_WORKTREE,
    providerType: 'codex',
    tabs: [{ id: SUGGESTION_CHAT, title: 'Release review', messages: [] }],
  });
}

/** The stored state of one seeded suggestion. */
export function readSeededSuggestion(userDataDir, id = SUGGESTION_ID) {
  const file = JSON.parse(
    readFileSync(path.join(userDataDir, 'skill-suggestions.json'), 'utf8'),
  );
  return file.suggestions.find((entry) => entry.id === id);
}
