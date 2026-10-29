/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TerminalPreset,
  TerminalShellProfile,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

const mockProfiles: TerminalShellProfile[] = [
  // A fallback profile is labeled with the login shell's basename.
  { id: 'default', label: 'my-shell', isDefault: true },
  { id: 'zsh', label: 'zsh', isDefault: false },
];

const mockPresets: TerminalPreset[] = [
  {
    id: 'preset-image',
    name: 'Deploy prod',
    terminalProfileId: 'zsh',
    command: 'ssh deploy@prod.internal',
    enabled: true,
    icon: { kind: 'image', lightDataUrl: 'data:image/png;base64,AAAA' },
  },
  {
    id: 'preset-character',
    name: 'Watch logs',
    terminalProfileId: 'default',
    command: 'tail -f /var/log/app.log',
    enabled: true,
    icon: { kind: 'character', value: 'Q' },
  },
];

jest.mock('@/lib/terminalShellProfiles', () => ({
  loadTerminalShellProfiles: (): Promise<TerminalShellProfile[]> =>
    Promise.resolve(mockProfiles),
  loadTerminalPanelPreferences: (): Promise<{
    disabledTerminalShellProfileIds: [];
    terminalPresets: TerminalPreset[];
  }> =>
    Promise.resolve({
      disabledTerminalShellProfileIds: [],
      terminalPresets: mockPresets,
    }),
  setCachedTerminalPanelPreferences: jest.fn(),
}));

import { SettingsReplayPrivacyContext } from '../settings-replay-privacy';
import { TerminalTab } from '../TerminalTab';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function replayBlocked(element: Element | null | undefined): boolean {
  return Boolean(element?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`));
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`${testId} not rendered`);
  return element;
}

describe('TerminalTab session replay (CAN-3119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      // The reviewed classification Settings gives this section, so the page
      // root itself is recorded and only the marked subtrees are blocked.
      root.render(
        <SettingsReplayPrivacyContext.Provider value="reviewed">
          <TerminalTab />
        </SettingsReplayPrivacyContext.Provider>,
      );
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('records uploaded preset images (icons) in the list and the editor', () => {
    expect(replayBlocked(byTestId('settings-tab-terminal'))).toBe(false);
    expect(replayBlocked(byTestId('terminal-preset-image-light'))).toBe(false);

    const editButton = Array.from(
      byTestId('terminal-preset-preset-image').querySelectorAll('button'),
    ).find((button) => button.textContent === 'Edit');
    act(() => editButton?.click());

    expect(replayBlocked(byTestId('terminal-preset-image-light-preview'))).toBe(
      false,
    );
    expect(replayBlocked(byTestId('terminal-preset-image-dark-preview'))).toBe(
      false,
    );
    expect(replayBlocked(byTestId('terminal-preset-editor'))).toBe(false);
  });

  it('blocks preset commands and records preset names', () => {
    const row = byTestId('terminal-preset-preset-image');
    const leaf = (text: string): Element | undefined =>
      Array.from(row.querySelectorAll('*')).find(
        (element) =>
          element.childElementCount === 0 && element.textContent === text,
      );
    expect(replayBlocked(leaf('ssh deploy@prod.internal'))).toBe(true);
    expect(replayBlocked(leaf('Deploy prod'))).toBe(false);
  });

  it('labels the login-shell fallback in rows and options', () => {
    expect(byTestId('terminal-shell-option-default').textContent).toContain(
      'my-shell',
    );
    expect(byTestId('terminal-shell-option-zsh').textContent).toContain('zsh');

    act(() => byTestId('terminal-preset-add').click());
    const options = Array.from(
      byTestId('terminal-preset-editor').querySelectorAll('option'),
    );
    expect(options.map((option) => option.textContent)).toEqual([
      'my-shell',
      'zsh',
    ]);
  });
});
