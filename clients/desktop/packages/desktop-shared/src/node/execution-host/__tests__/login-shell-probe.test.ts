import { createPortLoginShellProbe } from '../login-shell-probe';
import type { ExecutionHostPort, ExecutionProbeResult } from '../port';

function portReturning(result: ExecutionProbeResult): {
  port: ExecutionHostPort;
  probe: jest.Mock;
} {
  const probe = jest.fn(
    (): Promise<ExecutionProbeResult> => Promise.resolve(result),
  );
  return {
    port: {
      launch: (): never => {
        throw new Error('not used');
      },
      probe,
    },
    probe,
  };
}

const REQUEST = {
  file: '/bin/zsh',
  args: ['-lic', 'echo'],
  env: { PATH: '/usr/bin' },
  timeoutMs: 10_000,
  maxBuffer: 1024,
};

describe('login-shell probes over the execution host port', () => {
  it('maps a lookup onto a port probe and returns its stdout', async () => {
    const { port, probe } = portReturning({ ok: true, stdout: '/a:/b\n' });
    await expect(createPortLoginShellProbe(port)(REQUEST)).resolves.toBe(
      '/a:/b\n',
    );
    expect(probe).toHaveBeenCalledWith({
      executable: '/bin/zsh',
      args: ['-lic', 'echo'],
      environment: { PATH: '/usr/bin' },
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
  });

  it('returns undefined for a failed probe', async () => {
    const { port } = portReturning({ ok: false, reason: 'timeout' });
    await expect(
      createPortLoginShellProbe(port)(REQUEST),
    ).resolves.toBeUndefined();
  });

  it('does not probe a shell that is not fully qualified', async () => {
    const { port, probe } = portReturning({ ok: true, stdout: 'x' });
    await expect(
      createPortLoginShellProbe(port)({ ...REQUEST, file: 'zsh' }),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
