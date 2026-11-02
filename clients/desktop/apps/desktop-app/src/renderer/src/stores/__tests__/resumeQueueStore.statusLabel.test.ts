import type {
  ResumeQueueEntry,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import {
  resumeQueueEntryGlyphState,
  resumeQueueStatusGlyphState,
  resumeQueueStatusLabel,
} from '../resumeQueueStore';

const entry = (
  id: string,
  status: ResumeQueueEntry['status'],
): ResumeQueueEntry => ({
  id,
  target: {
    kind: 'chat',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: id,
  },
  interruptionId: id,
  title: id,
  workspaceName: 'Workspace',
  createdAt: 1,
  status,
});

const snapshot = (
  statuses: ResumeQueueEntry['status'][],
  overrides: Partial<ResumeQueueSnapshot> = {},
): ResumeQueueSnapshot => ({
  version: 1,
  revision: 1,
  paused: false,
  entries: statuses.map((status, index) => entry(`entry-${index}`, status)),
  ...overrides,
});

describe('resumeQueueStatusLabel', () => {
  it.each<[string, ResumeQueueSnapshot, string]>([
    [
      'a queue-level error',
      snapshot(['resumed'], { error: 'Could not resume.' }),
      'Paused',
    ],
    [
      'an active paused queue',
      snapshot(['failed', 'waiting'], { paused: true }),
      'Paused',
    ],
    [
      'active work over earlier failures',
      snapshot(['failed', 'waiting']),
      'In progress',
    ],
    [
      'active work over earlier stops',
      snapshot(['stopped', 'resuming']),
      'In progress',
    ],
    [
      'a failure over stops and starts',
      snapshot(['resumed', 'stopped', 'failed']),
      'Needs attention',
    ],
    ['a stop over starts', snapshot(['resumed', 'stopped']), 'Stopped'],
    ['all resumed', snapshot(['resumed', 'resumed']), 'Started'],
    ['started with skipped rows', snapshot(['resumed', 'skipped']), 'Started'],
    ['all skipped', snapshot(['skipped', 'skipped']), 'Nothing to resume'],
    ['an empty queue', snapshot([]), 'Nothing to resume'],
    [
      'a stale paused flag on a terminal queue',
      snapshot(['resumed'], { paused: true }),
      'Started',
    ],
  ])('labels %s', (_label, value, expected) => {
    expect(resumeQueueStatusLabel(value)).toBe(expected);
  });
});

describe('resume queue status glyphs', () => {
  it.each<[ResumeQueueEntry['status'], string]>([
    ['waiting', 'queued'],
    ['resuming', 'running'],
    ['resumed', 'done'],
    // The queue never started a skipped entry, so it must not read as done.
    ['skipped', 'cancelled'],
    ['failed', 'failed'],
    ['stopped', 'cancelled'],
  ])('draws a %s row as %s', (status, glyph) => {
    expect(resumeQueueEntryGlyphState(status)).toBe(glyph);
  });

  it.each<[Parameters<typeof resumeQueueStatusGlyphState>[0], string]>([
    ['Paused', 'paused'],
    ['In progress', 'running'],
    ['Needs attention', 'failed'],
    ['Stopped', 'cancelled'],
    ['Started', 'done'],
    ['Nothing to resume', 'cancelled'],
  ])('draws the %s headline as %s', (label, glyph) => {
    expect(resumeQueueStatusGlyphState(label)).toBe(glyph);
  });
});
