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

  it('returns the generated PluginInstalledResponse shape by default', async () => {
    const statePath = path.join(tempDir, 'codex-state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
      'utf8',
    );
    child = spawn(process.execPath, [FIXTURE_PATH], {
      env: {
        ...process.env,
        CANOPY_E2E_CODEX_STATE_PATH: statePath,
        CANOPY_E2E_CODEX_PLUGIN_FIXTURE_PATH: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const runningChild = child;

    const response = await new Promise<unknown>((resolve, reject) => {
      const output = createInterface({ input: runningChild.stdout });
      const timeout = setTimeout(() => {
        output.close();
        reject(new Error('Timed out waiting for fake Codex response'));
      }, 5_000);
      output.once('line', (line) => {
        clearTimeout(timeout);
        output.close();
        resolve(JSON.parse(line));
      });
      runningChild.once('error', reject);
      runningChild.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: 'plugin/installed',
          params: { cwds: null, installSuggestionPluginNames: null },
        })}\n`,
      );
    });

    expect(response).toEqual({
      id: 1,
      result: {
        marketplaces: [],
        marketplaceLoadErrors: [],
      },
    });
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
});
