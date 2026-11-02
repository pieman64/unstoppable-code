import type { Terminal } from '@xterm/xterm';
import { installTerminalLinks } from '../terminal-links';

jest.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
}));

function makeTerminal(
  previousHandler?: Terminal['options']['linkHandler'],
): Terminal & { loadAddon: jest.Mock<void, [unknown]> } {
  const term = {
    options: { linkHandler: previousHandler },
    loadAddon: jest.fn<void, [unknown]>(),
  } as unknown as Terminal & { loadAddon: jest.Mock<void, [unknown]> };
  return term;
}

function activateOscLink(term: Terminal, url: string): void {
  term.options.linkHandler?.activate({} as MouseEvent, url, {
    start: { x: 1, y: 1 },
    end: { x: 1, y: 1 },
  });
}

describe('installTerminalLinks', () => {
  it('opens HTTP(S) links and blocks other schemes', () => {
    const term = makeTerminal();
    const openLink = jest.fn();
    const dispose = installTerminalLinks(term, openLink);

    activateOscLink(term, 'https://example.com/help');
    activateOscLink(term, 'http://localhost:3000/path');
    activateOscLink(term, 'file:///etc/passwd');
    activateOscLink(term, 'javascript:alert(1)');

    expect(openLink).toHaveBeenCalledTimes(2);
    expect(openLink).toHaveBeenNthCalledWith(1, 'https://example.com/help');
    expect(openLink).toHaveBeenNthCalledWith(2, 'http://localhost:3000/path');
    dispose();
  });

  it('normalizes supported scheme-less OSC 8 links', () => {
    const term = makeTerminal();
    const openLink = jest.fn();
    const dispose = installTerminalLinks(term, openLink);

    expect(term.options.linkHandler?.allowNonHttpProtocols).toBe(true);

    activateOscLink(term, 'localhost:3000/path');
    activateOscLink(term, 'www.example.com/help');

    expect(openLink).toHaveBeenNthCalledWith(1, 'http://localhost:3000/path');
    expect(openLink).toHaveBeenNthCalledWith(2, 'https://www.example.com/help');
    dispose();
  });

  it('opens links in a new browser tab when the host supplies no callback', () => {
    const term = makeTerminal();
    const open = jest.fn();
    // This suite runs in node, which has no `window`; restore whatever was
    // there so a jsdom environment keeps its own.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: { open },
      configurable: true,
    });
    try {
      const dispose = installTerminalLinks(term);

      activateOscLink(term, 'https://example.com/help');
      activateOscLink(term, 'file:///etc/passwd');

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(
        'https://example.com/help',
        '_blank',
        'noopener,noreferrer',
      );
      dispose();
    } finally {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('restores the previous handler on disposal', () => {
    const previous = { activate: jest.fn() };
    const term = makeTerminal(previous);
    const dispose = installTerminalLinks(term, jest.fn());

    expect(term.options.linkHandler).not.toBe(previous);
    dispose();

    expect(term.options.linkHandler).toBe(previous);
    const loadedAddon = term.loadAddon.mock.calls[0]?.[0] as {
      dispose: jest.Mock;
    };
    expect(loadedAddon.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the newer handler when an older pane disposes first', () => {
    const previous = { activate: jest.fn() };
    const term = makeTerminal(previous);
    const firstOpen = jest.fn();
    const secondOpen = jest.fn();
    const disposeFirst = installTerminalLinks(term, firstOpen);
    const disposeSecond = installTerminalLinks(term, secondOpen);

    disposeFirst();
    activateOscLink(term, 'https://example.com/new-pane');
    expect(secondOpen).toHaveBeenCalledWith('https://example.com/new-pane');
    expect(firstOpen).not.toHaveBeenCalled();

    disposeSecond();
    expect(term.options.linkHandler).toBe(previous);
  });
});
