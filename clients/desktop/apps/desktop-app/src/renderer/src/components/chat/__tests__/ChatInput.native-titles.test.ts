/**
 * Source-level guard for CAN-2799: `ChatInput.tsx` is too store/IPC-bound to
 * mount in jsdom, so this scans its JSX for native `title=` attributes on
 * `<button>` elements. Native title tooltips lag noticeably on macOS; composer
 * hover help must come from the rich `Tooltip` / `ActionTooltip` components,
 * which open on mouseenter/focus. Component props named `title` (e.g.
 * `ConfirmDialog`, `SlashCommandMenu`) are unaffected and intentionally not
 * matched.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const CHAT_INPUT_SOURCE = readFileSync(
  join(__dirname, '..', 'ChatInput.tsx'),
  'utf8',
);
// The trailing send / stop / run control lives in its own component.
const SEND_BUTTON_SOURCE = readFileSync(
  join(__dirname, '..', 'ComposerSendButton.tsx'),
  'utf8',
);
// Its terminal run button is the shared one in ui-shared.
const TERMINAL_MODE_SOURCE = readFileSync(
  join(
    __dirname,
    '../../../../../../../../packages/ui-shared/src/components/TerminalComposerMode.tsx',
  ),
  'utf8',
);
// So does the scheduled-send chip beside +.
const SCHEDULED_CHIP_SOURCE = readFileSync(
  join(__dirname, '..', 'ScheduledSendChip.tsx'),
  'utf8',
);

function nativeButtonTitles(source: string): string[] {
  const offenders: string[] = [];
  const buttonOpenTag = /<button\b[^>]*>/gs;
  let match: RegExpExecArray | null = buttonOpenTag.exec(source);
  while (match !== null) {
    const tag: string = match[0];
    if (/\btitle=/.test(tag)) {
      offenders.push(tag.replace(/\s+/g, ' ').slice(0, 120));
    }
    match = buttonOpenTag.exec(source);
  }
  return offenders;
}

describe('ChatInput native title attributes', () => {
  it('renders no native title on any composer button', () => {
    expect(nativeButtonTitles(CHAT_INPUT_SOURCE)).toEqual([]);
    expect(nativeButtonTitles(SEND_BUTTON_SOURCE)).toEqual([]);
    expect(nativeButtonTitles(TERMINAL_MODE_SOURCE)).toEqual([]);
    expect(nativeButtonTitles(SCHEDULED_CHIP_SOURCE)).toEqual([]);
  });

  it('wraps the composer action buttons in rich tooltips', () => {
    // The resource-guard notice's settings link is a labelled `Button`
    // ("Open performance settings") inside the shared `Notice`, so it needs
    // no tooltip and is deliberately absent from this list.
    for (const label of ['Stop generation', 'Send message']) {
      expect(SEND_BUTTON_SOURCE).toContain(label);
    }
    expect(TERMINAL_MODE_SOURCE).toContain('Run terminal command');
    expect(TERMINAL_MODE_SOURCE).toMatch(/<Tooltip\b/);
    expect(SEND_BUTTON_SOURCE).toMatch(/<Tooltip\b/);
    expect(SCHEDULED_CHIP_SOURCE).toMatch(/<RichHoverTooltip\b/);
    expect(SCHEDULED_CHIP_SOURCE).toContain('Click to change.');
  });
});
