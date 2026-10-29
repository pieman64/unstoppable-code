import { PIPELINE_SHELL_OPTIONS } from '../pipeline-shell-options';

describe('PIPELINE_SHELL_OPTIONS', () => {
  it('lists every supported shell value', () => {
    const values = PIPELINE_SHELL_OPTIONS.map((option) => option.value);
    expect(values).toEqual([
      'bash',
      'sh',
      'pwsh',
      'powershell',
      'cmd',
      'python',
      'node',
      'tsx',
    ]);
  });

  it('includes Windows shells so users can explicitly opt in', () => {
    const values = new Set(
      PIPELINE_SHELL_OPTIONS.map((option) => option.value),
    );
    expect(values.has('pwsh')).toBe(true);
    expect(values.has('powershell')).toBe(true);
    expect(values.has('cmd')).toBe(true);
  });

  it('uses readable labels for each shell', () => {
    const labels = Object.fromEntries(
      PIPELINE_SHELL_OPTIONS.map((option) => [option.value, option.label]),
    );
    expect(labels.bash).toBe('Bash');
    expect(labels.sh).toBe('sh');
    expect(labels.pwsh).toBe('PowerShell 7');
    expect(labels.powershell).toBe('Windows PowerShell');
    expect(labels.cmd).toBe('Command Prompt');
    expect(labels.python).toBe('Python');
    expect(labels.node).toBe('Node.js');
    expect(labels.tsx).toBe('TSX');
  });
});
