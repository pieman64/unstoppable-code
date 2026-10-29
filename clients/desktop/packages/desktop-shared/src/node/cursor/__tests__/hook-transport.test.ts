import { createCursorUsageHook, CURSOR_USAGE_HOOK_SCRIPT } from '../usage-hook';
import type { CursorReportedUsage } from '@canopy/agent-transcript/lib/cursor-usage';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCursorHookTransport,
  CURSOR_HOOK_SCRIPT,
  type CursorHookOutcome,
  type CursorHookTransport,
} from '../hook-transport';

/** A Buffer is sent as the exact request or stdin bytes; anything else as JSON. */
function encode(payload: unknown): string | Buffer {
  return Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
}

/** What the Cursor runtime on Windows writes to hook stdin: a BOM, then the JSON. */
function withByteOrderMark(payload: unknown): Buffer {
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(payload)),
  ]);
}

function post(
  hook: CursorHookTransport,
  payload: unknown,
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      hook.url,
      { method: 'POST', headers: { authorization: `Bearer ${hook.token}` } },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer): void => {
          body += chunk.toString();
        });
        res.on('end', (): void => {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(encode(payload));
  });
}

async function runStandaloneHook(
  hook: CursorHookTransport,
  payload: unknown,
  scriptSource = CURSOR_HOOK_SCRIPT,
): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), 'cursor-hook-transport-'));
  try {
    const script = join(root, 'hook.cjs');
    const config = join(root, 'connection.json');
    await writeFile(script, scriptSource);
    await writeFile(
      config,
      JSON.stringify({ url: hook.url, token: hook.token }),
      { mode: 0o600 },
    );
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, [script, config], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (chunk: Buffer): void => {
        text += chunk.toString();
      });
      child.stderr.resume();
      // A hook stops reading once the request exceeds its bound.
      child.stdin.on('error', (): void => undefined);
      child.once('error', reject);
      child.once('close', (code): void => {
        if (code === 0) resolveOutput(text);
        else reject(new Error('Generated hook failed.'));
      });
      child.stdin.end(encode(payload));
    });
    return JSON.parse(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const shellPayload = {
  hook_event_name: 'preToolUse',
  tool_name: 'Shell',
  tool_input: { command: 'git status', cwd: '/repo' },
  tool_use_id: 'shell-1',
};

describe('Cursor hook transport command rewrites', () => {
  let hook: CursorHookTransport | undefined;
  afterEach(async (): Promise<void> => {
    await hook?.close();
    hook = undefined;
  });

  it('waits for the standalone hook output to flush before exiting', (): void => {
    expect(CURSOR_HOOK_SCRIPT).toContain(
      "process.stdout.write(JSON.stringify(output) + '\\n', () => process.exit(0));",
    );
  });

  it('forwards a rewritten input on allow through the callback and the standalone hook', async (): Promise<void> => {
    const updatedInput = { command: 'rtk git status', cwd: '/repo' };
    hook = await createCursorHookTransport(
      (): Promise<CursorHookOutcome> => {
        const outcome: CursorHookOutcome = { decision: 'allow', updatedInput };
        return Promise.resolve(outcome);
      },
      () => {},
    );
    expect(await post(hook, shellPayload)).toEqual({
      status: 200,
      body: { permission: 'allow', updated_input: updatedInput },
    });
    expect(await runStandaloneHook(hook, shellPayload)).toEqual({
      permission: 'allow',
      updated_input: updatedInput,
    });
  });

  it('never forwards a rewritten input with a denial', async (): Promise<void> => {
    hook = await createCursorHookTransport(
      (): Promise<CursorHookOutcome> => {
        const outcome: CursorHookOutcome = {
          decision: 'deny',
          updatedInput: { command: 'rtk git status' },
        };
        return Promise.resolve(outcome);
      },
      () => {},
    );
    const { body } = await post(hook, shellPayload);
    expect(body).toMatchObject({ permission: 'deny' });
    expect(body).not.toHaveProperty('updated_input');
    expect(await runStandaloneHook(hook, shellPayload)).toEqual({
      permission: 'deny',
    });
  });

  it('preserves a policy denial reason through the standalone hook', async (): Promise<void> => {
    hook = await createCursorHookTransport(
      () =>
        Promise.resolve({
          decision: 'deny',
          message: 'Search denied by workspace policy.',
        }),
      () => {},
    );
    const result = await runStandaloneHook(hook, shellPayload);
    expect(result).toMatchObject({
      permission: 'deny',
      user_message: 'Search denied by workspace policy.',
      agent_message:
        'Search denied by workspace policy. Do not retry it through another tool.',
    });
  });

  it('flushes a near-limit rewritten command through the standalone hook', async (): Promise<void> => {
    const updatedInput = { command: `rtk printf ${'x'.repeat(63_000)}` };
    hook = await createCursorHookTransport(
      (): Promise<CursorHookOutcome> => {
        const outcome: CursorHookOutcome = { decision: 'allow', updatedInput };
        return Promise.resolve(outcome);
      },
      () => {},
    );
    expect(await runStandaloneHook(hook, shellPayload)).toEqual({
      permission: 'allow',
      updated_input: updatedInput,
    });
  });

  it('falls back to the original input when the rewritten response is oversized', async (): Promise<void> => {
    const updatedInput = { command: `rtk printf ${'x'.repeat(66_000)}` };
    hook = await createCursorHookTransport(
      (): Promise<CursorHookOutcome> => {
        const outcome: CursorHookOutcome = { decision: 'allow', updatedInput };
        return Promise.resolve(outcome);
      },
      () => {},
    );

    expect(await post(hook, shellPayload)).toEqual({
      status: 200,
      body: { permission: 'allow' },
    });
    expect(await runStandaloneHook(hook, shellPayload)).toEqual({
      permission: 'allow',
    });
  });
});

describe('Cursor approval hook request bound', () => {
  let hook: CursorHookTransport | undefined;
  afterEach(async (): Promise<void> => {
    await hook?.close();
    hook = undefined;
  });

  // The pinned CLI sends a Write's whole post-edit file, even for a small edit.
  function writePayload(contentBytes: number): Record<string, unknown> {
    return {
      hook_event_name: 'preToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: '/repo/large.ts',
        content: 'x'.repeat(contentBytes),
      },
      tool_use_id: 'write-1',
    };
  }

  async function recordingHook(
    received: unknown[],
  ): Promise<CursorHookTransport> {
    const started = await createCursorHookTransport(
      (payload): Promise<CursorHookOutcome> => {
        received.push(payload);
        return Promise.resolve({ decision: 'allow' });
      },
      () => {},
    );
    hook = started;
    return started;
  }

  it('delivers a whole-file Write larger than 64 KiB to policy', async (): Promise<void> => {
    const received: unknown[] = [];
    const transport = await recordingHook(received);
    const payload = writePayload(4 * 1024 * 1024);
    expect(await post(transport, payload)).toEqual({
      status: 200,
      body: { permission: 'allow' },
    });
    expect(await runStandaloneHook(transport, payload)).toEqual({
      permission: 'allow',
    });
    expect(received).toEqual([payload, payload]);
  });

  it('denies a request over the bound before it reaches policy', async (): Promise<void> => {
    const received: unknown[] = [];
    const transport = await recordingHook(received);
    expect(
      await runStandaloneHook(transport, writePayload(8 * 1024 * 1024)),
    ).toEqual({ permission: 'deny' });
    expect(received).toEqual([]);
  });

  it('preserves policy denial for a large whole-file Write', async (): Promise<void> => {
    const payload = writePayload(256 * 1024);
    const authorize = jest.fn(
      (): Promise<CursorHookOutcome> =>
        Promise.resolve({
          decision: 'deny',
          message: 'Write denied by workspace policy.',
        }),
    );
    hook = await createCursorHookTransport(authorize, () => {});
    expect(await runStandaloneHook(hook, payload)).toMatchObject({
      permission: 'deny',
      user_message: 'Write denied by workspace policy.',
    });
    expect(authorize).toHaveBeenCalledWith(payload);
  });

  it.each([64 * 1024, 8 * 1024 * 1024])(
    'flushes a direct callback rejection with a %i-byte bound',
    async (maxRequestBytes): Promise<void> => {
      const received: unknown[] = [];
      hook = await createCursorHookTransport(
        (payload): Promise<CursorHookOutcome> => {
          received.push(payload);
          return Promise.resolve({ decision: 'allow' });
        },
        () => {},
        { maxRequestBytes },
      );
      await expect(
        post(hook, writePayload(8 * 1024 * 1024)),
      ).resolves.toMatchObject({
        status: 413,
        body: { permission: 'deny' },
      });
      expect(received).toEqual([]);
      const smallPayload = writePayload(1);
      await expect(post(hook, smallPayload)).resolves.toMatchObject({
        status: 200,
        body: { permission: 'allow' },
      });
      expect(received).toEqual([smallPayload]);
    },
  );
});

// The Cursor runtime on Windows prefixes hook stdin with a UTF-8 byte-order
// mark. Strict JSON parsing rejects it, which denied every tool call and then
// stopped the session for running a tool the approval hook never observed.
describe('Cursor hook input with a UTF-8 byte-order mark', () => {
  let hook: CursorHookTransport | undefined;
  afterEach(async (): Promise<void> => {
    await hook?.close();
    hook = undefined;
  });

  async function recordingHook(
    received: unknown[],
  ): Promise<CursorHookTransport> {
    const started = await createCursorHookTransport(
      (payload): Promise<CursorHookOutcome> => {
        received.push(payload);
        return Promise.resolve({ decision: 'allow' });
      },
      () => {},
    );
    hook = started;
    return started;
  }

  it('delivers a callback request that starts with a byte-order mark to policy', async (): Promise<void> => {
    const received: unknown[] = [];
    const transport = await recordingHook(received);
    expect(await post(transport, withByteOrderMark(shellPayload))).toEqual({
      status: 200,
      body: { permission: 'allow' },
    });
    expect(received).toEqual([shellPayload]);
  });

  it('delivers standalone hook stdin that starts with a byte-order mark to policy', async (): Promise<void> => {
    const received: unknown[] = [];
    const transport = await recordingHook(received);
    expect(
      await runStandaloneHook(transport, withByteOrderMark(shellPayload)),
    ).toEqual({ permission: 'allow' });
    expect(received).toEqual([shellPayload]);
  });

  it('still denies input that is not JSON after the byte-order mark', async (): Promise<void> => {
    const received: unknown[] = [];
    const transport = await recordingHook(received);
    const malformed = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"tool_name":'),
    ]);
    expect((await post(transport, malformed)).body).toMatchObject({
      permission: 'deny',
    });
    expect(await runStandaloneHook(transport, malformed)).toEqual({
      permission: 'deny',
    });
    expect(received).toEqual([]);
  });
});

describe('Cursor response usage hook', () => {
  const payload = {
    hook_event_name: 'afterAgentResponse',
    conversation_id: 'cursor-session',
    input_tokens: 12000,
    output_tokens: 800,
    cache_read_tokens: 9000,
    cache_write_tokens: 500,
  };

  it('reports only valid counters for the active conversation and cannot authorize tools', async () => {
    const reports: CursorReportedUsage[] = [];
    const hook = await createCursorUsageHook(
      () => 'cursor-session',
      (usage) => reports.push(usage),
    );
    try {
      await post(hook, { ...payload, conversation_id: 'another-chat' });
      await post(hook, { ...payload, input_tokens: -1 });
      await post(hook, { ...payload, input_tokens: 1.5 });
      await post(hook, { ...payload, input_tokens: undefined });
      await post(hook, { ...payload, cache_read_tokens: 13000 });
      await post(hook, { ...payload, hook_event_name: 'preToolUse' });
      expect(reports).toEqual([]);
      await post(hook, payload);
      expect(reports).toEqual([
        {
          inputTokens: 12000,
          outputTokens: 800,
          cacheReadTokens: 9000,
          cacheWriteTokens: 500,
        },
      ]);
      await post(hook, {
        hook_event_name: 'afterAgentResponse',
        conversation_id: 'cursor-session',
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(reports[1]).toEqual({ inputTokens: 0, outputTokens: 0 });
    } finally {
      await hook.close();
    }
  });

  it('keeps the usage callback bounded to 64 KiB', async () => {
    const reports: CursorReportedUsage[] = [];
    const hook = await createCursorUsageHook(
      () => 'cursor-session',
      (usage) => reports.push(usage),
    );
    try {
      await post(hook, { ...payload, padding: 'x'.repeat(64 * 1024) }).catch(
        () => undefined,
      );
      expect(reports).toEqual([]);
    } finally {
      await hook.close();
    }
  });

  it('waits for an asynchronous usage admission before acknowledging the hook', async () => {
    let releaseAdmission = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let reportStarted = (): void => undefined;
    const reported = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const hook = await createCursorUsageHook(
      () => 'cursor-session',
      () => {
        reportStarted();
        return admission;
      },
    );
    const response = post(hook, payload);
    let settled = false;
    void response.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await reported;
      // A later request/response through this hook server establishes that
      // it is processing sockets while the first report receipt stays held.
      await expect(
        post(hook, { ...payload, conversation_id: 'another-chat' }),
      ).resolves.toMatchObject({ status: 200 });
      // Let the local HTTP response complete if the hook returns without
      // awaiting the report. One event-loop turn alone can precede socket I/O.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      releaseAdmission();
      await expect(response).resolves.toMatchObject({ status: 200 });
    } finally {
      releaseAdmission();
      await hook.close();
    }
  });

  it('strips response text before the bounded callback and returns no approval decision', async () => {
    const received: unknown[] = [];
    const hook = await createCursorHookTransport(
      (data) => {
        received.push(data);
        return Promise.resolve({ decision: 'allow' });
      },
      () => {},
    );
    try {
      const response = await runStandaloneHook(
        hook,
        {
          ...payload,
          text: 'private response '.repeat(6000),
          user_email: 'private@example.test',
        },
        CURSOR_USAGE_HOOK_SCRIPT,
      );
      expect(response).toEqual({});
      expect(received).toEqual([payload]);
    } finally {
      await hook.close();
    }
  });

  it('reports usage from standalone hook stdin that starts with a byte-order mark', async () => {
    const received: unknown[] = [];
    const hook = await createCursorHookTransport(
      (data) => {
        received.push(data);
        return Promise.resolve({ decision: 'allow' });
      },
      () => {},
    );
    try {
      expect(
        await runStandaloneHook(
          hook,
          withByteOrderMark(payload),
          CURSOR_USAGE_HOOK_SCRIPT,
        ),
      ).toEqual({});
      expect(received).toEqual([payload]);
    } finally {
      await hook.close();
    }
  });
});
