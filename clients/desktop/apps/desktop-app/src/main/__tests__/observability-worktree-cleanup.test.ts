import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tempDir = '';

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => tempDir),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => null),
}));

import {
  getAgentObservabilityAuditDayFilePath,
  getAgentObservabilitySnapshotPath,
  getAgentObservabilityTranscriptDayDir,
  getAgentObservabilityTranscriptIndexDayFilePath,
} from '../lib/paths';
import {
  purgePersistedWorktreeObservabilityData,
  purgeWorktreeEntriesFromSnapshot,
} from '../observability/worktree-cleanup';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Expected object JSON');
  }
  return parsed;
}

describe('observability worktree cleanup', () => {
  let stderrSpy: jest.SpyInstance;
  let stderrWrites: string[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'canopy-observability-cleanup-'),
    );
    stderrWrites = [];
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('removes indexed worktree transcripts and scrubs snapshot entries', async () => {
    const day = '2026-03-30';
    const transcriptDayDir = getAgentObservabilityTranscriptDayDir(day);
    const matchingTranscript = path.join(transcriptDayDir, 'matching.jsonl');
    const otherTranscript = path.join(transcriptDayDir, 'other.jsonl');
    const indexPath = getAgentObservabilityTranscriptIndexDayFilePath(day);
    const snapshotPath = getAgentObservabilitySnapshotPath();

    await fs.mkdir(transcriptDayDir, { recursive: true });
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(matchingTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(otherTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(
      indexPath,
      [
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-1',
          entryId: 'entry-1',
          eventType: 'worktree_chat',
          startedAt: `${day}T12:00:00.000Z`,
          transcriptPath: matchingTranscript,
        }),
        '{malformed',
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-2',
          entryId: 'entry-2',
          eventType: 'worktree_chat',
          startedAt: `${day}T12:30:00.000Z`,
          transcriptPath: otherTranscript,
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(
      snapshotPath,
      JSON.stringify(
        {
          recentEntries: [
            { id: 'entry-1', projectId: 'project-1', worktreeId: 'wt-1' },
            { id: 'entry-2', projectId: 'project-1', worktreeId: 'wt-2' },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    await purgePersistedWorktreeObservabilityData('project-1', 'wt-1');

    await expect(fs.access(matchingTranscript)).rejects.toThrow();
    await expect(fs.access(otherTranscript)).resolves.toBeUndefined();
    const rewrittenIndex = await fs.readFile(indexPath, 'utf8');
    expect(rewrittenIndex).not.toContain('entry-1');
    expect(rewrittenIndex).toContain('entry-2');
    expect(rewrittenIndex).not.toContain('malformed');
    const snapshot = await readJson(snapshotPath);
    expect(snapshot.recentEntries).toEqual([
      { id: 'entry-2', projectId: 'project-1', worktreeId: 'wt-2' },
    ]);
    expect(stderrWrites.join('')).toContain('malformed transcript index line');
  });

  it('removes empty transcript day directories after deleting indexed transcripts', async () => {
    const day = '2026-03-31';
    const transcriptDayDir = getAgentObservabilityTranscriptDayDir(day);
    const matchingTranscript = path.join(transcriptDayDir, 'matching.jsonl');
    const indexPath = getAgentObservabilityTranscriptIndexDayFilePath(day);

    await fs.mkdir(transcriptDayDir, { recursive: true });
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(matchingTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        projectId: 'project-1',
        worktreeId: 'wt-1',
        entryId: 'entry-1',
        eventType: 'worktree_chat',
        startedAt: `${day}T12:00:00.000Z`,
        transcriptPath: matchingTranscript,
      }) + '\n',
      'utf8',
    );

    await purgePersistedWorktreeObservabilityData('project-1', 'wt-1');

    await expect(fs.access(matchingTranscript)).rejects.toThrow();
    await expect(fs.access(transcriptDayDir)).rejects.toThrow();
  });

  it('purges pipeline advisor audit rows and transcripts for the worktree', async () => {
    const day = '2026-05-13';
    const auditPath = getAgentObservabilityAuditDayFilePath(day);
    const transcriptDayDir = getAgentObservabilityTranscriptDayDir(day);
    const advisorTranscript = path.join(
      transcriptDayDir,
      'pipeline_advisor-advisor-entry.jsonl',
    );
    const otherTranscript = path.join(
      transcriptDayDir,
      'pipeline_advisor-other-entry.jsonl',
    );
    const indexPath = getAgentObservabilityTranscriptIndexDayFilePath(day);

    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.mkdir(transcriptDayDir, { recursive: true });
    await fs.writeFile(advisorTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(otherTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(
      auditPath,
      [
        JSON.stringify({
          id: 'advisor-entry',
          eventType: 'pipeline_advisor',
          startedAt: `${day}T12:00:00.000Z`,
          projectId: 'project-1',
          worktreeId: 'wt-1',
        }),
        JSON.stringify({
          id: 'other-entry',
          eventType: 'pipeline_advisor',
          startedAt: `${day}T12:30:00.000Z`,
          projectId: 'project-1',
          worktreeId: 'wt-2',
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(
      indexPath,
      [
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-1',
          entryId: 'advisor-entry',
          eventType: 'pipeline_advisor',
          startedAt: `${day}T12:00:00.000Z`,
          transcriptPath: advisorTranscript,
        }),
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-2',
          entryId: 'other-entry',
          eventType: 'pipeline_advisor',
          startedAt: `${day}T12:30:00.000Z`,
          transcriptPath: otherTranscript,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await purgePersistedWorktreeObservabilityData('project-1', 'wt-1');

    await expect(fs.access(advisorTranscript)).rejects.toThrow();
    await expect(fs.access(otherTranscript)).resolves.toBeUndefined();
    const rewrittenAudit = await fs.readFile(auditPath, 'utf8');
    expect(rewrittenAudit).not.toContain('advisor-entry');
    expect(rewrittenAudit).toContain('other-entry');
    const rewrittenIndex = await fs.readFile(indexPath, 'utf8');
    expect(rewrittenIndex).not.toContain('advisor-entry');
    expect(rewrittenIndex).toContain('other-entry');
  });

  it('purges legacy code graph audit rows by worktree identifiers', async () => {
    const day = '2026-07-16';
    const auditPath = getAgentObservabilityAuditDayFilePath(day);

    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.writeFile(
      auditPath,
      [
        JSON.stringify({
          id: 'legacy-code-graph-entry',
          eventType: 'code_graph_build',
          startedAt: `${day}T12:00:00.000Z`,
          projectId: 'project-1',
          worktreeId: 'wt-1',
        }),
        JSON.stringify({
          id: 'other-legacy-code-graph-entry',
          eventType: 'code_graph_build',
          startedAt: `${day}T12:30:00.000Z`,
          projectId: 'project-1',
          worktreeId: 'wt-2',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await purgePersistedWorktreeObservabilityData('project-1', 'wt-1');

    const rewrittenAudit = await fs.readFile(auditPath, 'utf8');
    const remainingEntries = rewrittenAudit
      .trim()
      .split('\n')
      .map((line) => {
        const entry: unknown = JSON.parse(line);
        if (!isRecord(entry) || typeof entry.id !== 'string') {
          throw new Error('Expected audit entry with string id');
        }
        return entry.id;
      });
    expect(remainingEntries).toEqual(['other-legacy-code-graph-entry']);
  });

  it('purges If Command generation transcript indexes for the worktree', async () => {
    const day = '2026-06-19';
    const transcriptDayDir = getAgentObservabilityTranscriptDayDir(day);
    const matchingTranscript = path.join(
      transcriptDayDir,
      'automation_if_command_generation-entry-1.jsonl',
    );
    const otherTranscript = path.join(
      transcriptDayDir,
      'automation_if_command_generation-entry-2.jsonl',
    );
    const indexPath = getAgentObservabilityTranscriptIndexDayFilePath(day);

    await fs.mkdir(transcriptDayDir, { recursive: true });
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(matchingTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(otherTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(
      indexPath,
      [
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-1',
          entryId: 'entry-1',
          eventType: 'automation_if_command_generation',
          startedAt: `${day}T12:00:00.000Z`,
          transcriptPath: matchingTranscript,
        }),
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-2',
          entryId: 'entry-2',
          eventType: 'automation_if_command_generation',
          startedAt: `${day}T12:30:00.000Z`,
          transcriptPath: otherTranscript,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await purgePersistedWorktreeObservabilityData('project-1', 'wt-1');

    await expect(fs.access(matchingTranscript)).rejects.toThrow();
    await expect(fs.access(otherTranscript)).resolves.toBeUndefined();
    const rewrittenIndex = await fs.readFile(indexPath, 'utf8');
    expect(rewrittenIndex).not.toContain('entry-1');
    expect(rewrittenIndex).toContain('entry-2');
  });

  it('skips deleting indexed transcripts outside the transcripts root', async () => {
    const day = '2026-04-01';
    const transcriptDayDir = getAgentObservabilityTranscriptDayDir(day);
    const matchingTranscript = path.join(transcriptDayDir, 'matching.jsonl');
    const unsafeTranscript = path.join(tempDir, 'outside.jsonl');
    const indexPath = getAgentObservabilityTranscriptIndexDayFilePath(day);

    await fs.mkdir(transcriptDayDir, { recursive: true });
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(matchingTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(unsafeTranscript, '{"type":"assistant"}\n', 'utf8');
    await fs.writeFile(
      indexPath,
      [
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-1',
          entryId: 'entry-1',
          eventType: 'worktree_chat',
          startedAt: `${day}T12:00:00.000Z`,
          transcriptPath: unsafeTranscript,
        }),
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          worktreeId: 'wt-2',
          entryId: 'entry-2',
          eventType: 'worktree_chat',
          startedAt: `${day}T12:30:00.000Z`,
          transcriptPath: matchingTranscript,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await purgePersistedWorktreeObservabilityData('project-1', 'wt-1');

    await expect(fs.access(unsafeTranscript)).resolves.toBeUndefined();
    const rewrittenIndex = await fs.readFile(indexPath, 'utf8');
    expect(rewrittenIndex).not.toContain('entry-1');
    expect(rewrittenIndex).toContain('entry-2');
    expect(stderrWrites.join('')).toContain(
      'skipping transcript deletion outside transcripts root',
    );
  });

  it('leaves malformed snapshot files in place', async () => {
    const snapshotPath = getAgentObservabilitySnapshotPath();
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, '{malformed', 'utf8');

    await purgeWorktreeEntriesFromSnapshot('project-1', 'wt-1');

    await expect(fs.readFile(snapshotPath, 'utf8')).resolves.toBe('{malformed');
    expect(stderrWrites.join('')).toContain('failed to parse snapshot');
  });
});
