import { renderToString } from 'react-dom/server';
import {
  CHAT_COMPOSER_SHELL_CLASS,
  CHAT_COMPOSER_SHELL_DRAG_CLASS,
  ChatComposerShell,
} from '../ChatComposerShell';

describe('ChatComposerShell', () => {
  it('draws the desktop composer box: raised tertiary surface, 16px radius, shadow, no border', () => {
    expect(CHAT_COMPOSER_SHELL_CLASS).toBe(
      'relative rounded-2xl bg-[var(--bg-composer,var(--bg-tertiary))] shadow-lg transition',
    );
    const html = renderToString(
      <ChatComposerShell dataTestId="composer-box">body</ChatComposerShell>,
    );
    expect(html).toContain('data-testid="composer-box"');
    expect(html).toContain(`class="${CHAT_COMPOSER_SHELL_CLASS}"`);
    expect(html).not.toContain('border-border');
    expect(html).toContain('>body<');
  });

  it('swaps to the drop wash on the same radius while a file drag hovers', () => {
    const html = renderToString(
      <ChatComposerShell dragActive dataTestId="composer-box" />,
    );
    expect(html).toContain(`class="${CHAT_COMPOSER_SHELL_DRAG_CLASS}"`);
    expect(CHAT_COMPOSER_SHELL_DRAG_CLASS).toContain('rounded-2xl');
    expect(CHAT_COMPOSER_SHELL_DRAG_CLASS).toContain('ring-line-accent');
  });

  it('appends host classes and forwards DOM attributes', () => {
    const html = renderToString(
      <ChatComposerShell className="mt-2" aria-label="Composer" />,
    );
    expect(html).toContain(`class="${CHAT_COMPOSER_SHELL_CLASS} mt-2"`);
    expect(html).toContain('aria-label="Composer"');
  });
});
