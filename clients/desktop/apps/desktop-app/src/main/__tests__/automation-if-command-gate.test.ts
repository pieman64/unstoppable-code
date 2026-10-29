import {
  decideIfCommandGate,
  type AutomationIfCommandResult,
} from '../automations/if-command-gate';

describe('decideIfCommandGate', () => {
  it('runs with output on exit 0', () => {
    const result: AutomationIfCommandResult = { outcome: 'run', stdout: 'v' };
    expect(decideIfCommandGate(result)).toEqual({ kind: 'run', output: 'v' });
  });

  it('skips on non-zero exit with a message', () => {
    const decision = decideIfCommandGate({ outcome: 'skip', exitCode: 2 });
    expect(decision.kind).toBe('skip');
    expect(decision.kind === 'skip' && decision.message).toMatch(/exited 2/);
  });

  it('throws-marker on error', () => {
    const decision = decideIfCommandGate({
      outcome: 'error',
      message: 'boom',
    });
    expect(decision.kind).toBe('fail');
    expect(decision.kind === 'fail' && decision.message).toMatch(/boom/);
  });
});
