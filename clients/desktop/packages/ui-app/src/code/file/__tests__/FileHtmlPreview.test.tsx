/** @jest-environment jsdom */
import { buildSearchableHtmlSrcDoc } from '../html-preview-search';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildSandboxedHtmlSrcDoc,
  FileHtmlPreview,
  HTML_FILE_PREVIEW_CSP,
} from '../FileHtmlPreview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function settleAction(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

describe('FileHtmlPreview', () => {
  it('limits embedded image nodes and the serialized data URL budget', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const image = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`;
    const resolveAssetSrc = jest.fn(() => Promise.resolve(image));
    try {
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            title="large-gallery.html"
            content={Array.from(
              { length: 8 },
              (_, index) => `<img src="./${index}.png">`,
            ).join('')}
            resolveAssetSrc={resolveAssetSrc}
          />,
        ),
      );
      const srcdoc = container.querySelector('iframe')?.srcdoc ?? '';
      expect(srcdoc.length).toBeLessThan(17 * 1024 * 1024);
      expect(resolveAssetSrc.mock.calls.length).toBeLessThanOrEqual(7);
      expect(srcdoc.match(/src="data:image\/png;base64,/g)).toHaveLength(3);

      resolveAssetSrc.mockClear();
      resolveAssetSrc.mockResolvedValue('data:image/png;base64,YQ==');
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            title="small-gallery.html"
            content={Array.from(
              { length: 100 },
              (_, index) => `<img src="./tiny-${index}.png">`,
            ).join('')}
            resolveAssetSrc={resolveAssetSrc}
          />,
        ),
      );
      const bounded = new DOMParser().parseFromString(
        container.querySelector('iframe')?.srcdoc ?? '',
        'text/html',
      );
      expect(
        Array.from(bounded.images).filter((node) =>
          node.src.startsWith('data:'),
        ).length,
      ).toBeLessThanOrEqual(64);
      expect(resolveAssetSrc.mock.calls.length).toBeLessThanOrEqual(64);
    } finally {
      await settleAction(() => root.unmount());
    }
  }, 15_000);

  it('reads a canonical image once for many authored path aliases', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const read = jest.fn(() => Promise.resolve('data:image/png;base64,YQ=='));
    const resolveHtmlAsset = jest.fn(() =>
      Promise.resolve({ identity: 'canonical-image', read }),
    );
    try {
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            {...{
              title: 'alias-gallery.html',
              content: Array.from(
                { length: 100 },
                (_, index) => `<img src="./image.png?alias=${index}">`,
              ).join(''),
              resolveHtmlAsset,
            }}
          />,
        ),
      );
      expect(read).toHaveBeenCalledTimes(1);
      const parsed = new DOMParser().parseFromString(
        container.querySelector('iframe')?.srcdoc ?? '',
        'text/html',
      );
      expect(
        Array.from(parsed.images).filter((node) =>
          node.src.startsWith('data:'),
        ),
      ).toHaveLength(64);
      expect(resolveHtmlAsset).toHaveBeenCalledTimes(64);
    } finally {
      await settleAction(() => root.unmount());
    }
  });

  it('bounds reads and stops requesting stale gallery assets', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let release: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const resolveAssetSrc = jest.fn(() => pending);
    try {
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            title="gallery.html"
            content={Array.from(
              { length: 8 },
              (_, index) => `<img src="assets/${index}.png">`,
            ).join('')}
            resolveAssetSrc={resolveAssetSrc}
          />,
        ),
      );
      expect(resolveAssetSrc.mock.calls).toHaveLength(4);
      expect(resolveAssetSrc).toHaveBeenCalledWith('./assets/0.png');
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            title="plain.html"
            content="<p>New file</p>"
            resolveAssetSrc={resolveAssetSrc}
          />,
        ),
      );
      await settleAction(() => release('data:image/png;base64,cGl4ZWw='));
      expect(resolveAssetSrc.mock.calls).toHaveLength(4);
      expect(container.querySelector('iframe')?.srcdoc).toContain('New file');
      expect(container.querySelector('iframe')?.srcdoc).not.toContain(
        'data:image/png',
      );
    } finally {
      await settleAction(() => root.unmount());
    }
  });

  it('resolves only authored relative sources and keeps responsive fallbacks local', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const resolveAssetSrc = jest.fn((src: string) => {
      if (src === './missing.png') throw new Error('missing');
      if (src === './untrusted.png')
        return Promise.resolve('https://example.invalid/image.png');
      return Promise.resolve('data:image/png;base64,cGl4ZWw=');
    });
    try {
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            title="gallery.html"
            content={`<base href="https://example.invalid/"><picture><source srcset="./large.png 2x"><img id="local" src="../capture.png" srcset="./large.png 2x"></picture>
          <img id="missing" src="./missing.png"><img id="untrusted" src="./untrusted.png">
          <img src="https://example.invalid/image.png"><img src="/private/image.png"><img src="file:///private/image.png"><img src="data:image/png;base64,YQ=="><img src="#fragment"><img src="\\\\server\\image.png">`}
            resolveAssetSrc={resolveAssetSrc}
          />,
        ),
      );
      expect(resolveAssetSrc.mock.calls.map(([src]) => src)).toEqual([
        '../capture.png',
        './missing.png',
        './untrusted.png',
      ]);
      const parsed = new DOMParser().parseFromString(
        container.querySelector('iframe')?.srcdoc ?? '',
        'text/html',
      );
      expect(parsed.querySelector('#local')?.getAttribute('src')).toBe(
        'data:image/png;base64,cGl4ZWw=',
      );
      expect(parsed.querySelector('#local')?.hasAttribute('srcset')).toBe(
        false,
      );
      expect(parsed.querySelector('source')?.hasAttribute('srcset')).toBe(
        false,
      );
      expect(parsed.querySelector('#missing')?.getAttribute('src')).toBe(
        './missing.png',
      );
      expect(parsed.querySelector('#untrusted')?.getAttribute('src')).toBe(
        './untrusted.png',
      );
      expect(parsed.querySelector('base')).toBeNull();
    } finally {
      await settleAction(() => root.unmount());
    }
  });

  it('ignores asset reads that finish after the file changes', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let finishOld: (value: string) => void = () => {};
    const oldRead = new Promise<string>((resolve) => {
      finishOld = resolve;
    });
    const resolveAssetSrc = jest.fn((src: string) =>
      src === './old.png'
        ? oldRead
        : Promise.resolve('data:image/png;base64,bmV3'),
    );
    try {
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            content='<img src="./old.png">'
            title="old.html"
            resolveAssetSrc={resolveAssetSrc}
          />,
        ),
      );
      await settleAction(() =>
        root.render(
          <FileHtmlPreview
            content='<img src="./new.png">'
            title="new.html"
            resolveAssetSrc={resolveAssetSrc}
          />,
        ),
      );
      await settleAction(() => finishOld('data:image/png;base64,b2xk'));
      const srcDoc = container.querySelector('iframe')?.srcdoc;
      expect(srcDoc).toContain('data:image/png;base64,bmV3');
      expect(srcDoc).not.toContain('b2xk');
      expect(container.querySelector('iframe')?.title).toBe('new.html');
    } finally {
      await settleAction(() => root.unmount());
    }
  });

  it('embeds authorized relative images without granting file or network access', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const resolveAssetSrc = jest.fn(() =>
      Promise.resolve('data:image/png;base64,cGl4ZWw='),
    );
    try {
      await settleAction(() => {
        root.render(
          <FileHtmlPreview
            {...{
              title: 'report.html',
              content: '<img src="./capture.png"><img src="./capture.png">',
              resolveAssetSrc,
            }}
          />,
        );
      });
      expect(resolveAssetSrc).toHaveBeenCalledTimes(1);
      expect(resolveAssetSrc).toHaveBeenCalledWith('./capture.png');
      const frame = container.querySelector('iframe');
      const parsed = new DOMParser().parseFromString(
        frame?.srcdoc ?? '',
        'text/html',
      );
      expect(
        Array.from(parsed.images, (image) => image.getAttribute('src')),
      ).toEqual([
        'data:image/png;base64,cGl4ZWw=',
        'data:image/png;base64,cGl4ZWw=',
      ]);
      expect(frame?.getAttribute('sandbox')).toBe('');
      expect(parsed.querySelector('meta')?.content).toContain(
        'img-src data: blob:',
      );
    } finally {
      await settleAction(() => root.unmount());
    }
  });

  it('uses an opaque script-disabled sandbox with a restrictive CSP', () => {
    const markup = renderToStaticMarkup(
      <FileHtmlPreview
        title="report.html"
        content="<script>ready()</script>"
      />,
    );
    expect(markup).toContain('sandbox=""');
    expect(markup).not.toContain('allow-scripts');
    expect(markup).toContain('data-testid="html-file-preview-frame"');
    expect(markup).toContain('default-src &#x27;none&#x27;');
    expect(markup).toContain('script-src &#x27;none&#x27;');
    expect(markup).toContain('connect-src &#x27;none&#x27;');
  });

  it('blocks the preview frame from session replay', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <FileHtmlPreview title="report.html" content="<p>Private report</p>" />,
    );
    const frame = container.querySelector(
      '[data-testid="html-file-preview-frame"]',
    );
    expect(frame?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('removes meta refresh without changing literal script content', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<script>const sample = `<meta http-equiv="refresh">`</script><meta content="0 > url" http-equiv=" refresh "><p>Ready</p>',
    );
    expect(srcDoc).toContain('const sample = `<meta http-equiv="refresh">`');
    expect(srcDoc).not.toContain('content="0 > url"');
    expect(srcDoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${HTML_FILE_PREVIEW_CSP}">`,
    );
  });
});

describe('buildSandboxedHtmlSrcDoc', () => {
  function expectCspFirst(srcDoc: string): void {
    expect(srcDoc.startsWith('<!doctype html>\n<meta')).toBe(true);
    expect(srcDoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${HTML_FILE_PREVIEW_CSP}">`,
    );
    const scriptIndex = srcDoc.indexOf('<script>');
    if (scriptIndex !== -1) {
      expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(
        scriptIndex,
      );
    }
  }

  it('places the CSP before an existing head tag', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<!doctype html><html><head><title>Report</title></head><body></body></html>',
    );
    expectCspFirst(srcDoc);
    expect(srcDoc).toContain('<title>Report</title>');
  });

  it('places the CSP before scripts when the document has no head', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<html><body><script>window.ready = true;</script></body></html>',
    );
    expectCspFirst(srcDoc);
    expect(srcDoc).toContain('<script>window.ready = true;</script>');
  });

  it('normalizes the doctype and keeps the CSP before markup', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<!doctype html><title>Report</title><script>window.ready = true;</script>',
    );
    expectCspFirst(srcDoc);
    expect(srcDoc.match(/<!doctype html>/gi)).toHaveLength(1);
  });

  it('does not let a fake head in a leading comment intercept the CSP', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<!-- <head> --><script>window.ready = true;</script><head><title>Report</title></head>',
    );
    expectCspFirst(srcDoc);
    expect(srcDoc).toContain('<!-- <head> -->');
  });

  it('removes meta refresh directives before rendering', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<html><head><meta http-equiv=" refresh " content="0; url=https://example.invalid/leak"><title>Report</title></head><body>Ready</body></html>',
    );
    expect(srcDoc).not.toContain('example.invalid');
    expect(srcDoc).toContain('<body>Ready</body>');
  });

  it('preserves literal meta refresh text inside scripts', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<script>const literal = `<meta http-equiv="refresh" content="0; url=https://example.invalid/script">`;</script><meta http-equiv="refresh" content="0; url=https://example.invalid/actual">',
    );
    expect(srcDoc).toContain('https://example.invalid/script');
    expect(srcDoc).not.toContain('https://example.invalid/actual');
  });

  it('does not treat scriptable as a script closing tag', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<script>const literal = "</scriptable><meta http-equiv=refresh>";</script><meta http-equiv=refresh content="0; url=actual">',
    );
    expect(srcDoc).toContain('</scriptable><meta http-equiv=refresh>');
    expect(srcDoc).not.toContain('url=actual');
  });

  it('removes refresh directives with quoted angle brackets', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(
      '<meta content="0 > https://example.invalid/leak" http-equiv="refresh"><title>Report</title>',
    );
    expect(srcDoc).not.toContain('example.invalid');
    expect(srcDoc).toContain('<title>Report</title>');
  });
});

describe('searchable HTML isolation', () => {
  it('reuses the host page nonce for the inherited parent policy', () => {
    const hostScript = document.createElement('script');
    hostScript.nonce = 'host-page-nonce';
    document.head.append(hostScript);
    try {
      const parsed = new DOMParser().parseFromString(
        buildSearchableHtmlSrcDoc('<p>Orchid</p>'),
        'text/html',
      );
      expect(parsed.querySelector('script')?.nonce).toBe('host-page-nonce');
      expect(parsed.querySelector('meta')?.content).toContain(
        "script-src 'nonce-host-page-nonce'",
      );
    } finally {
      hostScript.remove();
    }
  });

  it('removes scripting-mode parser differentials and navigation targets', () => {
    const input = `<noscript><style></noscript><meta http-equiv="refresh" content="0;url=https://attacker.example/leak"></style></noscript>
      <map><area href="https://attacker.example/navigation"></map>
      <div><template shadowrootmode="open"><a href="https://attacker.example/shadow">Shadow link</a></template></div>
      <form action="https://attacker.example/form"><button formaction="https://attacker.example/button">Go</button></form>`;
    const srcDoc = buildSearchableHtmlSrcDoc(input);
    const parsed = new DOMParser().parseFromString(srcDoc, 'text/html');

    expect(srcDoc).not.toContain('attacker.example');
    expect(parsed.querySelector('noscript')).toBeNull();
    expect(parsed.querySelector('template[shadowrootmode]')).toBeNull();
    expect(parsed.querySelector('area')?.hasAttribute('href')).toBe(false);
    expect(parsed.querySelector('form')?.hasAttribute('action')).toBe(false);
    expect(parsed.querySelector('button')?.hasAttribute('formaction')).toBe(
      false,
    );
  });

  it('allows only a fresh application bridge nonce and strips file-authored execution', () => {
    const input = `<meta http-equiv="Content-Security-Policy" content="script-src * 'unsafe-inline'">
      <meta http-equiv="refresh" content="0;url=https://example.invalid">
      <script nonce="chosen">window.fileScriptRan = true</script>
      <iframe srcdoc="<script>parent.attack()</script>"></iframe>
      <p nonce="chosen" onclick="attack()">Orchid</p>
      <style>p { color: blue }</style>`;
    const first = new DOMParser().parseFromString(
      buildSearchableHtmlSrcDoc(input),
      'text/html',
    );
    const second = new DOMParser().parseFromString(
      buildSearchableHtmlSrcDoc(input),
      'text/html',
    );
    expect(first.querySelectorAll('script')).toHaveLength(1);
    const bridge = first.querySelector('script');
    const nonce = bridge?.getAttribute('nonce');
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(nonce).not.toBe(
      second.querySelector('script')?.getAttribute('nonce'),
    );
    expect(first.querySelector('meta')?.getAttribute('content')).toContain(
      `script-src 'nonce-${nonce}'`,
    );
    expect(first.querySelector('meta')?.getAttribute('content')).toContain(
      "script-src-attr 'none'",
    );
    expect(first.querySelectorAll('meta')).toHaveLength(1);
    expect(first.querySelector('iframe')).toBeNull();
    expect(first.querySelector('p')?.getAttribute('onclick')).toBeNull();
    expect(first.querySelector('p')?.getAttribute('nonce')).toBeNull();
    expect(first.querySelector('p')?.textContent).toBe('Orchid');
    expect(bridge?.textContent).not.toContain('fileScriptRan');
    expect(
      Array.from(
        first.querySelectorAll('style'),
        (style) => style.textContent,
      ).join(''),
    ).toContain('color: blue');
  });

  it('requires a per-document bridge token before the parent sends search queries', () => {
    const srcDoc = buildSearchableHtmlSrcDoc(
      '<p>Orchid</p>',
      'known-preview-bridge-token',
    );

    expect(srcDoc).toContain('preview-search-ready');
    expect(srcDoc).toContain('known-preview-bridge-token');
  });
});
