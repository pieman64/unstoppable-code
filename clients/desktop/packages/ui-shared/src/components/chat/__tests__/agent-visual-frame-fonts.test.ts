/** @jest-environment jsdom */
import {
  loadAgentVisualFonts,
  resetAgentVisualFontsForTests,
  watchAgentVisualFontLoads,
} from '../agent-visual-frame-fonts';
import type { AgentVisualTheme } from '../../../lib/agent-visual-html';

const theme: AgentVisualTheme = {
  appearance: 'light',
  variables: {
    '--font-sans': "'Inter', -apple-system, sans-serif",
    '--font-mono': "'JetBrains Mono', monospace",
  },
};

type LoadedFace = {
  family: string;
  style: string;
  weight: string;
  unicodeRange?: string;
  status: string;
};

let loadedFaces: LoadedFace[] = [];
let fetchMock: jest.Mock;
const originalFetch = window.fetch;

function addStyles(css: string): void {
  const element = document.createElement('style');
  element.textContent = css;
  document.head.appendChild(element);
}

function respond(
  bytes: number,
  ok = true,
): { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> } {
  return { ok, arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)) };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.removeAttribute('style');
  resetAgentVisualFontsForTests(document);
  loadedFaces = [];
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    get: () => loadedFaces,
  });
  fetchMock = jest.fn(() => Promise.resolve(respond(16)));
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: fetchMock,
  });
});

afterAll(() => {
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: originalFetch,
  });
});

const INTER = `@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400 500; src: url('/fonts/inter.woff2') format('woff2'); }`;
const INTER_ITALIC = `@font-face { font-family: 'Inter'; font-style: italic; font-weight: 400 500; src: url('/fonts/inter-italic.woff2') format('woff2'); }`;
const MONO = `@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400 500; src: url("/fonts/mono.woff2") format("woff2"); }`;

it('mirrors the loaded faces of the families the theme names', async () => {
  addStyles(`${INTER} ${INTER_ITALIC} ${MONO}`);
  loadedFaces = [
    { family: 'Inter', style: 'normal', weight: '400 500', status: 'loaded' },
    {
      family: '"JetBrains Mono"',
      style: 'normal',
      weight: '400 500',
      status: 'loaded',
    },
    // Declared, but the app has not needed it yet.
    { family: 'Inter', style: 'italic', weight: '400 500', status: 'unloaded' },
  ];
  const faces = await loadAgentVisualFonts(document, theme);
  expect(
    faces.map(({ family, style, weight }) => ({ family, style, weight })),
  ).toEqual([
    { family: 'Inter', style: 'normal', weight: '400 500' },
    { family: 'JetBrains Mono', style: 'normal', weight: '400 500' },
  ]);
  expect(faces.every((face) => face.data.byteLength === 16)).toBe(true);
  expect(fetchMock.mock.calls.map(([url]: [string]) => url)).toEqual([
    'http://localhost/fonts/inter.woff2',
    'http://localhost/fonts/mono.woff2',
  ]);
});

it('gives a face the host loads under a generated name the family the theme asks for', async () => {
  // A bundler's font loader names its faces itself and points the tokens'
  // hook at that name, where the app's font variables are in scope.
  addStyles(
    `@font-face { font-family: inter; font-style: normal; font-weight: 400 500; src: url('/media/inter.woff2') format('woff2'); }
     @font-face { font-family: inter Fallback; src: local(Arial); }
     @font-face { font-family: jetbrainsMono; font-style: normal; font-weight: 400 500; src: url('/media/mono.woff2') format('woff2'); }`,
  );
  document.body.style.setProperty('--font-inter', '"inter", "inter Fallback"');
  document.body.style.setProperty(
    '--font-jetbrains-mono',
    '"jetbrainsMono", "jetbrainsMono Fallback"',
  );
  loadedFaces = [
    { family: 'inter', style: 'normal', weight: '400 500', status: 'loaded' },
    {
      family: 'jetbrainsMono',
      style: 'normal',
      weight: '400 500',
      status: 'loaded',
    },
  ];
  const faces = await loadAgentVisualFonts(document, theme);
  expect(faces.map(({ family }) => family)).toEqual([
    'Inter',
    'JetBrains Mono',
  ]);
  expect(fetchMock.mock.calls.map(([url]: [string]) => url)).toEqual([
    'http://localhost/media/inter.woff2',
    'http://localhost/media/mono.woff2',
  ]);
});

it('mirrors only the subset of a split family the host has loaded', async () => {
  // A host can split one family into subsets by range, loading the latin
  // subset up front and the rest only when a page needs it.
  addStyles(
    `@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400 500; src: url('/fonts/inter-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131; }
     @font-face { font-family: 'Inter'; font-style: normal; font-weight: 400 500; src: url('/fonts/inter-rest.woff2') format('woff2'); unicode-range: U+0100-0130, U+0132-10FFFF; }`,
  );
  loadedFaces = [
    {
      family: 'Inter',
      style: 'normal',
      weight: '400 500',
      // The font set may list the parts in another order than the rule.
      unicodeRange: 'U+131, U+0-FF',
      status: 'loaded',
    },
    {
      family: 'Inter',
      style: 'normal',
      weight: '400 500',
      unicodeRange: 'U+100-130, U+132-10FFFF',
      status: 'unloaded',
    },
  ];
  const faces = await loadAgentVisualFonts(document, theme);
  expect(faces).toHaveLength(1);
  expect(fetchMock.mock.calls.map(([url]: [string]) => url)).toEqual([
    'http://localhost/fonts/inter-latin.woff2',
  ]);
});

it('ignores families the theme does not name and sources with no url', async () => {
  addStyles(
    `@font-face { font-family: 'Other'; src: url('/fonts/other.woff2'); } @font-face { font-family: 'Inter'; src: local('Arial'); }`,
  );
  loadedFaces = [
    { family: 'Other', style: 'normal', weight: 'normal', status: 'loaded' },
    { family: 'Inter', style: 'normal', weight: 'normal', status: 'loaded' },
  ];
  expect(await loadAgentVisualFonts(document, theme)).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('finds a face declared inside a conditional rule', async () => {
  addStyles(`@media screen { ${INTER} }`);
  loadedFaces = [
    { family: 'Inter', style: 'normal', weight: '400 500', status: 'loaded' },
  ];
  expect(await loadAgentVisualFonts(document, theme)).toHaveLength(1);
});

it('fetches each face once across calls', async () => {
  addStyles(INTER);
  loadedFaces = [
    { family: 'Inter', style: 'normal', weight: '400 500', status: 'loaded' },
  ];
  await loadAgentVisualFonts(document, theme);
  await loadAgentVisualFonts(document, theme);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('leaves out a face that fails to load, then tries again', async () => {
  addStyles(INTER);
  loadedFaces = [
    { family: 'Inter', style: 'normal', weight: '400 500', status: 'loaded' },
  ];
  fetchMock.mockImplementationOnce(() => Promise.resolve(respond(16, false)));
  expect(await loadAgentVisualFonts(document, theme)).toEqual([]);
  await Promise.resolve();
  expect(await loadAgentVisualFonts(document, theme)).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('returns nothing when the theme names no family or the document has no font set', async () => {
  addStyles(INTER);
  expect(
    await loadAgentVisualFonts(document, {
      appearance: 'light',
      variables: {},
    }),
  ).toEqual([]);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    get: () => undefined,
  });
  expect(await loadAgentVisualFonts(document, theme)).toEqual([]);
});

it('tells the frame when the document finishes loading faces, until unwatched', async () => {
  const fontSet = new EventTarget();
  let settle = (): void => {};
  Object.defineProperty(fontSet, 'ready', {
    value: new Promise<void>((resolve) => {
      settle = resolve;
    }),
  });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    get: () => fontSet,
  });
  const listener = jest.fn();
  const unwatch = watchAgentVisualFontLoads(document, listener);
  settle();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  fontSet.dispatchEvent(new Event('loadingdone'));
  expect(listener).toHaveBeenCalledTimes(2);
  unwatch();
  fontSet.dispatchEvent(new Event('loadingdone'));
  expect(listener).toHaveBeenCalledTimes(2);
});

it('watches nothing where the document has no font set', () => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    get: () => undefined,
  });
  const listener = jest.fn();
  expect(() => watchAgentVisualFontLoads(document, listener)()).not.toThrow();
  expect(listener).not.toHaveBeenCalled();
});

it('picks up a stylesheet added after the first read', async () => {
  loadedFaces = [
    { family: 'Inter', style: 'normal', weight: '400 500', status: 'loaded' },
  ];
  expect(await loadAgentVisualFonts(document, theme)).toEqual([]);
  addStyles(INTER);
  expect(await loadAgentVisualFonts(document, theme)).toHaveLength(1);
});
