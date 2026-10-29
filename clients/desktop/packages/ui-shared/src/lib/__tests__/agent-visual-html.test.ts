/** @jest-environment jsdom */
import {
  AGENT_VISUAL_BRIDGE_SCRIPT,
  AGENT_VISUAL_CDN_HOSTS,
  AGENT_VISUAL_CSP,
  AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE,
  AGENT_VISUAL_FRAME_ALLOW,
  AGENT_VISUAL_FRAME_SANDBOX,
  AGENT_VISUAL_GESTURE_METHOD,
  AGENT_VISUAL_GESTURE_WATCH_METHOD,
  AGENT_VISUAL_HEARTBEAT_INTERVAL_MS,
  AGENT_VISUAL_HEARTBEAT_MISSES,
  AGENT_VISUAL_HELLO_METHOD,
  AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD,
  AGENT_VISUAL_OPEN_LINK_METHOD,
  AGENT_VISUAL_PING_METHOD,
  AGENT_VISUAL_PONG_METHOD,
  AGENT_VISUAL_RELAY_SCRIPT,
  AGENT_VISUAL_SIZE_CHANGED_METHOD,
  AGENT_VISUAL_STATUS_METHOD,
  AGENT_VISUAL_STRIPPED_HTTP_EQUIV,
  AGENT_VISUAL_THEME_VARIABLES,
  buildAgentVisualExportDocument,
  buildAgentVisualGestureRequest,
  buildAgentVisualGestureWatchMessage,
  buildAgentVisualHostContextMessage,
  buildAgentVisualPreviewHostDocument,
  buildAgentVisualSrcDoc,
  buildAgentVisualWrapperSrcDoc,
  clampAgentVisualHeight,
  parseAgentVisualFrameMessage,
  pickAgentVisualHeightHint,
  sanitizeAgentVisualTheme,
  type AgentVisualTheme,
} from '../agent-visual-html';

const EXPECTED_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; font-src data: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; img-src data: blob:; media-src data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";

it('builds a CSP-protected export shell around one opaque agent frame', () => {
  const markup = buildAgentVisualExportDocument(
    '<p>chart</p>',
    {
      appearance: 'dark',
      variables: {},
    },
    'A <chart>',
  );
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  expect(
    parsed.head
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content'),
  ).toBe(EXPECTED_CSP);
  expect(parsed.title).toBe('A <chart>');
  const frames = parsed.querySelectorAll('iframe');
  expect(frames).toHaveLength(1);
  expect(frames[0]?.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frames[0]?.getAttribute('srcdoc')).toContain('<p>chart</p>');
  expect(markup).not.toContain('canopy/visual/status');
});

function message(method: string, params: unknown): unknown {
  return { jsonrpc: '2.0', method, params };
}

describe('agent visual constants', () => {
  it('pins the CSP, CDN hosts, stripped meta values, and frame policy', () => {
    expect(AGENT_VISUAL_CSP).toBe(EXPECTED_CSP);
    expect(AGENT_VISUAL_CDN_HOSTS).toEqual([
      'https://cdn.jsdelivr.net',
      'https://unpkg.com',
      'https://cdnjs.cloudflare.com',
    ]);
    expect([...AGENT_VISUAL_STRIPPED_HTTP_EQUIV]).toEqual([
      'refresh',
      'content-security-policy',
      'x-dns-prefetch-control',
      'set-cookie',
    ]);
    expect(AGENT_VISUAL_FRAME_SANDBOX).toBe('allow-scripts');
    expect(AGENT_VISUAL_FRAME_ALLOW).toBe(
      "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'",
    );
  });

  it('exports exactly 45 unique CSS variable names', () => {
    expect(AGENT_VISUAL_THEME_VARIABLES).toHaveLength(45);
    expect(new Set(AGENT_VISUAL_THEME_VARIABLES).size).toBe(45);
    expect(
      AGENT_VISUAL_THEME_VARIABLES.every((name) => name.startsWith('--')),
    ).toBe(true);
  });

  it('exposes the six chart series colors beside the swatch colors', () => {
    for (const slot of [1, 2, 3, 4, 5, 6]) {
      expect(AGENT_VISUAL_THEME_VARIABLES).toContain(
        `--chart-categorical-${slot}`,
      );
      expect(AGENT_VISUAL_THEME_VARIABLES).toContain(`--categorical-${slot}`);
    }
  });

  it('exports the protocol method names and heartbeat timing', () => {
    expect(AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD).toBe(
      'ui/notifications/host-context-changed',
    );
    expect(AGENT_VISUAL_SIZE_CHANGED_METHOD).toBe(
      'ui/notifications/size-changed',
    );
    expect(AGENT_VISUAL_OPEN_LINK_METHOD).toBe('ui/open-link');
    expect(AGENT_VISUAL_HELLO_METHOD).toBe('canopy/visual/hello');
    expect(AGENT_VISUAL_PING_METHOD).toBe('canopy/visual/ping');
    expect(AGENT_VISUAL_PONG_METHOD).toBe('canopy/visual/pong');
    expect(AGENT_VISUAL_STATUS_METHOD).toBe('canopy/visual/status');
    expect(AGENT_VISUAL_GESTURE_METHOD).toBe('canopy/visual/gesture');
    expect(AGENT_VISUAL_GESTURE_WATCH_METHOD).toBe(
      'canopy/visual/gesture-watch',
    );
    expect(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS).toBe(3000);
    expect(AGENT_VISUAL_HEARTBEAT_MISSES).toBe(3);
  });
});

describe('sanitizeAgentVisualTheme', () => {
  it('keeps only safe allowlisted string values, trims them, and normalizes appearance', () => {
    const result = sanitizeAgentVisualTheme({
      appearance: 'dark',
      variables: {
        '--bg-base': '  #101010  ',
        '--fg-primary': ' white ',
        '--not-allowed': 'red',
        '--line-base': 5,
        '--bg-primary': '   ',
      },
    });

    expect(result).toEqual({
      appearance: 'dark',
      variables: { '--bg-base': '#101010', '--fg-primary': 'white' },
    });
  });

  it.each(['<', '>', '{', '}', ';', '\\', '\r', '\n', '/*', '*/', 'URL('])(
    'rejects the forbidden value sequence %s',
    (forbidden) => {
      const result = sanitizeAgentVisualTheme({
        appearance: 'light',
        variables: { '--bg-base': `value${forbidden}value` },
      });
      expect(result.variables).toEqual({});
    },
  );

  it('rejects values longer than 512 characters and falls back for invalid input', () => {
    expect(
      sanitizeAgentVisualTheme({
        appearance: 'dark',
        variables: { '--bg-base': 'x'.repeat(513) },
      }).variables,
    ).toEqual({});
    expect(sanitizeAgentVisualTheme(null)).toEqual({
      appearance: 'light',
      variables: {},
    });
    expect(sanitizeAgentVisualTheme([])).toEqual({
      appearance: 'light',
      variables: {},
    });
    expect(
      sanitizeAgentVisualTheme({ appearance: 'sepia', variables: {} })
        .appearance,
    ).toBe('light');
    expect(
      sanitizeAgentVisualTheme({ appearance: 'dark', variables: null }),
    ).toEqual({ appearance: 'dark', variables: {} });
  });
});

describe('buildAgentVisualSrcDoc', () => {
  const theme: AgentVisualTheme = {
    appearance: 'dark',
    variables: { '--bg-base': '#111', '--fg-primary': '#eee' },
  };

  it.each([
    '<p>plain</p>',
    '<html><head><title>agent title</title></head><body><p>body</p></body></html>',
    '<!doctype html><p>with doctype</p>',
    '\uFEFF<p>with BOM</p>',
    '<!-- leading comment --><p>comment follows</p>',
    '<template><p>template content</p></template>',
  ])(
    'places policy and trusted code before agent input: %s',
    (input: string): void => {
      const doc = buildAgentVisualSrcDoc(input, theme);
      expect(
        doc.startsWith(
          `<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="${EXPECTED_CSP}">`,
        ),
      ).toBe(true);
      const cspIndex = doc.indexOf(
        '<meta http-equiv="Content-Security-Policy"',
      );
      const dnsPrefetchIndex = doc.indexOf(
        '<meta http-equiv="x-dns-prefetch-control" content="off">',
      );
      const themeIndex = doc.indexOf('<style>:root{');
      const baseStyleIndex = doc.indexOf('<style>html{background:');
      const bridgeIndex = doc.indexOf('<script>');
      const agentMarkerIndex = doc.indexOf('<p>');
      expect(cspIndex).toBeLessThan(dnsPrefetchIndex);
      expect(dnsPrefetchIndex).toBeLessThan(themeIndex);
      expect(themeIndex).toBeLessThan(baseStyleIndex);
      expect(baseStyleIndex).toBeLessThan(bridgeIndex);
      expect(bridgeIndex).toBeLessThan(agentMarkerIndex);
    },
  );

  it('puts the CSP and DNS-prefetch metas first in the parsed head', (): void => {
    const parsed = new DOMParser().parseFromString(
      buildAgentVisualSrcDoc('<p>agent</p>', theme),
      'text/html',
    );
    const cspMeta = parsed.head.firstElementChild;
    expect(cspMeta?.tagName).toBe('META');
    expect(cspMeta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(cspMeta?.getAttribute('content')).toBe(EXPECTED_CSP);
    const dnsPrefetchMeta = cspMeta?.nextElementSibling;
    expect(dnsPrefetchMeta?.tagName).toBe('META');
    expect(dnsPrefetchMeta?.getAttribute('http-equiv')).toBe(
      'x-dns-prefetch-control',
    );
    expect(dnsPrefetchMeta?.getAttribute('content')).toBe('off');
  });

  it('injects one DNS-prefetch suppression meta before agent input', (): void => {
    const doc = buildAgentVisualSrcDoc('<p>agent first byte</p>', theme);
    const cspIndex = doc.indexOf('<meta http-equiv="Content-Security-Policy"');
    const dnsPrefetchIndex = doc.indexOf(
      '<meta http-equiv="x-dns-prefetch-control" content="off">',
    );
    const themeIndex = doc.indexOf('<style>:root{');
    const firstAgentByteIndex = doc.indexOf('<p>agent first byte</p>');
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    const dnsPrefetchMetas = parsed.querySelectorAll(
      'meta[http-equiv="x-dns-prefetch-control"]',
    );

    expect(cspIndex).toBeGreaterThanOrEqual(0);
    expect(dnsPrefetchIndex).toBeGreaterThan(cspIndex);
    expect(dnsPrefetchIndex).toBeLessThan(themeIndex);
    expect(dnsPrefetchIndex).toBeLessThan(firstAgentByteIndex);
    expect(dnsPrefetchMetas).toHaveLength(1);
    expect(dnsPrefetchMetas[0]?.getAttribute('content')).toBe('off');
  });

  it('removes agent-supplied DNS-prefetch policy metas', (): void => {
    const doc = buildAgentVisualSrcDoc(
      '<meta http-equiv="x-dns-prefetch-control" content="on"><p>safe</p>',
      theme,
    );
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    const dnsPrefetchMetas = parsed.querySelectorAll(
      'meta[http-equiv="x-dns-prefetch-control"]',
    );

    expect(dnsPrefetchMetas).toHaveLength(1);
    expect(dnsPrefetchMetas[0]?.getAttribute('content')).toBe('off');
    expect(doc).not.toContain('content="on"');
  });

  it('strips agent policy metas while retaining charset and viewport metadata', () => {
    const doc = buildAgentVisualSrcDoc(
      '<meta http-equiv="refresh" content="0;url=https://example.com"><meta http-equiv="Content-Security-Policy" content="default-src *"><meta http-equiv="X-DNS-Prefetch-Control" content="off"><meta http-equiv="set-cookie" content="x=y"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>safe</p>',
      theme,
    );

    expect(doc).not.toContain('url=https://example.com');
    expect(doc).not.toContain('content="default-src *"');
    expect(doc).not.toContain('http-equiv="X-DNS-Prefetch-Control"');
    expect(doc).not.toContain('http-equiv="set-cookie"');
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain(
      '<meta name="viewport" content="width=device-width">',
    );
  });

  it('sanitizes a hostile theme again before writing it into a style element', () => {
    const hostileTheme: AgentVisualTheme = {
      appearance: 'dark',
      variables: { '--bg-base': '</style><script>window.pwned=true</script>' },
    };
    const doc = buildAgentVisualSrcDoc('<p>agent</p>', hostileTheme);
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    expect(parsed.querySelectorAll('script')).toHaveLength(1);
    expect(parsed.querySelector('style')?.textContent).not.toContain(
      '</style>',
    );
  });
});

describe('buildAgentVisualWrapperSrcDoc', () => {
  it.each([
    'double " and single \' quotes',
    '& and &quot; and &amp;',
    '</iframe><p>agent</p>',
    '</script><p>agent</p>',
    '<!-- agent comment -->',
  ])(
    'attribute-escapes the agent document and round-trips it: %s',
    (agentDoc) => {
      const wrapper = buildAgentVisualWrapperSrcDoc(agentDoc, {
        title: 'Visual title',
        appearance: 'light',
      });
      const parsed = new DOMParser().parseFromString(wrapper, 'text/html');
      expect(parsed.querySelector('iframe')?.getAttribute('srcdoc')).toBe(
        agentDoc,
      );
      expect(parsed.querySelectorAll('iframe')).toHaveLength(1);
      expect(parsed.querySelector('p')).toBeNull();
    },
  );

  it('escapes the title and applies the exact nested-frame policy', (): void => {
    const wrapper = buildAgentVisualWrapperSrcDoc('<p>agent</p>', {
      title: 'visual"><iframe src="evil"> &',
      appearance: 'dark',
    });
    const parsed = new DOMParser().parseFromString(wrapper, 'text/html');
    const iframe = parsed.querySelector('iframe');
    expect(iframe?.getAttribute('title')).toBe('visual"><iframe src="evil"> &');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.getAttribute('allow')).toBe(AGENT_VISUAL_FRAME_ALLOW);
    expect(iframe?.hasAttribute('allow-same-origin')).toBe(false);
    expect(parsed.querySelectorAll('script')).toHaveLength(1);
    expect(
      parsed
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content'),
    ).toBe(EXPECTED_CSP);
    expect(
      parsed.querySelector('meta[http-equiv="x-dns-prefetch-control"]'),
    ).toBeNull();
  });
});

describe('host-side message helpers', () => {
  it('builds sanitized host context messages', () => {
    expect(
      buildAgentVisualHostContextMessage({
        appearance: 'dark',
        variables: {
          '--bg-base': ' #111 ',
          '--unknown': 'value',
          '--fg-primary': 'url(https://example.com)',
        },
      }),
    ).toEqual({
      jsonrpc: '2.0',
      method: AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD,
      params: {
        theme: { appearance: 'dark', variables: { '--bg-base': '#111' } },
      },
    });
  });

  it('parses valid size, normalized safe link, and liveness status messages', () => {
    expect(
      parseAgentVisualFrameMessage(
        message(AGENT_VISUAL_SIZE_CHANGED_METHOD, { height: 12.5 }),
      ),
    ).toEqual({ kind: 'size-changed', height: 12.5 });
    expect(
      parseAgentVisualFrameMessage(
        message(AGENT_VISUAL_OPEN_LINK_METHOD, {
          url: 'HTTPS://Example.COM:443/a/../b',
        }),
      ),
    ).toEqual({ kind: 'open-link', url: 'https://example.com/b' });
    for (const state of [
      'ready',
      'alive',
      'unresponsive',
      'navigated',
    ] as const) {
      expect(
        parseAgentVisualFrameMessage(
          message(AGENT_VISUAL_STATUS_METHOD, { state }),
        ),
      ).toEqual({ kind: 'status', state });
    }
  });

  it('builds a gesture check and parses only a well-formed answer', () => {
    expect(buildAgentVisualGestureRequest(4)).toEqual({
      jsonrpc: '2.0',
      method: AGENT_VISUAL_GESTURE_METHOD,
      params: { id: 4 },
    });
    expect(buildAgentVisualGestureWatchMessage(true)).toEqual({
      jsonrpc: '2.0',
      method: AGENT_VISUAL_GESTURE_WATCH_METHOD,
      params: { watching: true },
    });
    for (const gesture of ['inside', 'none', 'unclear'] as const) {
      expect(
        parseAgentVisualFrameMessage(
          message(AGENT_VISUAL_GESTURE_METHOD, { id: 4, gesture }),
        ),
      ).toEqual({ kind: 'gesture', id: 4, gesture });
    }
    for (const params of [
      { id: '4', gesture: 'inside' },
      { id: Number.NaN, gesture: 'inside' },
      { id: 4, gesture: 'yes' },
      { id: 4, active: true },
      { id: 4 },
      { gesture: 'inside' },
    ]) {
      expect(
        parseAgentVisualFrameMessage(
          message(AGENT_VISUAL_GESTURE_METHOD, params),
        ),
      ).toBeNull();
    }
  });

  it('rejects malformed, host-to-frame, and bridge-to-relay messages', () => {
    const rejected = [
      null,
      5,
      'message',
      [],
      {},
      {
        jsonrpc: '1.0',
        method: AGENT_VISUAL_SIZE_CHANGED_METHOD,
        params: { height: 1 },
      },
      { method: AGENT_VISUAL_SIZE_CHANGED_METHOD, params: { height: 1 } },
      message(AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD, {
        theme: { appearance: 'light', variables: {} },
      }),
      message(AGENT_VISUAL_HELLO_METHOD, {}),
      message(AGENT_VISUAL_PING_METHOD, { id: 1 }),
      message(AGENT_VISUAL_PONG_METHOD, { id: 1 }),
      message('unknown/method', {}),
      message(AGENT_VISUAL_SIZE_CHANGED_METHOD, null),
    ];
    for (const candidate of rejected) {
      expect(parseAgentVisualFrameMessage(candidate)).toBeNull();
    }
  });

  it('rejects invalid heights and links', () => {
    for (const height of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1_000_001,
      '1',
    ]) {
      expect(
        parseAgentVisualFrameMessage(
          message(AGENT_VISUAL_SIZE_CHANGED_METHOD, { height }),
        ),
      ).toBeNull();
    }
    const rejectedUrls = [
      '/relative/path',
      'javascript:alert(1)',
      'file:///tmp/visual.html',
      'data:text/html,hello',
      'http://user:password@example.com/',
      'https://example.com/' + 'x'.repeat(8192),
      'not a URL',
    ];
    for (const url of rejectedUrls) {
      expect(
        parseAgentVisualFrameMessage(
          message(AGENT_VISUAL_OPEN_LINK_METHOD, { url }),
        ),
      ).toBeNull();
    }
    expect(
      parseAgentVisualFrameMessage(
        message(AGENT_VISUAL_STATUS_METHOD, { state: 'focused' }),
      ),
    ).toBeNull();
  });

  it('clamps heights to the integer range and uses the default for odd max bounds', () => {
    expect(clampAgentVisualHeight(10, 500)).toBe(80);
    expect(clampAgentVisualHeight(100_000, 500)).toBe(500);
    expect(clampAgentVisualHeight(100.01, 500)).toBe(101);
    expect(clampAgentVisualHeight(Number.NaN, 400)).toBe(400);
    expect(clampAgentVisualHeight(500, 80.9)).toBe(80);
    expect(clampAgentVisualHeight(500, 79)).toBe(500);
    expect(clampAgentVisualHeight(500, Number.POSITIVE_INFINITY)).toBe(500);
    expect(clampAgentVisualHeight(500, 2001)).toBe(500);
  });
});

describe('in-frame source strings', () => {
  it('are safe to embed in script elements and compile as plain source', () => {
    const sources = [AGENT_VISUAL_BRIDGE_SCRIPT, AGENT_VISUAL_RELAY_SCRIPT];
    sources.forEach((source, index) => {
      expect(source).not.toMatch(/<\/script/i);
      expect(source).not.toMatch(/<!--/i);
      // An inline script that fails to parse never defines its function.
      const name = `agentVisualCompileCheck${index}`;
      const element = document.createElement('script');
      element.textContent = `window[${JSON.stringify(name)}] = function(){${source}\n};`;
      document.head.append(element);
      element.remove();
      expect(typeof Reflect.get(globalThis, name)).toBe('function');
    });
  });
});

describe('pickAgentVisualHeightHint', () => {
  const heights = [
    [360, 900],
    [520, 700],
    [720, 500],
    [960, 420],
  ] as const;

  it('reserves the pair nearest the frame width', () => {
    expect(pickAgentVisualHeightHint(heights, 400, 1200)).toBe(900);
    expect(pickAgentVisualHeightHint(heights, 900, 1200)).toBe(420);
  });

  it('prefers the taller pair on a tie', () => {
    expect(pickAgentVisualHeightHint(heights, 440, 1200)).toBe(900);
  });

  it('keeps the hint within the visual maxHeight', () => {
    expect(pickAgentVisualHeightHint(heights, 360, 600)).toBe(600);
  });

  it('falls back to maxHeight without pairs or a width', () => {
    expect(pickAgentVisualHeightHint(undefined, 400, 640)).toBe(640);
    expect(pickAgentVisualHeightHint([], 400, 640)).toBe(640);
    expect(pickAgentVisualHeightHint(heights, undefined, 640)).toBe(640);
    expect(pickAgentVisualHeightHint(heights, 0, 640)).toBe(640);
  });
});

describe('buildAgentVisualPreviewHostDocument', () => {
  it('holds one relay frame with the production frame attributes, inert, at an exact size', () => {
    const html = buildAgentVisualPreviewHostDocument('<p title="x">&amp;</p>', {
      title: 'Chart "A" <b>',
      width: 720.6,
      height: 2000,
    });
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const frames = parsed.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.getAttribute('sandbox')).toBe(AGENT_VISUAL_FRAME_SANDBOX);
    expect(frame?.getAttribute('allow')).toBe(AGENT_VISUAL_FRAME_ALLOW);
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.hasAttribute('inert')).toBe(true);
    expect(frame?.getAttribute('title')).toBe('Chart "A" <b>');
    expect(frame?.getAttribute('srcdoc')).toBe('<p title="x">&amp;</p>');
    expect(parsed.querySelectorAll('script')).toHaveLength(0);
    expect(html).toContain('width:720px;height:2000px');
  });
});

describe('AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE', () => {
  it('is the function the bridge reports heights with', () => {
    expect(AGENT_VISUAL_BRIDGE_SCRIPT).toContain(
      AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE,
    );
  });

  it('measures the root box unless the document overflows', () => {
    const root = document.documentElement;
    const measure = (
      scrollHeight: number,
      clientHeight: number,
      box: number,
    ): number => {
      Object.defineProperty(root, 'scrollHeight', {
        configurable: true,
        value: scrollHeight,
      });
      Object.defineProperty(root, 'clientHeight', {
        configurable: true,
        value: clientHeight,
      });
      jest
        .spyOn(root, 'getBoundingClientRect')
        .mockReturnValue({ height: box } as DOMRect);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const documentHeight = new Function(
        `return (${AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE})();`,
      ) as () => number;
      return documentHeight();
    };
    // Short content in a tall frame reports the content, not the frame.
    expect(measure(2000, 2000, 412.2)).toBe(413);
    // Overflowing content reports its scroll height.
    expect(measure(2600, 2000, 2000)).toBe(2600);
  });
});
