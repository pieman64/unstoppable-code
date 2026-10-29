import { buildClaudeTerminalHookCallbackScript } from '../integration/claude-terminal-hooks';

describe('Claude terminal hook callback', () => {
  it('fails closed for delivery, response, and transport failures', () => {
    const script = buildClaudeTerminalHookCallbackScript({
      hookUrl: 'http://127.0.0.1:3210/hooks',
    });

    expect(script).toContain('transportTimer = setTimeout');
    expect(script).toContain('}, 590000);');
    expect(script).toContain('clearTimeout(transportTimer)');
    expect(script).toContain('req.destroy()');
    expect(script).toContain("permissionDecision: 'deny'");
    expect(script).toContain('Approval service rejected the request.');
    expect(script).toContain('Approval service returned an empty response.');
    expect(script).toContain('Approval service returned an invalid response.');
    expect(script).toContain('Approval service request failed.');
    expect(script).toContain('Approval service request timed out.');
    expect(script).toContain('Approval hook failed.');
    expect(script).toContain("body.hookEventName === 'PreToolUse'");
    expect(script).toContain("process.argv[2] !== 'PreToolUse'");
  });
});
