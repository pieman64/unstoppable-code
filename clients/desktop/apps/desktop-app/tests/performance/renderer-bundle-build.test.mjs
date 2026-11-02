import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { build } from 'vite';
// tsx loads the TypeScript modules as CommonJS, so their exports arrive as the
// default export.
import minification from '../../src/main/build/renderer-minification.ts';
import chunks from '../../src/main/build/renderer-chunks.ts';

const { rendererOutputPlugins } = minification;
const { rendererManualChunk, rendererStartupBoundaryPlugin } = chunks;

/**
 * Builds a small renderer through Vite's real pipeline with the release
 * renderer output plugins and the renderer chunking rules, then inspects what
 * would ship: Vite's own late output transforms used to re-print every chunk in
 * readable form, so only the built files can show whether minification
 * survives.
 */
const FIXTURE = {
  'index.html':
    '<!doctype html><html><head><meta charset="UTF-8" /></head><body><script type="module" src="./main.js"></script></body></html>',
  'main.js': `import { summarizeWidgets } from './widget-summary.js';

export function bootRendererFixture(rootLabel) {
  const fixtureAccumulator = [];
  for (const widgetCandidate of [rootLabel, 'fixture-secondary']) {
    if (widgetCandidate.length > 3) {
      fixtureAccumulator.push(summarizeWidgets(widgetCandidate));
    } else {
      fixtureAccumulator.push('fixture-short');
    }
  }
  return fixtureAccumulator.join(',');
}

console.info(bootRendererFixture('fixture-root'));
globalThis.loadFixtureVendor = () => import('fixture-vendor');
`,
  'widget-summary.js': `export function summarizeWidgets(widgetLabel) {
  const widgetSummaryParts = widgetLabel.split('-');
  return widgetSummaryParts
    .map((summaryPart) => summaryPart.toUpperCase())
    .join('fixture-summary-label');
}
`,
  'node_modules/fixture-vendor/package.json': JSON.stringify({
    name: 'fixture-vendor',
    type: 'module',
    main: 'index.js',
  }),
  'node_modules/fixture-vendor/index.js': `export function formatVendorValue(vendorInput) {
  const vendorIntermediate = { value: vendorInput, length: vendorInput.length };
  if (vendorIntermediate.length > 2) {
    return vendorIntermediate.value + 'fixture-vendor-suffix';
  }
  return vendorIntermediate.value;
}

export const loadVendorExtra = () => import('./extra.js');
`,
  'node_modules/fixture-vendor/extra.js':
    "export const vendorExtraValue = 'fixture-vendor-extra';\n",
};

async function buildFixture(
  overrides = {},
  startupBoundaries = [],
  define = {},
) {
  // Vite needs the real path: macOS temp directories sit behind a symlink.
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'renderer-bundle-build-')),
  );
  try {
    for (const [name, source] of Object.entries({ ...FIXTURE, ...overrides })) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      define,
      plugins: [
        ...rendererOutputPlugins(),
        rendererStartupBoundaryPlugin(startupBoundaries),
      ],
      build: {
        write: false,
        // electron-vite's renderer defaults: a Chrome target, no minify, and
        // no module-preload polyfill.
        target: 'chrome130',
        minify: false,
        modulePreload: { polyfill: false },
        // Release builds with Datadog symbolication enabled use hidden maps.
        sourcemap: 'hidden',
        rollupOptions: {
          output: {
            entryFileNames: 'assets/entry-[hash].js',
            chunkFileNames: 'assets/chunk-[hash].js',
            manualChunks: (id) =>
              rendererManualChunk(id) ??
              // Stands in for a real on-demand vendor chunk.
              (id.includes('/node_modules/fixture-vendor/')
                ? 'vendor-diff'
                : undefined),
          },
        },
      },
    });
    return (Array.isArray(result) ? result : [result]).flatMap(
      (bundle) => bundle.output,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const outputs = await buildFixture();
const jsChunks = outputs.filter((output) => output.type === 'chunk');
const entry = jsChunks.find((output) => output.isEntry);
const vendor = jsChunks.find((output) =>
  output.code.includes('fixture-vendor-suffix'),
);

function indentedLines(code) {
  return code.split('\n').filter((line) => /^[ \t]/.test(line));
}

test('the entry ships minified, not re-printed on many lines', () => {
  assert.ok(entry, 'entry chunk built');
  // Vite may append a final newline; the minified body is one line.
  assert.ok(
    entry.code.trimEnd().split('\n').length <= 2,
    `entry has ${entry.code.split('\n').length} lines`,
  );
  assert.deepEqual(indentedLines(entry.code), []);
});

test('the entry is minified without obfuscation', () => {
  assert.doesNotMatch(entry.code, /\b_0x[0-9a-f]+\b/);
  for (const localName of [
    'fixtureAccumulator',
    'widgetCandidate',
    'widgetSummaryParts',
    'summaryPart',
  ]) {
    assert.doesNotMatch(entry.code, new RegExp(`\\b${localName}\\b`));
  }
  // String literals survive untouched.
  assert.match(entry.code, /fixture-summary-label/);
});

test('vendor chunks are fully minified', () => {
  assert.ok(vendor, 'vendor chunk built');
  assert.doesNotMatch(vendor.code, /\bvendorIntermediate\b/);
  assert.deepEqual(indentedLines(vendor.code), []);
});

test('the entry does not statically load a lazy vendor chunk for the preload helper', () => {
  assert.ok(
    !entry.imports.includes(vendor.fileName),
    `entry statically imports ${entry.imports.join(', ')}`,
  );
  assert.ok(entry.dynamicImports.includes(vendor.fileName));
});

test('hidden source maps still resolve shipped code to its sources', () => {
  assert.doesNotMatch(entry.code, /sourceMappingURL/);
  const mapAsset = outputs.find(
    (output) => output.fileName === `${entry.fileName}.map`,
  );
  assert.ok(mapAsset, 'entry source map emitted as a separate file');
  const map = new TraceMap(String(mapAsset.source));
  assert.ok(map.sources.some((source) => source.endsWith('widget-summary.js')));

  const offset = entry.code.indexOf('fixture-summary-label');
  const before = entry.code.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1);
  const original = originalPositionFor(map, { line, column });
  assert.ok(original.source?.endsWith('widget-summary.js'), original.source);
  // The literal resolves into `summarizeWidgets`' return statement
  // (lines 3-5).
  assert.ok(
    original.line >= 3 && original.line <= 5,
    `mapped to line ${original.line}`,
  );
});

test('the build fails when startup statically loads an on-demand vendor chunk', async () => {
  await assert.rejects(
    buildFixture({
      'main.js': `import { formatVendorValue } from 'fixture-vendor';\nconsole.info(formatVendorValue('fixture-eager'));\n`,
    }),
    /Renderer startup loads code it must load on demand: .* loads on-demand chunk vendor-diff/,
  );
});

test('the build fails when an HTML page entry statically loads a module its window must not', async () => {
  // Vite names an HTML page as the entry chunk's facade, so the boundary has
  // to find the page's entry module among the chunk's modules.
  await assert.rejects(
    buildFixture({}, [
      { entryModule: '/main.js', forbiddenModules: ['/widget-summary.js'] },
    ]),
    /Renderer startup loads code it must load on demand: .*index\.html loads \/widget-summary\.js/,
  );
});

test('the build fails when a startup boundary matches no entry', async () => {
  await assert.rejects(
    buildFixture({}, [
      { entryModule: '/missing-entry.js', forbiddenModules: ['/main.js'] },
    ]),
    /no renderer entry loads \/missing-entry\.js/,
  );
});

async function extractSidebarFlags(code) {
  const script = new URL(
    '../../../../scripts/browser-profiles-build-config.py',
    import.meta.url,
  );
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import json, pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
namespace = {}
exec(source.split("# CI entry:")[0], namespace)
print(json.dumps(namespace["extract_sidebar_flags"](sys.stdin.read())[0]))
`,
      fileURLToPath(script),
    ],
    { input: code, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const shared of [false, true]) {
  for (const shadow of [false, true]) {
    for (const e2e of [false, true]) {
      test(`release evidence survives renderer minification (shared=${shared}, shadow=${shadow}, e2e=${e2e})`, async () => {
        const sidebarDirectory = new URL(
          '../../src/renderer/src/components/sidebar/',
          import.meta.url,
        );
        const output = await buildFixture(
          {
            'main.js': `import { isDesktopSharedSidebarEnabled } from './shared.ts';
import { isDesktopSidebarShadowEnabled } from './shadow.ts';
console.info(isDesktopSharedSidebarEnabled(), isDesktopSidebarShadowEnabled());`,
            'shared.ts': await readFile(
              new URL('desktop-shared-sidebar-flag.ts', sidebarDirectory),
              'utf8',
            ),
            'shadow.ts': await readFile(
              new URL('desktop-sidebar-shadow-flag.ts', sidebarDirectory),
              'utf8',
            ),
          },
          [],
          {
            __CANOPY_DESKTOP_SHARED_SIDEBAR__: JSON.stringify(shared),
            __CANOPY_DESKTOP_SIDEBAR_SHADOW__: JSON.stringify(shadow),
            __CANOPY_E2E__: JSON.stringify(e2e),
          },
        );
        const renderer = output.find(
          (item) => item.type === 'chunk' && item.isEntry,
        );
        assert.ok(renderer);
        assert.doesNotMatch(
          renderer.code,
          /function isDesktop(?:SharedSidebar|SidebarShadow)Enabled/,
        );
        assert.deepEqual(await extractSidebarFlags(renderer.code), {
          desktopSharedSidebar: shared,
          desktopSidebarShadow: shadow,
          e2eCrossCheck: e2e,
        });
      });
    }
  }
}

test('historical unminified sidebar evidence remains readable', async () => {
  assert.deepEqual(
    await extractSidebarFlags(`
function isDesktopSharedSidebarEnabled() {
  try { return window.localStorage.getItem("canopy.desktop.sharedSidebar") !== "0"; }
  catch { return true; }
}
function isDesktopSidebarShadowEnabled() {
  if (!window.devInfo?.isDev && true) return false;
  try { return window.localStorage.getItem("canopy.dev.desktopSidebarShadow") === "1"; }
  catch { return false; }
}`),
    {
      desktopSharedSidebar: false,
      desktopSidebarShadow: false,
      e2eCrossCheck: false,
    },
  );
});

for (const evidence of [
  '{',
  'null',
  '{"schemaVersion":2}',
  '{"schemaVersion":1,"desktopSharedSidebar":0,"desktopSidebarShadow":false,"e2eCrossCheck":false}',
  '{"schemaVersion":1,"desktopSharedSidebar":false,"desktopSidebarShadow":false}',
]) {
  test(`invalid renderer metadata fails closed: ${evidence}`, async () => {
    await assert.rejects(
      extractSidebarFlags(`/* canopy-renderer-build-config:${evidence} */`),
      /Invalid renderer build configuration/,
    );
  });
}

test('duplicate renderer metadata fails closed', async () => {
  await assert.rejects(
    extractSidebarFlags(
      '/* canopy-renderer-build-config:{} *//* canopy-renderer-build-config:{} */',
    ),
    /Duplicate renderer build configuration/,
  );
});

test('partial renderer build defines fail instead of publishing guessed defaults', async () => {
  await assert.rejects(
    buildFixture({}, [], { __CANOPY_E2E__: 'false' }),
    /Expected a literal boolean build define/,
  );
});
