import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  LEGACY_CAPTURE_THEME_STORAGE_KEY,
  captureColorSchemeOptions,
  captureThemeInitScript,
  seedCaptureTheme,
} from './captureMode.mjs';
import * as portalWebServer from './portal/web-server.mjs';

const { PORTAL_WEB_FALLBACK_BRAND_ID, resolvePortalWebBrandId } =
  portalWebServer;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

function recordingContext(initScripts) {
  return {
    addInitScript(script, argument) {
      initScripts.push({ script, argument });
    },
  };
}

function temporaryWebApp(packageJson) {
  const root = mkdtempSync(path.join(tmpdir(), 'portal-web-app-'));
  const webAppDir = path.join(root, 'apps/web');
  mkdirSync(webAppDir, { recursive: true });
  writeFileSync(
    path.join(webAppDir, 'package.json'),
    JSON.stringify(packageJson),
    'utf8',
  );
  return { root, webAppDir };
}

function installPdfFixture(root, ownerDir) {
  const packageDir = path.join(ownerDir, 'node_modules/pdfjs-dist');
  mkdirSync(path.join(packageDir, 'build'), { recursive: true });
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    mkdirSync(path.join(packageDir, directory), { recursive: true });
    writeFileSync(path.join(packageDir, directory, 'asset'), directory, 'utf8');
  }
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ version: '5.7.284' }),
    'utf8',
  );
  writeFileSync(
    path.join(packageDir, 'build/pdf.worker.min.mjs'),
    root,
    'utf8',
  );
}

test('portal server skips PDF worker preparation for pre-change web apps', () => {
  const value = temporaryWebApp({ dependencies: { next: '16.0.0' } });
  try {
    assert.doesNotThrow(() =>
      portalWebServer.preparePortalPdfWorker(value.webAppDir),
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('portal server fails when a declared PDF.js dependency is unavailable', () => {
  const value = temporaryWebApp({
    dependencies: { 'pdfjs-dist': '5.7.284' },
  });
  try {
    assert.throws(
      () => portalWebServer.preparePortalPdfWorker(value.webAppDir),
      /Unable to resolve the installed pdfjs-dist package/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('portal server prepares legacy web-owned PDF assets from the requested checkout', () => {
  const value = temporaryWebApp({
    dependencies: { 'pdfjs-dist': '5.7.284' },
  });
  try {
    installPdfFixture(value.root, value.webAppDir);
    portalWebServer.preparePortalPdfWorker(value.webAppDir);
    assert.equal(
      readFileSync(
        path.join(
          value.webAppDir,
          'public/pdf-worker/5.7.284/pdf.worker.min.mjs',
        ),
        'utf8',
      ),
      value.root,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('portal server prepares PDF assets declared by ui-rich from the requested checkout', () => {
  const value = temporaryWebApp({ dependencies: { next: '16.0.0' } });
  const sharedDir = path.join(value.root, 'packages/ui-rich');
  try {
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(
      path.join(sharedDir, 'package.json'),
      JSON.stringify({ dependencies: { 'pdfjs-dist': '5.7.284' } }),
      'utf8',
    );
    installPdfFixture(value.root, sharedDir);

    portalWebServer.preparePortalPdfWorker(value.webAppDir);

    assert.equal(
      readFileSync(
        path.join(
          value.webAppDir,
          'public/pdf-worker/5.7.284/pdf.worker.min.mjs',
        ),
        'utf8',
      ),
      value.root,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('capture mode seeds browser preference and explicit portal theme', async () => {
  assert.deepEqual(captureColorSchemeOptions({}), {});
  assert.deepEqual(
    captureColorSchemeOptions({ CANOPY_E2E_CAPTURE_COLOR_MODE: 'light' }),
    { colorScheme: 'light' },
  );
  assert.deepEqual(
    captureThemeInitScript({ CANOPY_E2E_CAPTURE_COLOR_MODE: 'dark' }, 'canopy'),
    {
      storageKey: 'canopy-theme',
      legacyStorageKey: LEGACY_CAPTURE_THEME_STORAGE_KEY,
      theme: 'dark',
    },
  );
  assert.equal(
    captureThemeInitScript(
      { CANOPY_E2E_CAPTURE_COLOR_MODE: 'sepia' },
      'canopy',
    ),
    null,
  );

  const initScripts = [];
  await seedCaptureTheme(
    recordingContext(initScripts),
    { CANOPY_E2E_CAPTURE_COLOR_MODE: 'light' },
    'canopy',
  );
  assert.equal(initScripts.length, 1);
  assert.match(String(initScripts[0].script), /localStorage\.setItem/);
  assert.deepEqual(initScripts[0].argument, {
    storageKey: 'canopy-theme',
    legacyStorageKey: LEGACY_CAPTURE_THEME_STORAGE_KEY,
    theme: 'light',
  });
});

test('capture mode satisfies both the current and before-stage storage contracts', async () => {
  // Current layouts read ONLY `<brand-id>-theme`; before-stage trees started
  // from CAN2527_BEFORE_REPO_ROOT / CAN1939_WEB_APP_DIR read ONLY `theme`.
  // Seeding one key leaves the other stage on its hard-coded default while the
  // artifact is still saved under the requested mode -- a mislabeled baseline,
  // which is worse than a failure because it looks like evidence.
  for (const colorMode of ['light', 'dark']) {
    const init = captureThemeInitScript(
      { CANOPY_E2E_CAPTURE_COLOR_MODE: colorMode },
      'canopy',
    );
    assert.equal(init.storageKey, 'canopy-theme');
    assert.equal(init.legacyStorageKey, 'theme');
    assert.equal(init.theme, colorMode);
  }

  // Run the emitted init script against a fake localStorage to prove BOTH keys
  // are actually written, not merely present in the argument object.
  const initScripts = [];
  await seedCaptureTheme(
    recordingContext(initScripts),
    { CANOPY_E2E_CAPTURE_COLOR_MODE: 'light' },
    'unstoppable-code',
  );
  const store = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: { setItem: (k, v) => store.set(k, v) } };
  try {
    initScripts[0].script(initScripts[0].argument);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.equal(store.get('unstoppable-code-theme'), 'light');
  assert.equal(store.get('theme'), 'light');
});

test('capture mode scopes the theme key to the requested brand', async () => {
  assert.deepEqual(
    captureThemeInitScript(
      { CANOPY_E2E_CAPTURE_COLOR_MODE: 'dark' },
      'unstoppable-code',
    ),
    {
      storageKey: 'unstoppable-code-theme',
      legacyStorageKey: LEGACY_CAPTURE_THEME_STORAGE_KEY,
      theme: 'dark',
    },
  );

  const initScripts = [];
  await seedCaptureTheme(
    recordingContext(initScripts),
    { CANOPY_E2E_CAPTURE_COLOR_MODE: 'dark' },
    'unstoppable-code',
  );
  assert.deepEqual(initScripts[0].argument, {
    storageKey: 'unstoppable-code-theme',
    legacyStorageKey: LEGACY_CAPTURE_THEME_STORAGE_KEY,
    theme: 'dark',
  });
});

test('capture mode fails loudly when the brand is not propagated', async () => {
  // A missing propagation must not fall back to a plausible brand: that writes
  // a key the app never reads and yields a screenshot in the wrong color mode,
  // which is far worse than a crash.
  assert.throws(
    () => captureThemeInitScript({ CANOPY_E2E_CAPTURE_COLOR_MODE: 'dark' }),
    /brandId is required/,
  );
  await assert.rejects(
    () => seedCaptureTheme(recordingContext([]), process.env, undefined),
    /brandId is required/,
  );
  // Validation runs even when no color mode is requested, so a broken call site
  // fails on every run rather than only on capture runs.
  await assert.rejects(
    () => seedCaptureTheme(recordingContext([]), {}, ''),
    /brandId is required/,
  );
});

test('portal brand resolution mirrors the web app known-brand check', () => {
  // A known override wins...
  assert.equal(
    resolvePortalWebBrandId({
      env: { CANOPY_WEB_DEFAULT_BRAND: 'unstoppable-code' },
    }),
    'unstoppable-code',
  );
  // ...but unknown and empty values fall back exactly as getDefaultBrand does,
  // instead of seeding `<typo>-theme` / `-theme` against a `canopy` server.
  for (const requested of ['not-a-real-brand', '']) {
    assert.equal(
      resolvePortalWebBrandId({
        env: { CANOPY_WEB_DEFAULT_BRAND: requested },
      }),
      PORTAL_WEB_FALLBACK_BRAND_ID,
    );
  }
});

test('portal fallback brand matches the web app getDefaultBrand fallback', () => {
  // The REAL invariant is `apps/web`'s own fallback. `.mjs` cannot import the
  // TS source, so read the declaration back as text -- the same drift-guard
  // pattern `load-brand.test.mjs` uses for BRAND_COLOR_MODES. Anchor on the
  // function first: an unanchored search would take the first match anywhere
  // in the file and could assert against an unrelated literal.
  //
  // SCOPE: this pins the fallback LITERAL only. It does not prove the harness
  // and the app agree on the brand SET -- the harness reads `brands/` from disk
  // while the app reads the generated `WEB_BRANDS` in
  // `.cache/brand/web-brands.ts`, which agree only after `brand:prepare` runs.
  // A newly added brand directory with a stale cache is therefore still
  // possible; the harness builds the app, so it is unlikely rather than
  // impossible.
  const brandSource = readFileSync(
    path.join(repoRoot, 'apps', 'web', 'src', 'lib', 'brand.ts'),
    'utf8',
  );
  const start = brandSource.indexOf('function getDefaultBrand');
  assert.notEqual(start, -1, 'getDefaultBrand not found in brand.ts');
  const match = brandSource
    .slice(start)
    .match(
      /WEB_BRANDS\.find\(\(brand\) => brand\.id === '([^']+)'\) \?\? WEB_BRANDS\[0\]/,
    );
  assert.ok(match, 'getDefaultBrand fallback not found in brand.ts');
  assert.equal(
    PORTAL_WEB_FALLBACK_BRAND_ID,
    match[1],
    'portal fallback brand drifted from the web app getDefaultBrand fallback',
  );
});
