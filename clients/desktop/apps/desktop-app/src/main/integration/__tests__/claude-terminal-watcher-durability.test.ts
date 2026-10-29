import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTerminalWatcherObservations,
  writeTerminalWatcherObservations,
  terminalWatcherObservationsPath,
  type TerminalObservation,
} from '../claude-terminal-transcript-sync';

it('round-trips original lifecycle evidence in a private main-only durable sidecar outside the disposable runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-watcher-durability-'));
  const runtimeDir = join(root, 'chat');
  const observation: TerminalObservation = {
    id: 'observation',
    sourceInputId: 'retained-root',
    acceptedAt: '2026-10-16T00:00:00.000Z',
    terminalAt: '2026-10-16T00:00:01.000Z',
    address: { projectId: 'project', taskId: 'task', chatId: 'chat' },
    evidence: {
      sourceOwner: { kind: 'personal' },
      resourceIncarnation: 'incarnation',
    },
    disposition: 'completed',
    previousRootIds: [],
    startsChat: true,
  };
  try {
    expect(await readTerminalWatcherObservations(runtimeDir)).toEqual([]);
    await writeTerminalWatcherObservations(runtimeDir, [observation]);
    const legacy = {
      ...observation,
      evidence: { ...observation.evidence, accountEpoch: 42 },
    };
    await writeTerminalWatcherObservations(runtimeDir, [legacy]);
    expect(
      await readFile(terminalWatcherObservationsPath(runtimeDir), 'utf8'),
    ).not.toContain('"accountEpoch"');
    await writeFile(
      terminalWatcherObservationsPath(runtimeDir),
      JSON.stringify({ version: 1, observations: [legacy] }),
    );
    expect(
      (await readTerminalWatcherObservations(runtimeDir))[0].evidence,
    ).toEqual(observation.evidence);
    await rm(runtimeDir, { recursive: true, force: true });
    expect(await readTerminalWatcherObservations(runtimeDir)).toEqual([
      observation,
    ]);
    if (process.platform !== 'win32') {
      expect(
        (await stat(terminalWatcherObservationsPath(runtimeDir))).mode & 0o777,
      ).toBe(0o600);
    }
    const bounded: TerminalObservation = {
      ...observation,
      previousRootIds: undefined,
      previousRootId: 'last-root',
      runtimeGeneration: 'launch-id',
    };
    await writeTerminalWatcherObservations(runtimeDir, [bounded]);
    expect(await readTerminalWatcherObservations(runtimeDir)).toEqual([
      bounded,
    ]);
    await writeFile(
      terminalWatcherObservationsPath(runtimeDir),
      '{"version":2,"observations":[]}',
    );
    await expect(readTerminalWatcherObservations(runtimeDir)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
