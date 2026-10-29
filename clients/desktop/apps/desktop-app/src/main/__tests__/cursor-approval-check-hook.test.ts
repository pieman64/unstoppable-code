import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  createCursorCheckHook,
  CURSOR_CHECK_CONTENT,
  CURSOR_CHECK_HOOK_SCRIPT,
  type CursorCheckHook,
} from '../cursor/approval-check-hook';

function post(
  hook: CursorCheckHook,
  payload: unknown,
  token = hook.token,
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      hook.url,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
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
    req.end(JSON.stringify(payload));
  });
}

function payload(
  toolName = 'Write',
  filePath = '/tmp/cursor-fixture/result.txt',
): unknown {
  return {
    hook_event_name: 'preToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath, content: CURSOR_CHECK_CONTENT },
    tool_use_id: 'same-read-and-write-id',
  };
}

describe('Cursor check hook', () => {
  const check = jest.fn<
    ReturnType<ApprovalSessionHandle['check']>,
    Parameters<ApprovalSessionHandle['check']>
  >();
  const invalidatePending = jest.fn();
  const dispose = jest.fn();
  const approval: ApprovalSessionHandle = {
    check,
    setMode: jest.fn(),
    invalidatePending,
    dispose,
  };
  let hook: CursorCheckHook;
  beforeEach(async (): Promise<void> => {
    jest.clearAllMocks();
    check.mockResolvedValue({ decision: 'allow' });
    hook = await createCursorCheckHook(
      approval,
      '/tmp/cursor-fixture/result.txt',
    );
  });
  afterEach(async (): Promise<void> => {
    await hook.close();
  });

  it('executes the generated standalone hook and returns parseable one-shot JSON', async (): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'cursor-generated-hook-'));
    try {
      const script = join(root, 'hook.cjs');
      const config = join(root, 'connection.json');
      await writeFile(script, CURSOR_CHECK_HOOK_SCRIPT);
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
        child.once('error', reject);
        child.once('close', (code): void => {
          if (code === 0) resolveOutput(text);
          else reject(new Error('Generated hook failed.'));
        });
        child.stdin.end(JSON.stringify(payload()));
      });
      expect(JSON.parse(output)).toEqual({ permission: 'allow' });
      expect(hook.writeDecision()).toBe('allow');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks Read and Write independently even when Cursor reuses the tool ID', async (): Promise<void> => {
    expect((await post(hook, payload('Read'))).body).toEqual({
      permission: 'allow',
    });
    check.mockResolvedValueOnce({ decision: 'deny' });
    expect((await post(hook, payload())).body).toEqual(
      expect.objectContaining({ permission: 'deny' }),
    );
    expect(check.mock.calls.map(([value]) => value)).toEqual([
      { kind: 'tool', toolName: 'Read' },
      { kind: 'file-write', path: '/tmp/cursor-fixture/result.txt' },
    ]);
    expect(hook.sawWrite()).toBe(true);
  });

  it('denies an allow that resolves after revocation', async (): Promise<void> => {
    let complete: (result: ApprovalOutcome) => void = (): void => {};
    let entered: () => void = (): void => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    check.mockImplementationOnce(
      () =>
        new Promise<ApprovalOutcome>((resolve) => {
          complete = resolve;
          entered();
        }),
    );
    const response = post(hook, payload());
    await waiting;
    hook.revoke();
    complete({ decision: 'allow' });
    expect((await response).body).toEqual(
      expect.objectContaining({ permission: 'deny' }),
    );
    expect(invalidatePending).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect((await post(hook, payload())).body).toEqual(
      expect.objectContaining({ permission: 'deny' }),
    );
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('does not consult policy for unauthenticated or out-of-scope requests', async (): Promise<void> => {
    expect((await post(hook, payload(), 'invalid')).status).toBe(403);
    for (const input of [
      payload('Shell'),
      payload('Write', '/tmp/other.txt'),
      { tool_name: 'Write' },
      payload('Read', '/etc/passwd'),
    ]) {
      expect((await post(hook, input)).body).toEqual(
        expect.objectContaining({ permission: 'deny' }),
      );
    }
    expect(check).not.toHaveBeenCalled();
  });

  it('denies callback failures and oversized payloads', async (): Promise<void> => {
    check.mockRejectedValueOnce(new Error('fixture failure'));
    expect((await post(hook, payload())).body).toEqual(
      expect.objectContaining({ permission: 'deny' }),
    );
    expect((await post(hook, { data: 'x'.repeat(70_000) })).status).toBe(413);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('revokes an approval when its hook client disconnects', async (): Promise<void> => {
    let entered: () => void = (): void => {};
    let complete: (result: ApprovalOutcome) => void = (): void => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const disposed = new Promise<void>((resolve) => {
      jest.spyOn(approval, 'dispose').mockImplementation(() => {
        resolve();
      });
    });
    check.mockImplementationOnce(
      () =>
        new Promise<ApprovalOutcome>((resolve) => {
          complete = resolve;
          entered();
        }),
    );
    const req = request(hook.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${hook.token}` },
    });
    req.on('error', (): void => {});
    req.end(JSON.stringify(payload()));
    await waiting;
    req.destroy();
    await disposed;
    complete({ decision: 'allow' });
    expect((await post(hook, payload())).body).toEqual(
      expect.objectContaining({ permission: 'deny' }),
    );
  });
});

describe('generated Cursor hook input bytes', () => {
  function forward(chunks: Buffer[]): { sent: Buffer[]; decisions: string[] } {
    const stdin = new EventEmitter();
    const sent: Buffer[] = [];
    const decisions: string[] = [];
    runInNewContext(CURSOR_CHECK_HOOK_SCRIPT, {
      Buffer,
      require: (name: string): unknown =>
        name === 'node:fs'
          ? {
              readFileSync: (): string =>
                JSON.stringify({ url: 'http://127.0.0.1/hook', token: 'test' }),
            }
          : {
              request: (): unknown =>
                Object.assign(new EventEmitter(), {
                  setTimeout: (): void => {},
                  end: (body: string | Buffer): void => {
                    sent.push(Buffer.from(body));
                  },
                }),
            },
      process: {
        argv: ['node', 'hook', 'config'],
        stdin,
        on: (): void => {},
        stdout: {
          write: (text: string): void => {
            decisions.push(text);
          },
        },
        exit: (): never => {
          throw new Error('hook finished');
        },
      },
      setTimeout: (): { unref(): void } => ({ unref: (): void => {} }),
    });
    try {
      for (const chunk of chunks) stdin.emit('data', chunk);
      stdin.emit('end');
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'hook finished')
        throw error;
    }
    return { sent, decisions };
  }

  it('preserves exact Unicode file paths, commands and content across split UTF-8 bytes', () => {
    const input = Buffer.from(
      JSON.stringify({
        tool_input: {
          file_path: '/tmp/é-日本.txt',
          command: 'echo 🦜',
          content: 'مرحبا',
        },
      }),
    );
    const result = forward(Array.from(input, (byte) => Buffer.from([byte])));
    expect(result.sent).toEqual([input]);
    expect(result.decisions).toEqual([]);
  });

  it('drops only a leading UTF-8 byte-order mark, even when split across chunks', () => {
    // The Cursor runtime on Windows writes one before the JSON. A U+FEFF
    // inside the payload is content and must reach policy unchanged.
    const json = Buffer.from(
      JSON.stringify({ tool_input: { content: 'a\uFEFFb' } }),
    );
    const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]);
    const result = forward(Array.from(input, (byte) => Buffer.from([byte])));
    expect(result.sent).toEqual([json]);
    expect(result.decisions).toEqual([]);
  });

  it('allows exactly the byte limit and denies one byte beyond it before forwarding', () => {
    const prefix = Buffer.from('{"content":"');
    const suffix = Buffer.from('"}');
    const payload = Buffer.concat([
      prefix,
      Buffer.from('é'.repeat(4_194_297)),
      suffix,
    ]);
    expect(payload.length).toBe(8 * 1024 * 1024);
    // An odd chunk size splits two-byte characters across chunks.
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < payload.length; offset += 65_537)
      chunks.push(payload.subarray(offset, offset + 65_537));
    const accepted = forward(chunks);
    expect(accepted.sent).toHaveLength(1);
    expect(accepted.sent[0].equals(payload)).toBe(true);
    const denied = forward([payload, Buffer.from(' ')]);
    expect(denied.sent).toEqual([]);
    expect(denied.decisions).toEqual(['{"permission":"deny"}\n']);
  });
});
