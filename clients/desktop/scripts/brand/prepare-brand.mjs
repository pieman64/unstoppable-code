#!/usr/bin/env node
// Materializes validated brand runtime files, resources, and web assets under .cache/brand.
// Usage: pnpm run brand:prepare [--brand <id> | --all] (defaults to CANOPY_BRAND or canopy)

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntrypoint } from './is-cli-entrypoint.mjs';
import { loadBrand } from './load-brand.mjs';
import { renderBrandedResources } from './render-branded-resources.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const brandCacheRoot = join(root, '.cache', 'brand');
const brandPrepareLockDir = join(brandCacheRoot, '.prepare.lock');
const lockWaitBuffer = new SharedArrayBuffer(4);
const lockWaitView = new Int32Array(lockWaitBuffer);
const BRAND_PREPARE_LOCK_TIMEOUT_MS = 120_000;
const BRAND_PREPARE_LOCK_STALE_MS = 10 * 60_000;

function parseArgs(argv) {
  const args = {
    brand: process.env.CANOPY_BRAND,
    all: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--brand') {
      args.brand = argv[i + 1];
      i += 1;
    } else if (arg === '--all') {
      args.all = true;
    }
  }
  return args;
}

function listBrandIds() {
  const brandsDir = join(root, 'brands');
  if (!existsSync(brandsDir)) return [];
  return readdirSync(brandsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function serializableBrand(brand) {
  const clone = { ...brand };
  delete clone.__paths;
  return clone;
}

function writeIfChanged(filePath, content) {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) {
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function sleep(ms) {
  Atomics.wait(lockWaitView, 0, 0, ms);
}

function withBrandPrepareLock(fn) {
  mkdirSync(brandCacheRoot, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(brandPrepareLockDir);
      writeFileSync(
        join(brandPrepareLockDir, 'owner.json'),
        `${JSON.stringify(
          { pid: process.pid, startedAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
      );
      break;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (code !== 'EEXIST') {
        throw error;
      }

      try {
        const stats = statSync(brandPrepareLockDir);
        if (Date.now() - stats.mtimeMs > BRAND_PREPARE_LOCK_STALE_MS) {
          rmSync(brandPrepareLockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt > BRAND_PREPARE_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for brand preparation lock at ${brandPrepareLockDir}`,
        );
      }
      sleep(100);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(brandPrepareLockDir, { recursive: true, force: true });
  }
}

function copyFile(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

function copyDir(source, target) {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function materializeDesktopBrand(brand) {
  const brandCacheDir = join(brandCacheRoot, brand.id);
  const resourcesDir = join(brandCacheDir, 'electron-resources');
  mkdirSync(resourcesDir, { recursive: true });

  const logoTarget = join(brandCacheDir, 'logo.svg');
  const appIconTarget = join(resourcesDir, 'icon.png');
  const macIconTarget = join(resourcesDir, 'icon.icns');
  const windowsIconTarget = join(resourcesDir, 'icon.ico');
  const windowsFullIconTarget = join(resourcesDir, 'icon-full.ico');
  const webIconTarget = join(resourcesDir, 'web-icon.png');
  const linuxIconTarget = join(resourcesDir, 'icons');

  copyFile(brand.__paths.logoSvg, logoTarget);
  copyFile(brand.__paths.appIconPng, appIconTarget);
  if (brand.__paths.macIconIcns) {
    copyFile(brand.__paths.macIconIcns, macIconTarget);
  } else {
    rmSync(macIconTarget, { force: true });
  }
  if (brand.__paths.windowsIconIco) {
    copyFile(brand.__paths.windowsIconIco, windowsIconTarget);
    copyFile(brand.__paths.windowsIconIco, windowsFullIconTarget);
  } else {
    rmSync(windowsIconTarget, { force: true });
    rmSync(windowsFullIconTarget, { force: true });
  }
  copyFile(brand.__paths.webIconPng, webIconTarget);
  if (brand.__paths.linuxIconDir) {
    copyDir(brand.__paths.linuxIconDir, linuxIconTarget);
  } else {
    rmSync(linuxIconTarget, { recursive: true, force: true });
    mkdirSync(linuxIconTarget, { recursive: true });
    copyFile(brand.__paths.appIconPng, join(linuxIconTarget, '512x512.png'));
  }

  renderBrandedResources(brand, {
    targetResources: join(brandCacheDir, 'resources'),
  });

  const cacheRelativePath = (path) => relative(root, path);

  const desktopBrand = {
    ...serializableBrand(brand),
    assets: {
      logoSvg: readFileSync(brand.__paths.logoSvg, 'utf8'),
      logoSvgPath: cacheRelativePath(logoTarget),
      appIconPng: cacheRelativePath(appIconTarget),
      macIconIcns: cacheRelativePath(
        brand.__paths.macIconIcns ? macIconTarget : appIconTarget,
      ),
      windowsIconIco: brand.__paths.windowsIconIco
        ? cacheRelativePath(windowsIconTarget)
        : cacheRelativePath(appIconTarget),
      linuxIconDir: cacheRelativePath(linuxIconTarget),
      webIconPng: cacheRelativePath(webIconTarget),
    },
  };

  writeIfChanged(
    join(brandCacheDir, 'current-brand.json'),
    `${JSON.stringify(serializableBrand(brand), null, 2)}\n`,
  );
  writeIfChanged(join(brandCacheDir, 'brand-id.txt'), `${brand.id}\n`);
  writeIfChanged(
    join(brandCacheDir, 'desktop-brand.ts'),
    [
      "import type { DesktopBrandRuntime } from '@canopy/protocol/brand';",
      '',
      `export const BRAND = ${JSON.stringify(desktopBrand, null, 2)} satisfies DesktopBrandRuntime;`,
      'export default BRAND;',
      '',
    ].join('\n'),
  );
}

function materializeCurrentIndirection(brandId) {
  const currentDir = join(brandCacheRoot, 'current');
  mkdirSync(currentDir, { recursive: true });
  writeIfChanged(
    join(currentDir, 'desktop-brand.ts'),
    [`export { BRAND, default } from '../${brandId}/desktop-brand';`, ''].join(
      '\n',
    ),
  );
}

function pruneStaleBrandCacheDirs(validBrandIds) {
  if (!existsSync(brandCacheRoot)) return;

  const valid = new Set([...validBrandIds, 'current']);
  for (const entry of readdirSync(brandCacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (valid.has(entry.name)) continue;

    rmSync(join(brandCacheRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

export function prepareBrand(brandId, options = {}) {
  // loadBrand validates logo SVG safety before any unsafe markup is cached.
  const brand = loadBrand(brandId, { repoRoot: root });
  withBrandPrepareLock(() => {
    pruneStaleBrandCacheDirs(listBrandIds());
    materializeDesktopBrand(brand);
    if (options.writeCurrent !== false) {
      materializeCurrentIndirection(brand.id);
    }
    if (options.log !== false) {
      const desktopPath = relative(
        root,
        join(brandCacheRoot, brand.id, 'desktop-brand.ts'),
      );
      process.stdout.write(
        `Prepared brand ${brand.id} (${brand.displayName}) at ${desktopPath}\n`,
      );
    }
  });
  return brand;
}

export function prepareAllBrands(options = {}) {
  const brandIds = listBrandIds();
  if (options.currentBrand && !brandIds.includes(options.currentBrand)) {
    throw new Error(
      `Current brand "${options.currentBrand}" was requested but no matching brand pack exists.`,
    );
  }
  // loadBrand validates logo SVG safety before any unsafe markup is cached.
  const brands = brandIds.map((brandId) =>
    loadBrand(brandId, { repoRoot: root }),
  );
  withBrandPrepareLock(() => {
    pruneStaleBrandCacheDirs(brandIds);
    for (const brand of brands) {
      materializeDesktopBrand(brand);
    }

    const currentBrandId = brandIds.includes(options.currentBrand)
      ? options.currentBrand
      : brandIds.includes('canopy')
        ? 'canopy'
        : brandIds[0];
    if (options.writeCurrent !== false && currentBrandId) {
      materializeCurrentIndirection(currentBrandId);
    }
    if (options.log !== false) {
      process.stdout.write(
        `Prepared ${brands.length} brand pack(s): ${brandIds.join(', ')}\n`,
      );
    }
  });
  return brands;
}

if (isCliEntrypoint(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    prepareAllBrands({ currentBrand: args.brand });
  } else {
    prepareBrand(args.brand ?? 'canopy');
  }
}
