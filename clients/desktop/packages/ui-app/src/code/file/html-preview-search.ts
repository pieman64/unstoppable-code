import {
  createDomSearchExecutor,
  type SearchExecutor,
} from '@canopy/ui-shared/lib/dom-search-highlight';
import {
  HTML_FILE_PREVIEW_CSP,
  buildSandboxedHtmlSrcDoc,
} from '@canopy/ui-shared/lib/sandboxed-html';

/** Self-contained trusted bridge. Serialized into the opaque preview frame. */
function installPreviewSearch(
  createExecutor: typeof createDomSearchExecutor,
  bridgeToken: string,
): void {
  const executor: SearchExecutor = createExecutor(
    () => document.body,
    () => document.documentElement,
    {
      matches: 'preview-search-matches',
      active: 'preview-search-active',
      visibleOnly: true,
    },
  );
  let lastQuery = '';
  let lastCount = 0;
  window.addEventListener('message', (event: MessageEvent<unknown>): void => {
    if (event.source !== parent) return;
    const data = event.data;
    if (
      !data ||
      typeof data !== 'object' ||
      !('type' in data) ||
      data.type !== 'preview-search-query' ||
      !('query' in data) ||
      typeof data.query !== 'string' ||
      !('index' in data) ||
      typeof data.index !== 'number' ||
      !Number.isSafeInteger(data.index)
    )
      return;
    if (
      'highlightColor' in data &&
      typeof data.highlightColor === 'string' &&
      CSS.supports('color', data.highlightColor)
    ) {
      document.documentElement.style.setProperty(
        '--preview-search-color',
        data.highlightColor,
      );
    }
    if (data.query !== lastQuery) {
      lastQuery = data.query;
      lastCount = data.query.length >= 2 ? executor.findMatches(data.query) : 0;
    }
    const count = lastCount;
    if (data.query.length < 2) executor.clearHighlights();
    if (count) {
      const index = Math.max(0, Math.min(data.index, count - 1));
      executor.setActiveMatch(index);
      executor.scrollToMatch(index);
    }
    parent.postMessage(
      {
        type: 'preview-search-result',
        bridgeToken,
        query: data.query,
        count,
      },
      '*',
    );
  });
  document.addEventListener('keydown', (event): void => {
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault();
      parent.postMessage({ type: 'preview-search-open', bridgeToken }, '*');
    } else if (event.key === 'Escape') {
      executor.clearHighlights();
      lastQuery = '';
      lastCount = 0;
      parent.postMessage({ type: 'preview-search-close', bridgeToken }, '*');
    }
  });
  // Navigation-capable markup must not replace the searchable, isolated document.
  document.addEventListener('click', (event): void => {
    if (event.target instanceof Element && event.target.closest('a, area'))
      event.preventDefault();
  });
  window.addEventListener('beforeunload', (): void => {
    parent.postMessage({ type: 'preview-search-unloading', bridgeToken }, '*');
  });
  parent.postMessage({ type: 'preview-search-ready', bridgeToken }, '*');
}

/**
 * Only the fresh nonce-bearing application bridge may execute. File scripts,
 * event handlers, CSP/refresh meta tags, nested frames and nonce attributes are
 * removed before serialization. The iframe must retain its opaque origin
 * (allow-scripts ONLY, never allow-same-origin).
 */
export function buildSearchableHtmlSrcDoc(
  content: string,
  bridgeToken = crypto.randomUUID(),
): string {
  const doc = new DOMParser().parseFromString(
    buildSandboxedHtmlSrcDoc(content),
    'text/html',
  );
  doc
    .querySelectorAll(
      'script, iframe, object, embed, base, noscript, template[shadowrootmode], meta[http-equiv]',
    )
    .forEach((element) => element.remove());
  doc.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on') ||
        name === 'nonce' ||
        name === 'href' ||
        name === 'xlink:href' ||
        name === 'action' ||
        name === 'formaction' ||
        name === 'target'
      )
        element.removeAttribute(attribute.name);
    }
  });
  // srcdoc inherits the web host's CSP, so its bridge must share that nonce.
  // Desktop has no host nonce and retains the existing per-preview fallback.
  const nonce =
    document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ||
    crypto.randomUUID().replace(/-/g, '');
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = HTML_FILE_PREVIEW_CSP.replace(
    "script-src 'none'",
    `script-src 'nonce-${nonce}'; script-src-attr 'none'`,
  );
  doc.head.prepend(csp);
  const style = doc.createElement('style');
  style.textContent =
    '::highlight(preview-search-matches) { background-color: color-mix(in srgb, var(--preview-search-color, #facc15) 35%, transparent); color: inherit; } ::highlight(preview-search-active) { background-color: color-mix(in srgb, var(--preview-search-color, #facc15) 65%, transparent); }';
  doc.head.append(style);
  const script = doc.createElement('script');
  script.setAttribute('nonce', nonce);
  script.textContent = `(${installPreviewSearch.toString()})(${createDomSearchExecutor.toString()}, ${JSON.stringify(bridgeToken)});`;
  doc.body.append(script);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
