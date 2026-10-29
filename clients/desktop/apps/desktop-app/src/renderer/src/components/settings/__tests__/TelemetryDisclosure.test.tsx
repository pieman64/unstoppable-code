/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { brandText } from '@/lib/brand';
import { TelemetryDisclosure } from '../TelemetryDisclosure';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('TelemetryDisclosure', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<TelemetryDisclosure />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('explains what sharing does without pre-stating the protections', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('so you can revisit and search past runs');
    // Encryption, scrubbing, and private-by-default each get their own line in
    // the protection box directly below. Summarizing them one paragraph earlier
    // made the member read the same three facts twice before reaching a control.
    expect(text).not.toContain('By default your activity syncs privately');
  });

  // CAN-3561: sent messages are counted whatever the sharing scopes are set
  // to, so the disclosure says so in one plain sentence.
  it('mentions the always-on message count as a quick aside in the intro', () => {
    const basicUsage = container.querySelector(
      '[data-testid="telemetry-disclosure-basic-usage"]',
    );
    expect(basicUsage?.textContent).toBe(
      `${brandText.appName} always counts how many messages you send.`,
    );
    // A trailing sentence of the intro, not a paragraph of its own.
    const disclosure = container.querySelector(
      '[data-testid="telemetry-disclosure"]',
    );
    const intro = disclosure?.firstElementChild;
    expect(intro?.tagName).toBe('P');
    expect(intro?.lastElementChild).toBe(basicUsage);
    expect(intro?.textContent).toBe(
      `Activity sharing syncs your agent activity to ${brandText.appName} Cloud so you can revisit and search past runs from anywhere, pick up work across machines, and share runs with your team. ${brandText.appName} always counts how many messages you send.`,
    );
    // No "never your prompts" promise: beside the sharing intro it read as a
    // claim that sharing never uploads prompts, which transcript sharing does.
    expect(disclosure?.textContent).not.toMatch(/never/i);
    expect(disclosure?.textContent).not.toMatch(/\bturns?\b/i);
    expect(disclosure?.textContent).not.toContain('—');
  });

  it('keeps the protection box as the single place the guarantees are listed', () => {
    const protection = container.querySelector(
      '[data-testid="telemetry-disclosure-protection"]',
    );
    expect(protection?.textContent).toContain('scrubbed');
    expect(protection?.textContent).toContain('encrypted');
  });
});
