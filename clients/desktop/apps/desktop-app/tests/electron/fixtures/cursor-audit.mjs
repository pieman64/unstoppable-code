import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedUsageEvents } from '../seeders/index.mjs';
import { seedGlobalInstructionsPreferences } from '../seeders/seedGlobalInstructionsPreferences.mjs';

/** Persisted Cursor turn with org memory and one usage event; no network. */
export function seedCursorAudit(userDataDir) {
  seedGlobalInstructionsPreferences({ userDataDir });
  const now = new Date().toISOString();
  const entry = {
    id: 'cursor-persisted',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'cursor',
    label: 'Cursor saved chat',
    model: 'cursor-default',
    startedAt: now,
    completedAt: now,
    durationMs: 1000,
    tokens: { input: 11, output: 7 },
    messageCount: 1,
    assistantMessageCount: 0,
    toolUseCount: 0,
    toolCounts: {},
    projectId: 'workspace-seeded',
    worktreeId: 'worktree-seeded',
    repoId: 'repo-seeded',
    chatId: 'cursor-chat',
    hasTranscript: true,
  };
  const writeLines = (file, values) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      values.map((value) => JSON.stringify(value)).join('\n') + '\n',
    );
  };
  writeLines(
    path.join(
      userDataDir,
      'agent-observability/audit',
      `${now.slice(0, 10)}.jsonl`,
    ),
    [entry],
  );
  const digest = createHash('sha256')
    .update([entry.eventType, now, entry.id].join('\n'))
    .digest('hex')
    .slice(0, 12);
  const key = [entry.eventType, now]
    .map((value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .concat(digest)
    .join('__');
  writeLines(
    path.join(
      userDataDir,
      'agent-observability/transcripts',
      now.slice(0, 10),
      `${key}.jsonl`,
    ),
    [
      {
        type: 'canopy_injected_prompt',
        provider: 'cursor',
        kind: 'org_memory',
        application_condition: 'org_memory_enabled_for_turn',
        text: 'Cursor organization release checklist.',
      },
      {
        type: 'canopy_user_prompt',
        provider: 'cursor',
        original_text: 'Review release',
        submitted_text: 'Review release',
        plan_mode: false,
      },
    ],
  );
  seedUsageEvents({
    userDataDir,
    events: [
      {
        version: 1,
        id: 'cursor-usage',
        type: 'chat_turn_completed',
        timestamp: now,
        workspaceId: entry.projectId,
        worktreeId: entry.worktreeId,
        repoId: entry.repoId,
        provider: 'cursor',
        initiationSource: 'user',
        chatId: entry.chatId,
        auditEntryId: entry.id,
        turnStartedAt: now,
        turnCompletedAt: now,
        turnDurationMs: 1000,
        toolUseCount: 0,
        status: 'success',
      },
    ],
  });
}
