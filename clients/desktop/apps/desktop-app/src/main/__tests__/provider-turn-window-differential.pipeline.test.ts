/**
 * Invariant 6 (turn-state phase 43h): reduction against the window equals
 * reduction against the full transcript. The same script runs twice through
 * the real host and pipeline: once with an 8-row transcript window and once
 * with the default window, which holds the whole transcript. Both committed
 * transcripts must match, row for row.
 *
 * The reducer reads the newest committed page plus the active turn's rows, so
 * the script ends a root turn whose background agent outlives it, commits
 * four follow-up turns behind the agent's call, and only then ends the agent.
 * The late Codex card completion and the Claude wake turn then reduce with the
 * call, its timer and the earlier turns outside a small window. An in-place
 * update of a committed row needs a frame of the same turn; the reducer-level
 * provider-frame-window.test.ts covers that with an out-of-window Codex card.
 */
import * as transcriptStorage from '@canopy/agent-transcript/transcript-storage';
import {
  createScenarioEnvironment,
  disposeScenario,
  startRoot,
} from './pipeline-harness/scenarios';
import type { PipelineStorage } from './pipeline-harness/storage';

// One module registry for both runs: a registry reset breaks the scripted
// Codex runtime. The chat transcript log reads the page size at call time, so
// each run sets its own window. shortcut: the sparse index stride is read once
// at load and stays at the default in both runs; pin it too if a run needs it.
jest.mock('@canopy/agent-transcript/transcript-storage', () => {
  const actual = jest.requireActual<typeof transcriptStorage>(
    '@canopy/agent-transcript/transcript-storage',
  );
  let pageSize = actual.TRANSCRIPT_PAGE_SIZE;
  const mocked = {
    ...actual,
    setTestPageSize(next: number): void {
      pageSize = next;
    },
  };
  // Defined after the spread: the test build lowers spread to Object.assign,
  // which would copy a getter's value once.
  Object.defineProperty(mocked, 'TRANSCRIPT_PAGE_SIZE', {
    enumerable: true,
    get: (): number => pageSize,
  });
  return mocked;
});
const windowControl = jest.requireMock<{
  setTestPageSize(next: number): void;
}>('@canopy/agent-transcript/transcript-storage');
const DEFAULT_PAGE_SIZE = transcriptStorage.TRANSCRIPT_PAGE_SIZE;

jest.setTimeout(300_000);

type Provider = 'claude' | 'codex';

const SMALL_PAGE_SIZE = 8;
const FOLLOW_UP_TURNS = 4;
const EARLY_CALL = 'early-agent-call';
const EARLY_TASK = 'early-agent-task';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME_KEYS = new Set([
  'timestamp',
  'startedAt',
  'completedAt',
  'capturedAt',
]);

/** Random ids and wall-clock times differ between runs; their roles don't. */
function normalized(rows: readonly unknown[]): unknown[] {
  const ids = new Map<string, string>();
  const text = JSON.stringify(rows, (key, value: unknown) =>
    TIME_KEYS.has(key) && typeof value === 'number' ? 0 : value,
  ).replace(UUID, (id) => {
    const known = ids.get(id) ?? `id-${String(ids.size)}`;
    ids.set(id, known);
    return known;
  });
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

function rowId(row: unknown): unknown {
  return typeof row === 'object' && row !== null && 'id' in row
    ? row.id
    : undefined;
}

interface Run {
  rows: unknown[];
  pageSize: number;
  /** The agent call's committed row, before the agent ended. */
  callRow: unknown;
  /** Committed rows after it at that point. */
  rowsAfterCall: number;
}

async function committedRows(
  provider: Provider,
  pageSize: number,
): Promise<Run> {
  windowControl.setTestPageSize(pageSize);
  let storage: PipelineStorage | undefined;
  const env = await createScenarioEnvironment('worktree', provider, {
    captureRows: true,
    captureTranscript: 'off',
    prepareStorage: (prepared) => {
      storage = prepared;
      return Promise.resolve();
    },
  });
  const committed = (): unknown[] => {
    if (!storage) throw new Error('The scenario prepared no storage');
    return storage
      .readCommittedTranscript(env.target)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line): unknown => JSON.parse(line));
  };
  try {
    const root = await startRoot(env, 'window differential');
    // Codex's spawn is its own agent card; Claude's is an acknowledged call.
    if (provider === 'claude')
      await root.emitToolCall({ callId: EARLY_CALL, name: 'Agent' });
    await root.startNativeTask({
      taskId: EARLY_TASK,
      toolUseId: EARLY_CALL,
      kind: 'agent',
    });
    if (provider === 'claude')
      await root.emitToolResult(EARLY_CALL, 'Async agent launched');
    await root.complete();
    await env.host.drain();
    // Each follow-up turn commits its prompt, answer and timer behind the call.
    for (let index = 0; index < FOLLOW_UP_TURNS; index += 1) {
      const turn = await startRoot(env, `follow-up ${String(index)}`);
      await turn.complete();
      await env.host.drain();
    }
    const settledRoot = committed();
    const callIndex = settledRoot.findIndex((row) =>
      JSON.stringify(row).includes(`"${EARLY_CALL}"`),
    );
    await root.endNativeTask(EARLY_TASK);
    if (provider === 'claude') {
      const wake = await env.driver.startTurnByItself({ text: 'woke up' });
      await wake.complete();
    }
    await env.host.drain();
    return {
      rows: committed(),
      pageSize: transcriptStorage.TRANSCRIPT_PAGE_SIZE,
      callRow: settledRoot[callIndex],
      rowsAfterCall: callIndex < 0 ? -1 : settledRoot.length - 1 - callIndex,
    };
  } finally {
    await disposeScenario(env);
  }
}

describe('invariant 6: window versus full reduction (turn-state phase 43h)', () => {
  it.each<Provider>(['claude', 'codex'])(
    '%s commits the same transcript through a small window as through the full one',
    async (provider) => {
      const windowed = await committedRows(provider, SMALL_PAGE_SIZE);
      const full = await committedRows(provider, DEFAULT_PAGE_SIZE);
      // Not vacuous: the small run's window is far shorter than the
      // transcript, the full run's holds all of it, and the agent's call was
      // committed further back than the small window before the agent ended.
      expect(windowed.pageSize).toBe(SMALL_PAGE_SIZE);
      expect(full.pageSize).toBeGreaterThan(full.rows.length);
      expect(windowed.rowsAfterCall).toBeGreaterThan(SMALL_PAGE_SIZE);
      const callAfter = windowed.rows.find(
        (row) => rowId(row) === rowId(windowed.callRow),
      );
      expect(callAfter).toBeDefined();
      // The late events left the committed call as it was (invariant 4).
      expect(callAfter).toEqual(windowed.callRow);
      if (provider === 'claude')
        // The wake opened its own timer for the agent's call.
        expect(JSON.stringify(windowed.rows)).toContain(
          `"spawnedBy":{"taskId":"${EARLY_TASK}","toolUseId":"${EARLY_CALL}"}`,
        );
      expect(normalized(windowed.rows)).toEqual(normalized(full.rows));
    },
  );
});
