#!/usr/bin/env node
// Derives optional web, Windows, Linux, and macOS icon assets from assets.appIconPng.
// Usage: pnpm run brand:generate-icons [--brand <id> | --all] [--force] [--no-manifest]

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { isCliEntrypoint } from './is-cli-entrypoint.mjs';
import { loadBrand } from './load-brand.mjs';

const defaultRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512];
const macIconCanvasSize = 1024;
const macIconInset = 100;
const macIconContentRatio =
  (macIconCanvasSize - macIconInset * 2) / macIconCanvasSize;
const icnsEntries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function parseArgs(argv) {
  const args = {
    all: false,
    brand: process.env.CANOPY_BRAND ?? 'canopy',
    force: false,
    root: defaultRoot,
    updateManifest: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--brand') {
      args.brand = argv[i + 1];
      i += 1;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--root') {
      args.root = resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--no-manifest') {
      args.updateManifest = false;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return [
    'Usage: pnpm run brand:generate-icons [--brand <id> | --all] [--force] [--no-manifest]',
    '',
    'Generates optional brand icon assets from assets.appIconPng:',
    '  - web-icon.png',
    '  - icon-full.ico',
    '  - icons/{size}x{size}.png',
    '  - icon.icns on macOS when iconutil is available',
  ].join('\n');
}

function listBrandIds(root) {
  const brandsDir = join(root, 'brands');
  if (!existsSync(brandsDir)) return [];
  return import('node:fs').then(({ readdirSync }) =>
    readdirSync(brandsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right)),
  );
}

function toBrandRelativePath(brandDir, target) {
  const relativePath = relative(brandDir, target);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return target;
  }
  return `./${relativePath.split(sep).join('/')}`;
}

function resolveBrandAssetPath(brandDir, value, fallback) {
  return resolve(brandDir, value ?? fallback);
}

async function renderPng(source, size) {
  return sharp(source)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function getAlphaBounds(source) {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export async function renderMacIconPng(source, size) {
  const contentSize = Math.max(1, Math.round(size * macIconContentRatio));
  const inset = Math.floor((size - contentSize) / 2);
  const bounds = await getAlphaBounds(source);
  const sourceImage = bounds ? sharp(source).extract(bounds) : sharp(source);
  const content = await sourceImage
    .resize(contentSize, contentSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: content, left: inset, top: inset }])
    .png()
    .toBuffer();
}

async function writeGeneratedFile(target, content, force) {
  if (existsSync(target) && !force) {
    return { path: target, status: 'existing' };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return { path: target, status: 'generated' };
}

function createIcoBuffer(images) {
  const headerSize = 6;
  const entrySize = 16;
  const imageOffset = headerSize + entrySize * images.length;
  const totalSize =
    imageOffset + images.reduce((size, image) => size + image.buffer.length, 0);
  const ico = Buffer.alloc(totalSize);
  let offset = 0;
  ico.writeUInt16LE(0, offset);
  offset += 2;
  ico.writeUInt16LE(1, offset);
  offset += 2;
  ico.writeUInt16LE(images.length, offset);
  offset += 2;

  let dataOffset = imageOffset;
  for (const image of images) {
    ico.writeUInt8(image.size >= 256 ? 0 : image.size, offset);
    offset += 1;
    ico.writeUInt8(image.size >= 256 ? 0 : image.size, offset);
    offset += 1;
    ico.writeUInt8(0, offset);
    offset += 1;
    ico.writeUInt8(0, offset);
    offset += 1;
    ico.writeUInt16LE(1, offset);
    offset += 2;
    ico.writeUInt16LE(32, offset);
    offset += 2;
    ico.writeUInt32LE(image.buffer.length, offset);
    offset += 4;
    ico.writeUInt32LE(dataOffset, offset);
    offset += 4;
    image.buffer.copy(ico, dataOffset);
    dataOffset += image.buffer.length;
  }

  return ico;
}

async function generateIco(source, target, force) {
  if (existsSync(target) && !force) {
    return { path: target, status: 'existing' };
  }
  const images = [];
  for (const size of icoSizes) {
    images.push({ size, buffer: await renderPng(source, size) });
  }
  return writeGeneratedFile(target, createIcoBuffer(images), force);
}

async function generateLinuxIcons(source, targetDir, force) {
  const results = [];
  mkdirSync(targetDir, { recursive: true });
  for (const size of linuxSizes) {
    const target = join(targetDir, `${size}x${size}.png`);
    results.push(
      await writeGeneratedFile(target, await renderPng(source, size), force),
    );
  }
  return results;
}

async function generateIcns(source, target, force) {
  if (existsSync(target) && !force) {
    return { path: target, status: 'existing' };
  }
  if (process.platform !== 'darwin') {
    return {
      path: target,
      status: 'skipped',
      reason: 'iconutil is macOS-only',
    };
  }

  const iconsetDir = mkdtempSync(join(tmpdir(), 'canopy-brand-icons-'));
  const iconsetPath = join(iconsetDir, 'AppIcon.iconset');
  mkdirSync(iconsetPath);
  try {
    for (const [name, size] of icnsEntries) {
      writeFileSync(
        join(iconsetPath, name),
        await renderMacIconPng(source, size),
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    try {
      execFileSync('iconutil', ['-c', 'icns', iconsetPath, '-o', target], {
        stdio: 'pipe',
      });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return {
          path: target,
          status: 'skipped',
          reason: 'iconutil not found',
        };
      }
      throw error;
    }
    return { path: target, status: 'generated' };
  } finally {
    rmSync(iconsetDir, { recursive: true, force: true });
  }
}

function updateManifestAssets(manifestPath, updates) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.assets = { ...(manifest.assets ?? {}) };
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && manifest.assets[key] !== value) {
      manifest.assets[key] = value;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return changed;
}

function shouldLog(options) {
  return options.log !== false;
}

function logResult(brandId, label, result, options) {
  if (!shouldLog(options)) return;
  const suffix = result.reason ? ` (${result.reason})` : '';
  process.stdout.write(`${brandId}: ${label} ${result.status}${suffix}\n`);
}

export async function generateBrandIcons(brandId, options) {
  const brand = loadBrand(brandId, { repoRoot: options.root });
  const manifest = JSON.parse(readFileSync(brand.__paths.manifestPath, 'utf8'));
  const metadata = await sharp(brand.__paths.appIconPng).metadata();
  if (metadata.format !== 'png') {
    throw new Error(`${brandId}: assets.appIconPng must be a PNG file`);
  }

  const brandDir = brand.__paths.brandDir;
  const webIconPath = resolveBrandAssetPath(
    brandDir,
    manifest.assets.webIconPng,
    './web-icon.png',
  );
  const windowsIconPath = resolveBrandAssetPath(
    brandDir,
    manifest.assets.windowsIconIco,
    './icon-full.ico',
  );
  const linuxIconDir = resolveBrandAssetPath(
    brandDir,
    manifest.assets.linuxIconDir,
    './icons',
  );
  const macIconPath = resolveBrandAssetPath(
    brandDir,
    manifest.assets.macIconIcns,
    './icon.icns',
  );

  const webResult = await writeGeneratedFile(
    webIconPath,
    await renderPng(brand.__paths.appIconPng, 256),
    options.force,
  );
  logResult(brandId, 'web PNG icon', webResult, options);

  const icoResult = await generateIco(
    brand.__paths.appIconPng,
    windowsIconPath,
    options.force,
  );
  logResult(brandId, 'Windows ICO', icoResult, options);

  const linuxResults = await generateLinuxIcons(
    brand.__paths.appIconPng,
    linuxIconDir,
    options.force,
  );
  const linuxGenerated = linuxResults.filter(
    (result) => result.status === 'generated',
  ).length;
  if (shouldLog(options)) {
    process.stdout.write(
      `${brandId}: Linux PNG icons ${linuxGenerated > 0 ? `generated ${linuxGenerated}` : 'existing'}\n`,
    );
  }

  const icnsResult = await generateIcns(
    brand.__paths.appIconPng,
    macIconPath,
    options.force,
  );
  logResult(brandId, 'macOS ICNS', icnsResult, options);

  let manifestChanged = false;
  if (options.updateManifest) {
    manifestChanged = updateManifestAssets(brand.__paths.manifestPath, {
      webIconPng: toBrandRelativePath(brandDir, webIconPath),
      windowsIconIco: toBrandRelativePath(brandDir, windowsIconPath),
      linuxIconDir: toBrandRelativePath(brandDir, linuxIconDir),
      macIconIcns:
        icnsResult.status === 'skipped'
          ? manifest.assets.macIconIcns
          : toBrandRelativePath(brandDir, macIconPath),
    });
    if (shouldLog(options)) {
      process.stdout.write(
        `${brandId}: brand.json ${manifestChanged ? 'updated' : 'unchanged'}\n`,
      );
    }
  }

  return {
    webIcon: webResult,
    windowsIcon: icoResult,
    linuxIcons: linuxResults,
    macIcon: icnsResult,
    manifestChanged,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const brandIds = args.all ? await listBrandIds(args.root) : [args.brand];
  if (brandIds.length === 0) {
    throw new Error(`No brand packs found under ${join(args.root, 'brands')}`);
  }
  for (const brandId of brandIds) {
    await generateBrandIcons(brandId, args);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
