/* eslint-disable @typescript-eslint/require-await -- fakes mirror async client commands. */
import type { TerminalSession } from '@canopy/protocol/terminal';
import {
  runCommandInTerminal,
  terminalSubmission,
  TerminalRunError,
} from '../run-command-in-terminal';

const session = { id: 't1' } as unknown as TerminalSession;

function fakeClient(overrides: {
  spawn?: () => Promise<TerminalSession>;
  write?: () => Promise<'written'>;
}): {
  client: never;
  calls: { name: string; args: unknown }[];
  command: jest.Mock;
} {
  const calls: { name: string; args: unknown }[] = [];
  const command = jest.fn(async (name: string, args: unknown) => {
    calls.push({ name, args });
    if (name === 'terminal.spawn')
      return (
        overrides.spawn ?? (async (): Promise<TerminalSession> => session)
      )();
    return (overrides.write ?? (async (): Promise<'written'> => 'written'))();
  });
  return { client: { command } as never, calls, command };
}

const spawn = { projectId: 'p', worktreeId: 'w', cols: 80, rows: 24 };

describe('runCommandInTerminal', () => {
  it('hydrates, spawns with the package directory, reveals, then writes once', async () => {
    const order: string[] = [];
    const { client, calls } = fakeClient({});
    const result = await runCommandInTerminal({
      client,
      spawn: { ...spawn, relativeCwd: 'apps/web' },
      command: 'pnpm run dev\n\n',
      hydrate: async () => {
        order.push('hydrate');
      },
      reveal: () => order.push('reveal'),
      idempotencyKey: 'k',
    });
    expect(result).toBe(session);
    expect(order).toEqual(['hydrate', 'reveal']);
    expect(calls).toEqual([
      {
        name: 'terminal.spawn',
        args: { ...spawn, relativeCwd: 'apps/web' },
      },
      {
        name: 'terminal.write',
        args: { terminalId: 't1', data: 'pnpm run dev\n', idempotencyKey: 'k' },
      },
    ]);
  });

  it('omits an empty package directory', async () => {
    const { client, calls } = fakeClient({});
    await runCommandInTerminal({
      client,
      spawn: { ...spawn, relativeCwd: '' },
      command: 'make',
    });
    expect(calls[0]?.args).toEqual(spawn);
  });

  it('writes a multiline body in a single write', async () => {
    const { client, calls } = fakeClient({});
    await runCommandInTerminal({ client, spawn, command: 'a\nb' });
    expect(calls.filter((call) => call.name === 'terminal.write')).toEqual([
      { name: 'terminal.write', args: { terminalId: 't1', data: 'a\nb\n' } },
    ]);
  });

  it.each([
    [
      'spawn',
      { spawn: (): Promise<never> => Promise.reject(new Error('no pty')) },
      1,
    ],
    [
      'write',
      { write: (): Promise<never> => Promise.reject(new Error('closed')) },
      2,
    ],
  ] as const)(
    'reports a %s failure without retrying',
    async (stage, overrides, expectedCalls) => {
      const { client, command } = fakeClient(overrides);
      const error = await runCommandInTerminal({
        client,
        spawn,
        command: 'ls',
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TerminalRunError);
      expect((error as TerminalRunError).stage).toBe(stage);
      expect(command).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it('does not write when reveal throws', async () => {
    const { client, command } = fakeClient({});
    await expect(
      runCommandInTerminal({
        client,
        spawn,
        command: 'ls',
        reveal: () => {
          throw new Error('no panel');
        },
      }),
    ).rejects.toMatchObject({ stage: 'reveal', session });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('normalizes trailing newlines to one submission', () => {
    expect(terminalSubmission('x\r\n')).toBe('x\n');
  });
});
