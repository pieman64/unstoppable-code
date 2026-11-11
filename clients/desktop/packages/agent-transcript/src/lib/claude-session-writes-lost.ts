/**
 * Copy for Claude's `system`/`session_writes_lost` event: the CLI could not
 * save its session transcript, its ~/.claude.json changes, or both. Today the
 * CLI sends it only for `ENOSPC` (no space left) and `EDQUOT` (quota used up);
 * the SDK says more codes and kinds may come, so an unknown one names no cause.
 */
export function claudeSessionWritesLostMessage(
  data: Record<string, unknown>,
): string {
  const lost = Array.isArray(data.lost) ? data.lost : [];
  const history = lost.includes('transcript');
  const settings = lost.includes('global_config');
  const what =
    history && settings
      ? "part of Claude's session history and settings changes"
      : settings
        ? "Claude's settings changes from this session"
        : "part of Claude's session history";
  const cause =
    data.error_code === 'ENOSPC'
      ? ' because the disk is full'
      : data.error_code === 'EDQUOT'
        ? ' because the disk quota is used up'
        : '';
  const space =
    data.error_code === 'ENOSPC'
      ? 'Free up disk space'
      : data.error_code === 'EDQUOT'
        ? 'Free up space or ask for a larger quota'
        : '';
  // Settings alone never cost the conversation, so say nothing about it.
  const memory =
    settings && !history
      ? ''
      : 'if this chat continues, Claude may not remember all of the earlier conversation';
  const next = [space, memory].filter(Boolean).join('; ');
  const sentence = next ? ` ${next[0].toUpperCase()}${next.slice(1)}.` : '';
  return `Couldn't save ${what}${cause}.${sentence}`;
}
