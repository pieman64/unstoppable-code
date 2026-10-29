export type ScriptTerminalShell =
  | 'sh'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'powershell'
  | 'cmd';
/** Render arguments for the actual terminal shell; cmd cannot safely represent arbitrary tokens. */
export function renderScriptCommand(
  words: string[],
  shell: ScriptTerminalShell,
): string | null {
  if (words.some((word) => /[\0\r\n]/.test(word))) return null;
  if (shell === 'cmd') {
    if (words.some((word) => !/^[A-Za-z0-9_./:@=-]+$/.test(word))) return null;
    return words.join(' ');
  }
  const rendered = words
    .map((word, index) => {
      if (index === 0 && /^[A-Za-z0-9_-]+$/.test(word)) return word;
      if (shell === 'powershell') return `'${word.replace(/'/g, "''")}'`;
      if (shell === 'fish')
        return `'${word.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      return `'${word.replace(/'/g, "'\\''")}'`;
    })
    .join(' ');
  return shell === 'powershell' &&
    words[0] &&
    !/^[A-Za-z0-9_-]+$/.test(words[0])
    ? `& ${rendered}`
    : rendered;
}
