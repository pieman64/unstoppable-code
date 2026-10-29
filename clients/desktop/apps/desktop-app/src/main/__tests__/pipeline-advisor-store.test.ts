import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';
import {
  getPipelineAdvisorSnapshotPath,
  listPipelineAdvisorSnapshots,
  readPipelineAdvisorSnapshot,
  writePipelineAdvisorSnapshot,
} from '../pipelines/pipeline-advisor-store';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-advisor-store-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createReport(index = 1): PipelineAdvisorReport {
  return {
    version: 1,
    reportId: `report-${index}`,
    executionId: 'execution-1',
    kind: index === 99 ? 'final' : 'periodic',
    generatedAt: `2026-05-13T00:00:${String(index).padStart(2, '0')}.000Z`,
    pipelineStatus: 'running',
    health: {
      status: 'healthy',
      score: 90,
      summary: 'Healthy',
      evidence: ['job completed'],
      blockers: [],
    },
    eta: {
      status: 'available',
      remainingSeconds: 60,
      confidence: 'medium',
      rationale: 'One short job remains.',
    },
    inefficiencies: [],
    summary: 'Pipeline is progressing.',
    recommendations: [],
  };
}

function createSnapshot(
  overrides: Partial<PipelineAdvisorSnapshot> = {},
): PipelineAdvisorSnapshot {
  return {
    version: 1,
    executionId: 'execution-1',
    executionDataDir: path.join(tempDir, 'execution-1'),
    stateFilePath: path.join(tempDir, 'execution-1.json'),
    provider: 'codex',
    model: 'gpt-6-luna',
    thinkingLevel: 'high',
    sdkSessionId: 'thread-1',
    status: 'waiting',
    turnCount: 1,
    backoffIndex: 1,
    lastUpdatedAt: '2026-05-13T00:00:00.000Z',
    reports: [createReport()],
    latestReport: createReport(),
    ...overrides,
  };
}

it('writes and reads normalized snapshots', async () => {
  const snapshot = createSnapshot();

  await writePipelineAdvisorSnapshot(tempDir, snapshot);

  await expect(
    readPipelineAdvisorSnapshot(tempDir, 'execution-1'),
  ).resolves.toEqual(snapshot);
});

it('removes empty string entries while normalizing stored report arrays', async () => {
  await writePipelineAdvisorSnapshot(
    tempDir,
    createSnapshot({
      reports: [
        createReport(1),
        {
          ...createReport(2),
          health: {
            ...createReport(2).health,
            evidence: ['', 'job completed', ''],
            blockers: ['', 'blocked job'],
          },
          recommendations: ['', 'Keep monitoring'],
        },
      ],
      latestReport: {
        ...createReport(2),
        health: {
          ...createReport(2).health,
          evidence: ['', 'job completed', ''],
          blockers: ['', 'blocked job'],
        },
        recommendations: ['', 'Keep monitoring'],
      },
    }),
  );

  const snapshot = await readPipelineAdvisorSnapshot(tempDir, 'execution-1');

  expect(snapshot?.latestReport?.health.evidence).toEqual(['job completed']);
  expect(snapshot?.latestReport?.health.blockers).toEqual(['blocked job']);
  expect(snapshot?.latestReport?.recommendations).toEqual(['Keep monitoring']);
});

it('returns null for missing or corrupt snapshots', async () => {
  await expect(
    readPipelineAdvisorSnapshot(tempDir, 'missing'),
  ).resolves.toBeNull();

  const corruptPath = getPipelineAdvisorSnapshotPath(tempDir, 'broken');
  await writeFile(corruptPath, '{not-json', 'utf8').catch(async () => {
    await writePipelineAdvisorSnapshot(
      tempDir,
      createSnapshot({ executionId: 'broken' }),
    );
    await writeFile(corruptPath, '{not-json', 'utf8');
  });

  await expect(
    readPipelineAdvisorSnapshot(tempDir, 'broken'),
  ).resolves.toBeNull();
});

it('returns null when a stored snapshot id does not match the requested execution id', async () => {
  const mismatchedPath = getPipelineAdvisorSnapshotPath(tempDir, 'execution-2');
  await mkdir(path.dirname(mismatchedPath), { recursive: true });
  await writeFile(
    mismatchedPath,
    JSON.stringify(createSnapshot({ executionId: 'execution-1' }), null, 2),
    'utf8',
  );

  await expect(
    readPipelineAdvisorSnapshot(tempDir, 'execution-2'),
  ).resolves.toBeNull();
  await expect(
    listPipelineAdvisorSnapshots(tempDir, ['execution-2']),
  ).resolves.toEqual([]);
});

it('lists snapshots and filters by execution id', async () => {
  await writePipelineAdvisorSnapshot(tempDir, createSnapshot());
  await writePipelineAdvisorSnapshot(
    tempDir,
    createSnapshot({
      executionId: 'execution-2',
      executionDataDir: path.join(tempDir, 'execution-2'),
      stateFilePath: path.join(tempDir, 'execution-2.json'),
      lastUpdatedAt: '2026-05-13T00:01:00.000Z',
    }),
  );

  await expect(
    listPipelineAdvisorSnapshots(tempDir, ['execution-2']),
  ).resolves.toMatchObject([{ executionId: 'execution-2' }]);
});

it('caps reports at the latest 50', async () => {
  const reports = Array.from({ length: 55 }, (_value, index) =>
    createReport(index + 1),
  );
  await writePipelineAdvisorSnapshot(
    tempDir,
    createSnapshot({
      reports,
      latestReport: reports[reports.length - 1],
    }),
  );

  const raw = JSON.parse(
    await readFile(
      getPipelineAdvisorSnapshotPath(tempDir, 'execution-1'),
      'utf8',
    ),
  ) as PipelineAdvisorSnapshot;
  expect(raw.reports).toHaveLength(50);
  expect(raw.reports[0].reportId).toBe('report-6');
});
