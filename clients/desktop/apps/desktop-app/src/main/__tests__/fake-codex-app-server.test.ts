import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'apps/desktop-app/tests/electron/fixtures/fake-codex-app-server.mjs',
);

describe('fake Codex app-server marketplace protocol', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-fake-codex-marketplaces-'),
    );
  });

  afterEach(() => {
    child?.kill();
    child = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function requestInstalledPlugins(
    fixturePath: string,
  ): Promise<unknown> {
    const statePath = path.join(tempDir, 'codex-state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
      'utf8',
    );
    child = spawn(process.execPath, [fixturePath], {
      env: {
        ...process.env,
        CANOPY_E2E_CODEX_STATE_PATH: statePath,
        CANOPY_E2E_CODEX_PLUGIN_FIXTURE_PATH: '',
        // Keep these tests on the non-replay path even if the shell sets it.
        CANOPY_LIFECYCLE_REPLAY_SCENARIO_OPTIONS: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const runningChild = child;

    return new Promise<unknown>((resolve, reject) => {
      const output = createInterface({ input: runningChild.stdout });
      let stderr = '';
      runningChild.stderr.setEncoding('utf8');
      runningChild.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      // Stay under Jest's default 5 s test timeout so this error is reported.
      const timeout = setTimeout(() => {
        output.close();
        reject(new Error('Timed out waiting for fake Codex response'));
      }, 4_000);
      output.once('line', (line) => {
        clearTimeout(timeout);
        output.close();
        resolve(JSON.parse(line));
      });
      runningChild.once('error', reject);
      // A crash before the reply rejects with its stderr. The exit after the
      // afterEach kill settles nothing because the promise already resolved.
      runningChild.once('exit', (code) => {
        clearTimeout(timeout);
        output.close();
        reject(new Error(`Fake Codex exited with code ${code}:\n${stderr}`));
      });
      runningChild.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: 'plugin/installed',
          params: { cwds: null, installSuggestionPluginNames: null },
        })}\n`,
      );
    });
  }

  it('returns the generated PluginInstalledResponse shape by default', async () => {
    await expect(requestInstalledPlugins(FIXTURE_PATH)).resolves.toEqual({
      id: 1,
      result: {
        marketplaces: [],
        marketplaceLoadErrors: [],
      },
    });
  });

  // The public desktop export ships these fixtures without the turn-state
  // harness contract under scripts/, which only replay mode needs.
  it('starts outside replay mode without the turn-state harness contract', async () => {
    const fixturesDir = path.join(
      tempDir,
      'export/apps/desktop-app/tests/electron/fixtures',
    );
    fs.mkdirSync(fixturesDir, { recursive: true });
    // Mirror the fixture's sibling imports, static and lazy. A missing sibling
    // fails with its module name in the exit error.
    for (const name of [
      'fake-codex-app-server.mjs',
      'codex-chat-summary-traffic.mjs',
      'lifecycle-replay-codex.mjs',
      'lifecycle-replay.mjs',
    ]) {
      fs.copyFileSync(
        path.join(path.dirname(FIXTURE_PATH), name),
        path.join(fixturesDir, name),
      );
    }

    await expect(
      requestInstalledPlugins(
        path.join(fixturesDir, 'fake-codex-app-server.mjs'),
      ),
    ).resolves.toMatchObject({ id: 1 });
  });
});

describe('fake Codex app-server chat-summary turns', () => {
  const SUMMARY_INSTRUCTIONS =
    'You are an expert at providing concise topic summaries.';
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-fake-codex-summary-'),
    );
  });

  afterEach(() => {
    child?.kill();
    child = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function field(value: unknown, ...keys: string[]): unknown {
    let current = value;
    for (const key of keys) {
      if (typeof current !== 'object' || current === null) return undefined;
      current = Reflect.get(current, key);
    }
    return current;
  }

  interface FakeServer {
    startThread: (id: number, params: object) => Promise<string>;
    runTurn: (id: number, threadId: string, text: string) => Promise<unknown[]>;
  }

  function startServer(mode: string): FakeServer {
    const statePath = path.join(tempDir, 'codex-state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
      'utf8',
    );
    const runningChild = spawn(process.execPath, [FIXTURE_PATH], {
      env: {
        ...process.env,
        CANOPY_E2E_CODEX_STATE_PATH: statePath,
        CANOPY_E2E_CODEX_MODE: mode,
        CANOPY_E2E_CODEX_REPLY: 'Conversation reply',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = runningChild;
    const buffered: unknown[] = [];
    let onLine: (() => void) | undefined;
    createInterface({ input: runningChild.stdout }).on('line', (line) => {
      buffered.push(JSON.parse(line));
      onLine?.();
    });
    const readUntil = (
      done: (message: unknown) => boolean,
    ): Promise<unknown[]> =>
      new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          onLine = undefined;
          reject(new Error('Timed out waiting for fake Codex output'));
        }, 10_000);
        const check = (): void => {
          const index = buffered.findIndex(done);
          if (index === -1) return;
          clearTimeout(timeout);
          onLine = undefined;
          resolve(buffered.splice(0, index + 1));
        };
        onLine = check;
        check();
      });
    const request = (message: object): void => {
      runningChild.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const startThread = async (id: number, params: object): Promise<string> => {
      request({ id, method: 'thread/start', params });
      const messages = await readUntil(
        (message) => field(message, 'id') === id,
      );
      const threadId = field(messages.at(-1), 'result', 'thread', 'id');
      if (typeof threadId !== 'string') {
        throw new Error('thread/start returned no thread id');
      }
      return threadId;
    };
    const runTurn = (
      id: number,
      threadId: string,
      text: string,
    ): Promise<unknown[]> => {
      request({
        id,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
        },
      });
      return readUntil(
        (message) =>
          field(message, 'method') === 'turn/completed' &&
          field(message, 'params', 'threadId') === threadId,
      );
    };
    return { startThread, runTurn };
  }

  function completedTexts(messages: unknown[]): unknown[] {
    return messages
      .filter((message) => field(message, 'method') === 'item/completed')
      .map((message) => field(message, 'params', 'item', 'text'));
  }

  it('answers a summary quoting a scripted prompt without running the script', async () => {
    const server = startServer('event-pressure');
    const summaryThread = await server.startThread(1, {
      cwd: tempDir,
      ephemeral: true,
      developerInstructions: SUMMARY_INSTRUCTIONS,
    });
    const summary = await server.runTurn(
      2,
      summaryThread,
      '<user_message_to_summarize>Report pressure status.</user_message_to_summarize>',
    );
    expect(completedTexts(summary)).toEqual(['Codex fixture topic summary']);

    // The conversation's own turn still receives the scripted burst, and its
    // turn id does not depend on the summary having started first.
    const conversationThread = await server.startThread(3, { cwd: tempDir });
    const conversation = await server.runTurn(
      4,
      conversationThread,
      'Report pressure status.',
    );
    expect(field(conversation.at(-1), 'params', 'turn', 'id')).toBe(
      'e2e-turn-1',
    );
    expect(
      completedTexts(conversation).filter(
        (text) =>
          typeof text === 'string' && text.startsWith('CANOPY-EVENT-PRESSURE-'),
      ),
    ).toHaveLength(48);
  });

  it('completes summary turns in a mode that fails conversation turns', async () => {
    const server = startServer('usage-limit');
    const summaryThread = await server.startThread(1, {
      cwd: tempDir,
      ephemeral: true,
      developerInstructions: SUMMARY_INSTRUCTIONS,
    });
    const summary = await server.runTurn(
      2,
      summaryThread,
      '<user_message_to_summarize>Keep working</user_message_to_summarize>',
    );
    expect(completedTexts(summary)).toEqual(['Codex fixture topic summary']);
    expect(field(summary.at(-1), 'params', 'turn', 'status')).toBe('completed');

    const conversationThread = await server.startThread(3, { cwd: tempDir });
    const conversation = await server.runTurn(
      4,
      conversationThread,
      'Keep working',
    );
    expect(field(conversation.at(-1), 'params', 'turn', 'status')).toBe(
      'failed',
    );
  });

  // Real Codex follows a non-retrying turn error with turn/completed (status
  // failed, carrying the error); the desktop holds the error until then.
  it.each(['usage-limit-banner', 'usage-limit-resume', 'proxy-quota'])(
    'completes the turn as failed after a non-retrying quota error in %s mode',
    async (mode) => {
      const server = startServer(mode);
      const threadId = await server.startThread(1, { cwd: tempDir });
      const messages = await server.runTurn(2, threadId, 'Keep working');
      const errorIndex = messages.findIndex(
        (message) => field(message, 'method') === 'error',
      );
      expect(errorIndex).toBeGreaterThan(-1);
      expect(field(messages[errorIndex], 'params', 'willRetry')).toBe(false);
      const quotaError = field(messages[errorIndex], 'params', 'error');
      expect(field(quotaError, 'codexErrorInfo')).toBe('usageLimitExceeded');
      expect(messages.length - 1).toBeGreaterThan(errorIndex);
      const completed = messages.at(-1);
      expect(field(completed, 'params', 'turn', 'status')).toBe('failed');
      expect(field(completed, 'params', 'turn', 'error')).toEqual(quotaError);
    },
  );
});
