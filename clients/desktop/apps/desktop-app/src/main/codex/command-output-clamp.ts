import { BRAND } from '@canopy/brand/current';
import { clampOutputTail } from '@canopy/desktop-shared/lib/output-append';

/** Codex command output kept per item: the newest characters. */
export const MAX_CODEX_COMMAND_OUTPUT_CHARS = 256 * 1024;

/** Put in front of a command output once its oldest characters were dropped. */
export const CODEX_COMMAND_OUTPUT_TRUNCATION_NOTICE = `[${BRAND.displayName} truncated earlier command output to keep the app responsive.]\n`;

/**
 * The output main keeps and emits for a Codex command. `chat:event` delivery
 * encodes outputs clamped by it as appends behind the same notice.
 */
export function clampCodexCommandOutput(output: string): string {
  return clampOutputTail(
    output,
    MAX_CODEX_COMMAND_OUTPUT_CHARS,
    CODEX_COMMAND_OUTPUT_TRUNCATION_NOTICE,
  );
}
