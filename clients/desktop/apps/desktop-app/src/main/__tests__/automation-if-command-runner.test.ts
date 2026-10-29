import { tmpdir } from 'node:os';
import {
  runAutomationIfCommand,
  type AutomationIfCommandResult,
} from '../automations/if-command-runner';

const baseArgs = {
  cwd: tmpdir(),
  env: {
    ...process.env,
    ZDOTDIR: '/dev/null',
  },
};
const maxStdoutBytes = 256 * 1024;

describe('runAutomationIfCommand', () => {
  it('returns run + stdout when the command exits 0', async () => {
    const result: AutomationIfCommandResult = await runAutomationIfCommand({
      command: 'node -e "process.stdout.write(\'hello world\')"',
      ...baseArgs,
    });
    expect(result.outcome).toBe('run');
    expect(result.outcome === 'run' && result.stdout).toBe('hello world');
  });

  it('does not leak stderr into the captured stdout', async () => {
    const result = await runAutomationIfCommand({
      command:
        "node -e \"process.stdout.write('out'); process.stderr.write('err')\"",
      ...baseArgs,
    });
    expect(result.outcome === 'run' && result.stdout).toBe('out');
    expect(result.outcome === 'run' && result.stderr).toBe('err');
  });

  it('returns skip with the exit code on non-zero exit', async () => {
    const result = await runAutomationIfCommand({
      command: 'node -e "process.exit(3)"',
      ...baseArgs,
    });
    expect(result.outcome).toBe('skip');
    expect(result.outcome === 'skip' && result.exitCode).toBe(3);
  });

  it('returns error on timeout', async () => {
    const result = await runAutomationIfCommand({
      command: 'node -e "setTimeout(() => {}, 5000)"',
      ...baseArgs,
      timeoutMs: 200,
    });
    expect(result.outcome).toBe('error');
    expect(result.outcome === 'error' && result.message).toMatch(/timed out/i);
  });

  it('stops the command when captured stdout reaches the byte cap', async () => {
    const startedAt = Date.now();
    const result = await runAutomationIfCommand({
      command:
        'node -e "process.stdout.write(\'x\'.repeat(300 * 1024)); setTimeout(() => {}, 5000)"',
      ...baseArgs,
      timeoutMs: 5_000,
    });

    expect(result.outcome).toBe('run');
    expect(result.outcome === 'run' && result.stdout.length).toBe(
      maxStdoutBytes,
    );
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
