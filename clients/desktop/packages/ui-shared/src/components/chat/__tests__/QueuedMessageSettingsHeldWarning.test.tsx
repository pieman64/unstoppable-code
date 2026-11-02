import { renderToStaticMarkup } from 'react-dom/server';
import {
  QUEUED_MESSAGE_SETTINGS_HELD_TITLE,
  QueuedMessageSettingsHeldWarning,
  queuedMessageSettingsHeldDescription,
} from '../QueuedMessageSettingsHeldWarning';

describe('QueuedMessageSettingsHeldWarning', () => {
  it('says what Steer and Interrupt do while new settings wait for background work', () => {
    expect(
      queuedMessageSettingsHeldDescription({ steer: true, interrupt: true }),
    ).toBe(
      'Background work is still running, and your new settings wait until it finishes. Steer adds this message to the current reply without them. Interrupt stops the reply, but this message still waits for the background work.',
    );
    expect(
      queuedMessageSettingsHeldDescription({ steer: false, interrupt: true }),
    ).toBe(
      'Background work is still running, and your new settings wait until it finishes. Interrupt stops the current reply, but this message still waits for the background work.',
    );
    expect(
      queuedMessageSettingsHeldDescription({ steer: true, interrupt: false }),
    ).toBe(
      'Background work is still running, and your new settings wait until it finishes. Steer adds this message to the current reply without them.',
    );
  });

  it('names what changed when the host says', () => {
    expect(
      queuedMessageSettingsHeldDescription({
        changes: ['model'],
        steer: false,
        interrupt: true,
      }),
    ).toBe(
      'Changed: model. Background work is still running, so these changes wait until it finishes. Interrupt stops the current reply, but this message still waits for the background work.',
    );
    expect(
      queuedMessageSettingsHeldDescription({
        changes: ['model', 'plugins', 'instructions'],
        steer: true,
        interrupt: false,
      }),
    ).toMatch(/^Changed: model, plugins and agent instructions\. /);
  });

  it('renders a focusable warning icon that carries the explanation', () => {
    const html = renderToStaticMarkup(
      <QueuedMessageSettingsHeldWarning steer interrupt={false} />,
    );
    expect(html).toContain(
      'data-testid="queued-message-settings-held-warning"',
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      `aria-label="${QUEUED_MESSAGE_SETTINGS_HELD_TITLE}"`,
    );
    expect(html).toContain(
      'aria-description="Background work is still running, and your new settings wait until it finishes. Steer adds this message to the current reply without them."',
    );
  });
});
