import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveWorkflowRunStatePath,
  deriveWorkflowAgentTranscriptPath,
  deriveWorkflowJournalPath,
  deriveWorkflowAgentMetaPath,
  parseWorkflowRunState,
  parseWorkflowJournalAgents,
  parseWorkflowJournalPhases,
  parseAgentMetaType,
  extractAgentPromptPreview,
  parseAgentMeta,
  extractAgentTranscriptStartedAt,
  buildLiveWorkflowRunState,
  assertAllowedWorkflowPath,
  readWorkflowAgentTranscript,
  readWorkflowArtifactFile,
} from '../lib/workflow-run-reader';

describe('workflow-run-reader', () => {
  const transcriptDir =
    '/home/u/.claude/projects/-proj/sess-1/subagents/workflows/wf_abc';

  it('derives the run-state json path from the transcript dir', () => {
    expect(deriveWorkflowRunStatePath(transcriptDir, 'wf_abc')).toBe(
      '/home/u/.claude/projects/-proj/sess-1/workflows/wf_abc.json',
    );
  });

  it('derives an agent transcript path inside the transcript dir', () => {
    expect(
      deriveWorkflowAgentTranscriptPath(transcriptDir, 'a09e5d5ae13f9506f'),
    ).toBe(
      '/home/u/.claude/projects/-proj/sess-1/subagents/workflows/wf_abc/agent-a09e5d5ae13f9506f.jsonl',
    );
  });

  it('rejects an agent id with traversal characters', () => {
    expect(() =>
      deriveWorkflowAgentTranscriptPath(transcriptDir, '../../etc/passwd'),
    ).toThrow('Invalid agentId');
  });

  it('parses run-state json into the public WorkflowRunState shape', () => {
    const raw = JSON.stringify({
      runId: 'wf_abc',
      taskId: 'whh8c9i0g',
      status: 'completed',
      workflowName: 'git-ci-audit',
      summary: 'Audit how the app uses git',
      durationMs: 350618,
      agentCount: 7,
      totalTokens: 524432,
      totalToolCalls: 228,
      phases: [{ title: 'Audit', detail: 'parallel explorers' }],
      result: '# Report',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Audit' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'audit:git-binary-env',
          phaseIndex: 1,
          phaseTitle: 'Audit',
          agentId: 'aaedc56f103655740',
          agentType: 'Explore',
          model: 'claude-haiku-4-5-20251001',
          state: 'done',
          lastToolName: 'StructuredOutput',
          lastToolSummary: 'Git resolution summary',
          promptPreview: 'Investigate how Canopy...',
          resultPreview: '{"area":"..."}',
          tokens: 70007,
          toolCalls: 48,
          durationMs: 281686,
        },
      ],
    });

    const parsed = parseWorkflowRunState(raw, 'wf_abc');
    expect(parsed).not.toBeNull();
    expect(parsed?.workflowName).toBe('git-ci-audit');
    expect(parsed?.phases).toHaveLength(1);
    expect(parsed?.agents).toHaveLength(1);
    expect(parsed?.agents[0]?.label).toBe('audit:git-binary-env');
    expect(parsed?.agents[0]?.agentId).toBe('aaedc56f103655740');
    expect(parsed?.result).toBe('# Report');
  });

  it('parses finished run and agent timestamps and errors', () => {
    const parsed = parseWorkflowRunState(
      JSON.stringify({
        status: 'completed',
        startTime: 1_700_000_000_000,
        phases: [],
        workflowProgress: [
          {
            type: 'workflow_agent',
            index: 1,
            label: 'Finished',
            phaseIndex: 0,
            phaseTitle: 'Build',
            agentId: 'agent-done',
            state: 'done',
            startedAt: 1_700_000_001_000,
            durationMs: 750,
          },
          {
            type: 'workflow_agent',
            index: 2,
            label: 'Failed',
            phaseIndex: 0,
            phaseTitle: 'Build',
            agentId: 'agent-error',
            state: 'error',
            startedAt: 1_700_000_002_000,
            durationMs: 300,
            error: 'Provider stopped unexpectedly',
          },
        ],
      }),
      'wf_finished',
    );

    expect(parsed?.startedAt).toBe(1_700_000_000_000);
    expect(parsed?.agents[0]).toMatchObject({
      startedAt: 1_700_000_001_000,
      settledAt: 1_700_000_001_750,
    });
    expect(parsed?.agents[1]).toMatchObject({
      startedAt: 1_700_000_002_000,
      settledAt: 1_700_000_002_300,
      error: 'Provider stopped unexpectedly',
    });
  });

  it('returns null for malformed json', () => {
    expect(parseWorkflowRunState('not json', 'wf_abc')).toBeNull();
  });

  it('derives journal and agent-meta paths inside the transcript dir', () => {
    expect(deriveWorkflowJournalPath(transcriptDir)).toBe(
      '/home/u/.claude/projects/-proj/sess-1/subagents/workflows/wf_abc/journal.jsonl',
    );
    expect(
      deriveWorkflowAgentMetaPath(transcriptDir, 'a09e5d5ae13f9506f'),
    ).toBe(
      '/home/u/.claude/projects/-proj/sess-1/subagents/workflows/wf_abc/agent-a09e5d5ae13f9506f.meta.json',
    );
    expect(() =>
      deriveWorkflowAgentMetaPath(transcriptDir, '../../etc/passwd'),
    ).toThrow('Invalid agentId');
  });

  it('parses latest journal states, labels, phases, and retry order', () => {
    const journal = [
      JSON.stringify({ type: 'launched' }),
      JSON.stringify({
        type: 'started',
        key: 'v2:a',
        agentId: 'agent-a',
        label: 'Agent A',
        phase: 'Setup',
      }),
      JSON.stringify({
        type: 'started',
        key: 'v2:b',
        agentId: 'agent-b',
        label: 'Agent B',
        phase: 'Inspect',
      }),
      JSON.stringify({
        type: 'started',
        key: 'v2:c',
        agentId: 'agent-c',
        label: 'Agent C',
        phase: 'Setup',
      }),
      JSON.stringify({
        type: 'result',
        key: 'v2:a',
        agentId: 'agent-a',
        result: {},
      }),
      JSON.stringify({ type: 'failed', key: 'v2:b', agentId: 'agent-b' }),
      // Latest start for a retried agent wins, without changing first order.
      JSON.stringify({
        type: 'started',
        key: 'v2:a-retry',
        agentId: 'agent-a',
        label: 'Agent A retry',
        phase: 'Verify',
      }),
      JSON.stringify({ type: 'result', key: 'v2:c', agentId: 'agent-c' }),
      'not json — skipped',
      '',
    ].join('\n');

    const agents = parseWorkflowJournalAgents(journal);
    expect(agents).toEqual([
      {
        agentId: 'agent-a',
        label: 'Agent A retry',
        phase: 'Verify',
        state: 'running',
      },
      {
        agentId: 'agent-b',
        label: 'Agent B',
        phase: 'Inspect',
        state: 'error',
      },
      {
        agentId: 'agent-c',
        label: 'Agent C',
        phase: 'Setup',
        state: 'done',
      },
    ]);
    expect(parseWorkflowJournalPhases(journal)).toEqual([
      'Setup',
      'Inspect',
      'Verify',
    ]);
  });

  it('reads agentType from a meta json, ignoring malformed input', () => {
    expect(parseAgentMetaType(JSON.stringify({ agentType: 'Explore' }))).toBe(
      'Explore',
    );
    expect(parseAgentMetaType('not json')).toBeUndefined();
    expect(parseAgentMetaType(JSON.stringify({ other: 1 }))).toBeUndefined();
  });

  it('parses live metadata and the first transcript timestamp', () => {
    expect(
      parseAgentMeta(
        JSON.stringify({
          agentType: 'Explore',
          description: 'Search the codebase',
          workflowPhase: 'Inspect',
        }),
      ),
    ).toEqual({
      agentType: 'Explore',
      description: 'Search the codebase',
      workflowPhase: 'Inspect',
    });
    expect(
      extractAgentTranscriptStartedAt(
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-10-11T14:30:00.000Z',
            message: { content: 'task' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-10-11T14:31:00.000Z',
          }),
        ].join('\n'),
      ),
    ).toBe(Date.parse('2026-10-11T14:30:00.000Z'));
  });

  it('builds a live run from journal and file details with accurate timing', () => {
    const journal = [
      JSON.stringify({
        type: 'started',
        agentId: 'agent-a',
        label: 'Journal label',
        phase: 'Prepare',
      }),
      JSON.stringify({ type: 'failed', agentId: 'agent-a' }),
      JSON.stringify({ type: 'started', agentId: 'agent-b' }),
      JSON.stringify({ type: 'result', agentId: 'agent-b' }),
    ].join('\n');
    const run = buildLiveWorkflowRunState(
      'wf_live',
      journal,
      [
        {
          agentId: 'agent-a',
          agentType: 'Explore',
          description: 'Meta fallback label',
          workflowPhase: 'Meta phase',
          startedAt: 1_000,
          modifiedAt: 7_000,
        },
        {
          agentId: 'agent-b',
          description: 'Agent B description',
          workflowPhase: 'Build',
          startedAt: 1_500,
          modifiedAt: 6_000,
          promptPreview: 'Implement the change',
        },
      ],
      5_000,
    );

    expect(run).toMatchObject({
      status: 'running',
      startedAt: 1_000,
      lastActivityAt: 7_000,
      phases: [{ title: 'Prepare' }],
      agents: [
        {
          label: 'Journal label',
          phaseTitle: 'Prepare',
          state: 'error',
          startedAt: 1_000,
          settledAt: 7_000,
          agentType: 'Explore',
        },
        {
          label: 'Agent B description',
          phaseTitle: 'Build',
          state: 'done',
          startedAt: 1_500,
          settledAt: 6_000,
          promptPreview: 'Implement the change',
        },
      ],
    });
  });

  it('reads a large final run state completely so it still parses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-artifact-'));
    try {
      const runStatePath = join(root, 'workflows', 'wf_large.json');
      await mkdir(join(root, 'workflows'), { recursive: true });
      // A finished run with many large agent results passes 8 MiB.
      const result = 'x'.repeat(9 * 1024 * 1024);
      await writeFile(
        runStatePath,
        JSON.stringify({
          runId: 'wf_large',
          status: 'completed',
          workflowProgress: [{ type: 'agent', agentId: 'a1', result }],
        }),
      );
      const text = await readWorkflowArtifactFile(runStatePath);
      expect(parseWorkflowRunState(text, 'wf_large')?.status).toBe('completed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows the configured Claude root and rejects workflow traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-path-'));
    try {
      const allowed = join(root, 'projects', 'sample', 'workflows', 'run.json');
      expect(assertAllowedWorkflowPath(allowed, root)).toBe(allowed);
      expect(() =>
        assertAllowedWorkflowPath(
          `${root}/projects/../workflows/run.json`,
          root,
        ),
      ).toThrow('Invalid workflow path');
      expect(() =>
        assertAllowedWorkflowPath(
          join(tmpdir(), 'outside', 'workflows', 'run.json'),
          root,
        ),
      ).toThrow('under an allowed directory');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a bounded transcript tail with the initial prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-transcript-'));
    try {
      const transcript = join(root, 'agent.jsonl');
      const prompt = JSON.stringify({
        type: 'user',
        timestamp: '2026-10-11T14:30:00.000Z',
        message: { content: [{ type: 'text', text: 'Initial workflow task' }] },
      });
      const records = Array.from({ length: 5_000 }, (_, index) =>
        JSON.stringify({ type: 'assistant', index, text: 'x'.repeat(1_000) }),
      );
      await writeFile(transcript, [prompt, ...records].join('\n'), 'utf8');

      const result = await readWorkflowAgentTranscript(transcript);
      expect(result.truncated).toBe(true);
      expect(result.lines.length).toBeGreaterThan(0);
      expect(result.lines.length).toBeLessThanOrEqual(20_000);
      expect(result.initialPrompt).toBe('Initial workflow task');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts the first user-message prompt from an agent transcript', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Investigate the git binary env.' },
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
    ].join('\n');
    expect(extractAgentPromptPreview(jsonl)).toBe(
      'Investigate the git binary env.',
    );

    const blockJsonl = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Block-form prompt.' }],
      },
    });
    expect(extractAgentPromptPreview(blockJsonl)).toBe('Block-form prompt.');

    expect(extractAgentPromptPreview('')).toBeUndefined();
  });
});
