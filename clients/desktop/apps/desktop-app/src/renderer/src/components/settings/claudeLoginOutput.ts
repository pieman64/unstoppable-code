const OSC_SEQUENCE = new RegExp(
  String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`,
  'g',
);
const CSI_SEQUENCE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g');
const LOGIN_FAILURE = /login failed: [^\r\n]+/gi;

/**
 * The last `Login failed: …` line `claude auth login` printed, without
 * terminal styling. Claude Code ends a failed sign-in with this one line.
 */
export function findClaudeLoginFailure(output: string): string | null {
  const plainText = output.replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, '');
  const failures = plainText.match(LOGIN_FAILURE);
  const failure = failures?.[failures.length - 1]?.trim();
  if (!failure) return null;
  return failure.charAt(0).toUpperCase() + failure.slice(1);
}
