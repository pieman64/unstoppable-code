import { seedObservabilityAudit } from './seedObservabilityAudit.mjs';

/** Seed request evidence with no published rate or provider-served tier. */
export function seedCodexSpeedAudit(userDataDir) {
  const id = 'codex-ultra-speed-audit';
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  seedObservabilityAudit({
    userDataDir,
    entries: [
      {
        id,
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'codex',
        label: 'Ultra fast request evidence',
        startedAt,
        completedAt: new Date(Date.now() - 30_000).toISOString(),
        durationMs: 30_000,
        model: 'gpt-6-astra',
        serviceTier: 'ultrafast',
        observedCost: {
          status: 'unpriced',
          reason: 'unsupported_service_tier',
          serviceTier: 'ultrafast',
          components: [],
        },
        tokens: { input: 80, output: 40, cacheRead: 0, cacheCreation: 0 },
        messageCount: 2,
        assistantMessageCount: 1,
        toolUseCount: 0,
        subAgentCount: 0,
        toolCounts: {},
        hasTranscript: true,
      },
    ],
    transcripts: {
      [id]: [
        {
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Use the selected speed',
          submitted_text: 'Use the selected speed',
          plan_mode: false,
        },
        {
          type: 'response_item',
          role: 'assistant',
          content: 'Fixture response; no served tier was reported.',
        },
      ],
    },
  });
  return id;
}
