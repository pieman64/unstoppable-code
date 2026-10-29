import { resolveTrustedRelaySurface } from '../trusted-surface';
import type {
  DesktopAppWindow,
  DesktopIpcEvent,
} from '../../desktop-ipc-caller';

function fixture(url = 'https://app.test/index.html'): {
  event: DesktopIpcEvent;
  window: DesktopAppWindow;
} {
  const frame = { url, detached: false, isDestroyed: (): boolean => false };
  const sender = {
    id: 1,
    mainFrame: frame,
    getURL: (): string => url,
    isDestroyed: (): boolean => false,
  };
  const event: DesktopIpcEvent = { sender, senderFrame: frame };
  const window = { webContents: sender, isDestroyed: (): boolean => false };
  return { event, window };
}

describe('trusted relay surface', () => {
  test.each(['main', 'app-advisor'] as const)(
    'accepts the recovered %s main frame despite a stale detached flag',
    (surface) => {
      const { event, window } = fixture();
      event.sender.mainFrame.detached = true;
      expect(
        resolveTrustedRelaySurface(
          event,
          [{ surface, window, url: event.sender.getURL() }],
          ['core.runtime.read'],
        ).surface,
      ).toBe(surface);
    },
  );
  test.each(['main', 'app-advisor'] as const)(
    'binds %s to its tracked renderer',
    (surface) => {
      const { event, window } = fixture();
      const resolved = resolveTrustedRelaySurface(
        event,
        [{ surface, window, url: event.sender.getURL() }],
        ['core.runtime.read'],
      );
      expect(resolved.surface).toBe(surface);
      expect(resolved.caller).toMatchObject({
        principalId: `local-desktop-renderer:${surface}`,
        interfaceKind: 'desktop',
        grants: ['core.runtime.read'],
      });
    },
  );

  test('rejects an untracked sender even with the same id and URL', () => {
    const tracked = fixture();
    const foreign = fixture();
    expect(() =>
      resolveTrustedRelaySurface(
        foreign.event,
        [
          {
            surface: 'main',
            window: tracked.window,
            url: foreign.event.sender.getURL(),
          },
        ],
        [],
      ),
    ).toThrow();
  });

  test.each([
    'https://app.test/other.html',
    'https://foreign.test/index.html',
    'file:///tmp/index.html',
  ])('rejects unexpected page %s', (url) => {
    const { event, window } = fixture(url);
    expect(() =>
      resolveTrustedRelaySurface(
        event,
        [{ surface: 'main', window, url: 'https://app.test/index.html' }],
        [],
      ),
    ).toThrow();
  });

  test('does not let the advisor renderer claim the main page', () => {
    const { event, window } = fixture();
    expect(() =>
      resolveTrustedRelaySurface(
        event,
        [
          {
            surface: 'app-advisor',
            window,
            url: 'https://app.test/app-advisor.html',
          },
        ],
        [],
      ),
    ).toThrow();
  });

  test.each([
    'subframe',
    'retired-frame',
    'null-frame',
    'destroyed-frame',
    'destroyed-sender',
    'destroyed-window',
    'url-mismatch',
  ] as const)('rejects %s', (failure) => {
    const { event, window } = fixture();
    if (failure === 'subframe')
      event.senderFrame = { ...event.sender.mainFrame };
    if (failure === 'retired-frame')
      event.senderFrame = { ...event.sender.mainFrame, detached: true };
    if (failure === 'null-frame') event.senderFrame = null;
    if (failure === 'destroyed-frame')
      event.sender.mainFrame.isDestroyed = (): boolean => true;
    if (failure === 'destroyed-sender')
      event.sender.isDestroyed = (): boolean => true;
    if (failure === 'destroyed-window')
      window.isDestroyed = (): boolean => true;
    if (failure === 'url-mismatch')
      event.sender.getURL = (): string => 'https://app.test/app-advisor.html';
    expect(() =>
      resolveTrustedRelaySurface(
        event,
        [{ surface: 'main', window, url: 'https://app.test/index.html' }],
        [],
      ),
    ).toThrow();
  });

  test('accepts query and hash state on the trusted page', () => {
    const { event, window } = fixture(
      'https://app.test/app-advisor.html?surface=app-advisor#chat',
    );
    expect(
      resolveTrustedRelaySurface(
        event,
        [
          {
            surface: 'app-advisor',
            window,
            url: 'https://app.test/app-advisor.html',
          },
        ],
        [],
      ).surface,
    ).toBe('app-advisor');
  });
});
