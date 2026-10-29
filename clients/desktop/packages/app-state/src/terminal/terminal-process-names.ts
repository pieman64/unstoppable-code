const SHELL_PROCESS_NAMES = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'cmd',
  'pwsh',
  'powershell',
]);

function normalizeTerminalProcessName(processName: string): string {
  return processName
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
}

export function isShellProcessName(processName: string | null): boolean {
  if (processName === null) return false;
  return SHELL_PROCESS_NAMES.has(normalizeTerminalProcessName(processName));
}
