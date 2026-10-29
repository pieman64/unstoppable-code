/**
 * Build the `preToolUse` hook command recorded in the private `hooks.json`.
 *
 * Cursor stores this as a single string and parses it with the platform shell,
 * so the quoting has to match that shell. POSIX single-quoting is literal to
 * cmd.exe, which would leave the command unparseable on Windows — and because
 * the hook is registered `failClosed`, an unparseable command denies every tool
 * call rather than skipping the check.
 */
export function buildCursorHookCommand(
  parts: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return parts.map((part) => quoteArgument(part, platform)).join(' ');
}

/**
 * Characters double quoting does not neutralize for cmd.exe.
 *
 * Deliberately narrow. Inside a double-quoted string cmd treats `^ & | < >` as
 * literal, and those characters are legal in Windows account and folder names
 * (`C:\Users\R&D`). Both hook arguments embed the user profile path, so
 * refusing them would hard-fail every turn for real users. What genuinely
 * survives quoting is `%VAR%` expansion, an embedded `"`, and a line break.
 */
const WINDOWS_UNSAFE = /["%\r\n\0]/;

function quoteArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // Refuse loudly at session start rather than emit a command that silently
    // disables every tool call. Escaping is deliberately not attempted: cmd's
    // quoting rules differ between the command line and batch files, and this
    // path cannot be exercised from a macOS host. Name the path so the user
    // can act on it; these are their own folder names.
    if (WINDOWS_UNSAFE.test(value))
      throw new Error(
        'Cursor cannot start: a folder in its path contains a character ' +
          'Windows cannot quote safely (%, ", or a line break). Rename that ' +
          'folder to continue.',
      );
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
