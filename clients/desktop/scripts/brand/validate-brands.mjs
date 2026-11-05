#!/usr/bin/env node
// Validates all brand manifests, required assets, optional assets, and global uniqueness.
// Usage: pnpm run brand:validate

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { collectLogoSvgSafetyErrors, loadBrand } from './load-brand.mjs';
import { isCliEntrypoint } from './is-cli-entrypoint.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const brandsDir = join(root, 'brands');

function listBrandIds() {
  if (!existsSync(brandsDir)) return [];
  return readdirSync(brandsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isPng(path) {
  const bytes = readFileSync(path).subarray(0, 8);
  return bytes.equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
}

function isIco(path) {
  const bytes = readFileSync(path).subarray(0, 4);
  return bytes.equals(Buffer.from([0x00, 0x00, 0x01, 0x00]));
}

function isIcns(path) {
  return readFileSync(path).subarray(0, 4).toString('ascii') === 'icns';
}

function assertAsset(errors, brandId, label, path, predicate, description) {
  const rel = relative(root, path);
  if (!existsSync(path)) {
    errors.push(`${brandId}: ${label} does not exist: ${rel}`);
    return;
  }
  if (!statSync(path).isFile()) {
    errors.push(`${brandId}: ${label} must be a file: ${rel}`);
    return;
  }
  if (!predicate(path)) {
    errors.push(`${brandId}: ${label} must be ${description}: ${rel}`);
  }
}

function isAllowedSvgLogoPaintValue(value) {
  return ['none', 'currentcolor', 'inherit'].includes(
    value.trim().toLowerCase(),
  );
}

function validateLogoSvgSafety(brand, errors, label, path) {
  const content = readFileSync(path, 'utf8');
  errors.push(...collectLogoSvgSafetyErrors(brand.id, content, label));
}

function validateLogoSvgInheritsColor(brand, errors, label, path) {
  const content = readFileSync(path, 'utf8');
  const attrPattern = /\b(fill|stroke)\s*=\s*(['"])(.*?)\2/gi;
  for (const match of content.matchAll(attrPattern)) {
    const [, attr, , value] = match;
    if (!isAllowedSvgLogoPaintValue(value)) {
      errors.push(
        `${brand.id}: ${label} ${attr} must use currentColor, inherit, or none so the app controls logo color`,
      );
    }
  }

  const stylePattern = /\bstyle\s*=\s*(['"])(.*?)\1/gi;
  for (const styleMatch of content.matchAll(stylePattern)) {
    const style = styleMatch[2];
    const declarationPattern = /(?:^|;)\s*(fill|stroke)\s*:\s*([^;]+)/gi;
    for (const declarationMatch of style.matchAll(declarationPattern)) {
      const [, property, value] = declarationMatch;
      if (!isAllowedSvgLogoPaintValue(value)) {
        errors.push(
          `${brand.id}: ${label} style ${property} must use currentColor, inherit, or none so the app controls logo color`,
        );
      }
    }
  }
}

function validateAssets(brand, manifest, errors) {
  assertAsset(
    errors,
    brand.id,
    'assets.logoSvg',
    brand.__paths.logoSvg,
    (path) =>
      extname(path).toLowerCase() === '.svg' &&
      /<svg[\s>]/i.test(readFileSync(path, 'utf8')),
    'an SVG file containing <svg>',
  );
  validateLogoSvgSafety(brand, errors, 'assets.logoSvg', brand.__paths.logoSvg);
  validateLogoSvgInheritsColor(
    brand,
    errors,
    'assets.logoSvg',
    brand.__paths.logoSvg,
  );
  if (brand.__paths.wordmarkSvg !== undefined) {
    assertAsset(
      errors,
      brand.id,
      'assets.wordmarkSvg',
      brand.__paths.wordmarkSvg,
      (path) =>
        extname(path).toLowerCase() === '.svg' &&
        /<svg[\s>]/i.test(readFileSync(path, 'utf8')),
      'an SVG file containing <svg>',
    );
    validateLogoSvgSafety(
      brand,
      errors,
      'assets.wordmarkSvg',
      brand.__paths.wordmarkSvg,
    );
    validateLogoSvgInheritsColor(
      brand,
      errors,
      'assets.wordmarkSvg',
      brand.__paths.wordmarkSvg,
    );
  }
  assertAsset(
    errors,
    brand.id,
    'assets.appIconPng',
    brand.__paths.appIconPng,
    (path) => extname(path).toLowerCase() === '.png' && isPng(path),
    'a PNG file',
  );
  if (manifest.assets.webIconPng !== undefined) {
    assertAsset(
      errors,
      brand.id,
      'assets.webIconPng',
      brand.__paths.webIconPng,
      (path) => extname(path).toLowerCase() === '.png' && isPng(path),
      'a PNG file',
    );
  }
  if (brand.__paths.macIconIcns !== undefined) {
    assertAsset(
      errors,
      brand.id,
      'assets.macIconIcns',
      brand.__paths.macIconIcns,
      (path) => extname(path).toLowerCase() === '.icns' && isIcns(path),
      'an ICNS file',
    );
  }
  if (brand.__paths.windowsIconIco !== undefined) {
    assertAsset(
      errors,
      brand.id,
      'assets.windowsIconIco',
      brand.__paths.windowsIconIco,
      (path) => extname(path).toLowerCase() === '.ico' && isIco(path),
      'an ICO file',
    );
  }
  if (brand.__paths.linuxIconDir !== undefined) {
    const rel = relative(root, brand.__paths.linuxIconDir);
    if (!statSync(brand.__paths.linuxIconDir).isDirectory()) {
      errors.push(
        `${brand.id}: assets.linuxIconDir must be a directory: ${rel}`,
      );
      return;
    }
    const pngFiles = readdirSync(brand.__paths.linuxIconDir).filter((entry) =>
      entry.toLowerCase().endsWith('.png'),
    );
    if (pngFiles.length === 0) {
      errors.push(
        `${brand.id}: assets.linuxIconDir must contain at least one PNG`,
      );
    }
  }
}

// internalName doubles as the brand's custom URL scheme: the mobile OAuth
// callback (`<scheme>://auth`, scripts/brand/generate-mobile-brand.mjs) and
// the desktop share deep links (`<scheme>://share/...`, CAN-2361 —
// packages/protocol/src/share-deep-link). Both silently break on a
// non-scheme-safe token, so enforce the shape here for every brand.
const URL_SCHEME_SAFE_PATTERN = /^[a-z][a-z0-9+.-]*$/;

function validateInternalNameSchemeSafety(brand, errors) {
  if (!URL_SCHEME_SAFE_PATTERN.test(String(brand.internalName))) {
    errors.push(
      `${brand.id}: internalName "${brand.internalName}" must be a URL-scheme-safe token matching ${String(URL_SCHEME_SAFE_PATTERN)} (used as the mobile OAuth and desktop deep-link scheme)`,
    );
  }
}

function addUnique(seen, errors, key, value, brandId) {
  if (typeof value !== 'string' || value.length === 0) return;
  const normalized =
    key.endsWith('header') || key === 'web.hostname'
      ? value.toLowerCase()
      : value;
  const previous = seen.get(`${key}:${normalized}`);
  if (previous) {
    errors.push(`${brandId}: ${key} "${value}" duplicates ${previous}`);
    return;
  }
  seen.set(`${key}:${normalized}`, brandId);
}

export function validateGlobalUniqueness(brands, errors) {
  const seen = new Map();
  for (const brand of brands) {
    addUnique(seen, errors, 'id', brand.id, brand.id);
    addUnique(seen, errors, 'internalName', brand.internalName, brand.id);
    addUnique(seen, errors, 'cliName', brand.cliName, brand.id);
    addUnique(seen, errors, 'appId', brand.appId, brand.id);
    addUnique(seen, errors, 'tools.namespace', brand.tools.namespace, brand.id);
    addUnique(
      seen,
      errors,
      'desktopIntegration.routePrefix',
      brand.desktopIntegration.routePrefix,
      brand.id,
    );
    addUnique(
      seen,
      errors,
      'desktopIntegration.tokenHeaderName.header',
      brand.desktopIntegration.tokenHeaderName,
      brand.id,
    );
    addUnique(
      seen,
      errors,
      'desktopIntegration.tokenEnvVar',
      brand.desktopIntegration.tokenEnvVar,
      brand.id,
    );
    addUnique(
      seen,
      errors,
      'dictation.binaryName',
      brand.dictation.binaryName,
      brand.id,
    );
    addUnique(
      seen,
      errors,
      'dictation.bundleId',
      brand.dictation.bundleId,
      brand.id,
    );
    addUnique(
      seen,
      errors,
      'web.wellKnownNamespace',
      brand.web.wellKnownNamespace,
      brand.id,
    );
    addUnique(
      seen,
      errors,
      'release.artifactPrefix',
      brand.release.artifactPrefix,
      brand.id,
    );

    const primaryStorageValues = [
      ['storage.dataDirNames.prod[0]', brand.storage.dataDirNames.prod[0]],
      ['storage.dataDirNames.rc[0]', brand.storage.dataDirNames.rc[0]],
      ['storage.dataDirNames.dev[0]', brand.storage.dataDirNames.dev[0]],
      [
        'storage.secureDataDirNames.prod',
        brand.storage.secureDataDirNames.prod,
      ],
      ['storage.secureDataDirNames.rc', brand.storage.secureDataDirNames.rc],
      [
        'storage.secureDataDirNames.internal',
        brand.storage.secureDataDirNames.internal,
      ],
      ['storage.secureDataDirNames.dev', brand.storage.secureDataDirNames.dev],
      ['storage.configFileNames[0]', brand.storage.configFileNames[0]],
      [
        'storage.projectConfigDirNames[0]',
        brand.storage.projectConfigDirNames[0],
      ],
      ['environment.prefixes[0]', brand.environment.prefixes[0]],
    ];
    for (const [key, value] of primaryStorageValues) {
      addUnique(seen, errors, key, value, brand.id);
    }
    for (const hostname of brand.web.hostnames) {
      addUnique(seen, errors, 'web.hostname', hostname, brand.id);
    }
  }
  const directoryCollisionKey = (value) =>
    value
      .trim()
      .replace(/[. ]+$/u, '')
      .normalize('NFC')
      .toLowerCase();
  for (const owner of brands) {
    for (const devDir of owner.storage.dataDirNames.dev) {
      const devDirKey = directoryCollisionKey(devDir);
      for (const candidate of brands) {
        for (const mode of ['prod', 'rc']) {
          if (
            candidate.storage.dataDirNames[mode].some(
              (name) => directoryCollisionKey(name) === devDirKey,
            )
          ) {
            errors.push(
              `${owner.id}: storage.dataDirNames.dev "${devDir}" collides with ${candidate.id} storage.dataDirNames.${mode}`,
            );
          }
        }
      }
    }
    const internalSecureDir = owner.storage.secureDataDirNames.internal;
    const internalSecureDirKey = directoryCollisionKey(internalSecureDir);
    for (const candidate of brands) {
      for (const [mode, dataDirNames] of Object.entries(
        candidate.storage.dataDirNames,
      )) {
        if (
          dataDirNames.some(
            (dataDirName) =>
              directoryCollisionKey(dataDirName) === internalSecureDirKey,
          )
        ) {
          errors.push(
            `${owner.id}: storage.secureDataDirNames.internal collides with ${candidate.id} storage.dataDirNames.${mode}`,
          );
        }
      }
      for (const [mode, secureDir] of Object.entries(
        candidate.storage.secureDataDirNames,
      )) {
        if (
          internalSecureDirKey === directoryCollisionKey(secureDir) &&
          (owner.id !== candidate.id || mode !== 'internal')
        ) {
          errors.push(
            `${owner.id}: storage.secureDataDirNames.internal "${internalSecureDir}" duplicates ${candidate.id} storage.secureDataDirNames.${mode}`,
          );
        }
      }
    }
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePluginName(brandId, name, context, errors) {
  if (!/^[a-z0-9-]+$/.test(name) || name.includes('/') || /\s/.test(name)) {
    errors.push(`${brandId}: ${context} plugin name must match /^[a-z0-9-]+$/`);
  }
}

function listPluginDirs(rootDir) {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootDir, entry.name));
}

function readYaml(path, brandId, errors) {
  try {
    const parsed = yaml.load(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    errors.push(
      `${brandId}: ${relative(root, path)} is invalid YAML: ${error}`,
    );
    return null;
  }
}

function validateSourcePluginDir(brand, pluginDir, errors) {
  const pluginName = pluginDir.split(/[\\/]/).pop() ?? '';
  validatePluginName(brand.id, pluginName, relative(root, pluginDir), errors);
  const manifestPath = join(pluginDir, 'plugin.yaml');
  if (!existsSync(manifestPath)) {
    errors.push(
      `${brand.id}: ${relative(root, pluginDir)} missing plugin.yaml`,
    );
    return;
  }
  const manifest = readYaml(manifestPath, brand.id, errors);
  if (!manifest) return;
  if (manifest.name !== pluginName) {
    errors.push(
      `${brand.id}: ${relative(root, manifestPath)} name must match directory name`,
    );
  }
  for (const key of ['version', 'description', 'category']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) {
      errors.push(
        `${brand.id}: ${relative(root, manifestPath)} ${key} is required`,
      );
    }
  }
  if (
    !isRecord(manifest.author) ||
    typeof manifest.author.name !== 'string' ||
    !manifest.author.name.trim()
  ) {
    errors.push(
      `${brand.id}: ${relative(root, manifestPath)} author.name is required`,
    );
  }
}

function validatePreparedPluginDir(brand, pluginDir, errors) {
  const pluginName = pluginDir.split(/[\\/]/).pop() ?? '';
  validatePluginName(brand.id, pluginName, relative(root, pluginDir), errors);
  const claudeDir = join(pluginDir, 'claude');
  const codexDir = join(pluginDir, 'codex');
  const claudeManifest = join(
    pluginDir,
    'claude',
    '.claude-plugin',
    'plugin.json',
  );
  const codexManifest = join(
    pluginDir,
    'codex',
    '.codex-plugin',
    'plugin.json',
  );
  if (existsSync(claudeDir) && !existsSync(claudeManifest)) {
    errors.push(
      `${brand.id}: ${relative(root, claudeDir)} prepared Claude bundle must contain .claude-plugin/plugin.json`,
    );
  }
  if (existsSync(codexDir) && !existsSync(codexManifest)) {
    errors.push(
      `${brand.id}: ${relative(root, codexDir)} prepared Codex bundle must contain .codex-plugin/plugin.json`,
    );
  }
  if (!existsSync(claudeManifest) && !existsSync(codexManifest)) {
    errors.push(
      `${brand.id}: ${relative(root, pluginDir)} prepared plugin must contain a claude or codex provider manifest`,
    );
  }
  for (const manifestPath of [claudeManifest, codexManifest]) {
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!isRecord(manifest)) {
        errors.push(
          `${brand.id}: ${relative(root, manifestPath)} must be a JSON object`,
        );
      }
    } catch (error) {
      errors.push(
        `${brand.id}: ${relative(root, manifestPath)} is invalid JSON: ${error}`,
      );
    }
  }
}

function validateMarketplaceSourcePath(
  brandId,
  pluginsRoot,
  source,
  context,
  errors,
) {
  const resolved = resolve(pluginsRoot, source);
  const relativePath = relative(resolve(pluginsRoot), resolved);
  if (relativePath.startsWith('..') || relativePath === '..') {
    errors.push(`${brandId}: ${context} source escapes resources/plugins`);
  }
}

function rejectGeneratedPluginYaml(brandId, dir, errors) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      rejectGeneratedPluginYaml(brandId, entryPath, errors);
    } else if (entry.isFile() && entry.name === 'plugin.yaml') {
      errors.push(
        `${brandId}: generated plugin output must not contain ${relative(root, entryPath)}`,
      );
    }
  }
}

function validateGeneratedMarketplace(brand, errors) {
  const pluginsRoot = join(
    root,
    '.cache',
    'brand',
    brand.id,
    'resources',
    'plugins',
  );
  if (!existsSync(pluginsRoot)) return;
  rejectGeneratedPluginYaml(brand.id, pluginsRoot, errors);
  const claudeManifest = join(
    pluginsRoot,
    '.claude-plugin',
    'marketplace.json',
  );
  if (existsSync(claudeManifest)) {
    const manifest = readJson(claudeManifest);
    for (const plugin of manifest.plugins ?? []) {
      if (typeof plugin.source === 'string') {
        validateMarketplaceSourcePath(
          brand.id,
          pluginsRoot,
          plugin.source,
          relative(root, claudeManifest),
          errors,
        );
      }
    }
  }
  const codexManifest = join(
    pluginsRoot,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  if (existsSync(codexManifest)) {
    const manifest = readJson(codexManifest);
    for (const plugin of manifest.plugins ?? []) {
      const sourcePath = plugin?.source?.path;
      if (typeof sourcePath === 'string') {
        validateMarketplaceSourcePath(
          brand.id,
          pluginsRoot,
          sourcePath,
          relative(root, codexManifest),
          errors,
        );
      }
    }
  }
}

function validateBrandPlugins(brand, errors) {
  for (const pluginDir of [
    ...listPluginDirs(join(root, 'brand-templates', 'plugins')),
    ...listPluginDirs(join(root, 'brands', brand.id, 'plugins')),
  ]) {
    validateSourcePluginDir(brand, pluginDir, errors);
  }
  for (const pluginDir of [
    ...listPluginDirs(join(root, 'brand-templates', 'prepared-plugins')),
    ...listPluginDirs(join(root, 'brands', brand.id, 'prepared-plugins')),
  ]) {
    validatePreparedPluginDir(brand, pluginDir, errors);
  }
  validateGeneratedMarketplace(brand, errors);
}

function main() {
  const errors = [];
  const brands = [];

  for (const brandId of listBrandIds()) {
    try {
      const brand = loadBrand(brandId, { repoRoot: root });
      const manifest = readJson(join(brandsDir, brandId, 'brand.json'));
      validateAssets(brand, manifest, errors);
      validateInternalNameSchemeSafety(brand, errors);
      validateBrandPlugins(brand, errors);
      brands.push(brand);
    } catch (error) {
      errors.push(
        `${brandId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  validateGlobalUniqueness(brands, errors);

  if (errors.length > 0) {
    process.stderr.write(`Brand validation failed:\n${errors.join('\n')}\n`);
    process.exit(1);
  }

  process.stdout.write(`Validated ${brands.length} brand pack(s).\n`);
}

if (isCliEntrypoint(import.meta.url)) main();
