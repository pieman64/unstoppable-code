/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  SettingsGroup,
  SettingsPage,
  SettingsSection,
} from '../SettingsLayout';
import { SettingsReplayPrivacyContext } from '../settings-replay-privacy';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsPage session-replay classification (CAN-3119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(element: JSX.Element): HTMLElement {
    act(() => root.render(element));
    const page = container.querySelector<HTMLElement>(
      '[data-testid="settings-page-under-test"]',
    );
    if (!page) throw new Error('SettingsPage root not rendered');
    return page;
  }

  /** The page content: the root's last child, after the header. */
  function content(page: HTMLElement): Element | null {
    return page.lastElementChild;
  }

  /** The shared settings column the page sits in. */
  function column(page: HTMLElement): Element | null {
    return page.closest('[data-testid="settings-page-column"]');
  }

  it('blocks the page content when no classification is provided (fail closed)', () => {
    const page = render(
      <SettingsPage title="General" dataTestId="settings-page-under-test">
        <p>Body</p>
      </SettingsPage>,
    );
    expect(page.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(content(page)?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      true,
    );
    expect(content(page)?.textContent).toBe('Body');
  });

  it('blocks the content of a blocked section, keeping its title recorded', () => {
    const page = render(
      <SettingsReplayPrivacyContext.Provider value="blocked">
        <SettingsPage title="Git" dataTestId="settings-page-under-test">
          <p>Body</p>
        </SettingsPage>
      </SettingsReplayPrivacyContext.Provider>,
    );
    expect(column(page)?.className).toContain('max-w-176');
    expect(content(page)?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      true,
    );
    const title = page.querySelector('h1');
    expect(title?.textContent).toBe('Git');
    expect(title?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('leaves a reviewed section recorded with its layout classes unchanged', () => {
    const page = render(
      <SettingsReplayPrivacyContext.Provider value="reviewed">
        <SettingsPage title="Display" dataTestId="settings-page-under-test" />
      </SettingsReplayPrivacyContext.Provider>,
    );
    expect(page.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(column(page)?.className).toContain('max-w-176');
    expect(content(page)?.className).toBe('flex flex-col gap-10');
  });
});

describe('SettingsGroup session-replay block (CAN-3119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('blocks only the group box when asked, keeping the section heading recorded', () => {
    act(() =>
      root.render(
        <SettingsSection title="Chats">
          <SettingsGroup blockFromReplay dataTestId="group">
            <p>Instruction text</p>
          </SettingsGroup>
        </SettingsSection>,
      ),
    );
    const group = container.querySelector('[data-testid="group"]');
    expect(group?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    expect(
      container.querySelector('h2')?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('records the group box by default', () => {
    act(() =>
      root.render(
        <SettingsGroup dataTestId="group">
          <p>Row</p>
        </SettingsGroup>,
      ),
    );
    expect(
      container.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });
});
