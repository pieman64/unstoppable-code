import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal } from '@xterm/xterm';

type LinkHandler = NonNullable<Terminal['options']['linkHandler']>;

interface InstalledHandler {
  previous: Terminal['options']['linkHandler'];
  disposed: boolean;
}

// Retain disposed ancestors while a newer pane still points at them.
const installedHandlers = new WeakMap<LinkHandler, InstalledHandler>();

/** Wire both printed URLs and OSC 8 hyperlinks to the host's browser action. */
export function installTerminalLinks(
  term: Terminal,
  openLink?: (url: string) => void,
): () => void {
  const activate = (url: string): void => {
    // xterm's printed-link provider recognizes only HTTP(S) URLs, but OSC 8
    // targets can be scheme-less. Restrict defaults to familiar web hosts.
    const normalized =
      /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url)
        ? `http://${url}`
        : /^www\.[^\s/?#]+(?:[/?#]|$)/i.test(url)
          ? `https://${url}`
          : url;
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    if (openLink) {
      openLink(parsed.href);
    } else {
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
    }
  };

  const previousHandler = term.options.linkHandler;
  const handler: LinkHandler = {
    activate: (_event, url): void => activate(url),
    allowNonHttpProtocols: true,
  };
  const installation: InstalledHandler = {
    previous: previousHandler,
    disposed: false,
  };
  installedHandlers.set(handler, installation);
  term.options.linkHandler = handler;
  const webLinks = new WebLinksAddon((_event, url): void => activate(url));
  term.loadAddon(webLinks);
  return (): void => {
    if (installation.disposed) return;
    installation.disposed = true;
    webLinks.dispose();
    if (term.options.linkHandler !== handler) return;
    let previous = installation.previous;
    while (previous && installedHandlers.get(previous)?.disposed) {
      previous = installedHandlers.get(previous)?.previous;
    }
    term.options.linkHandler = previous;
  };
}
