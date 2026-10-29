#!/usr/bin/env node
// Renders shared resource templates and brand-specific skills into the brand cache.
// Usage: node scripts/brand/render-branded-resources.mjs [--brand <id>]

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntrypoint } from './is-cli-entrypoint.mjs';
import { loadBrand, repoRoot } from './load-brand.mjs';
import { renderBrandedPlugins } from './render-branded-plugins.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

function toJsIdentifier(value) {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join('');
}

export function replaceTokens(content, brand) {
  const primaryEnv = brand.environment.prefixes[0];
  const primaryConfigFile = brand.storage.configFileNames[0];
  const primaryProjectDir = brand.storage.projectConfigDirNames[0];
  const namespace = brand.tools.namespace;
  const expressionRoot = toJsIdentifier(brand.internalName);
  const reportActionId = 'pipeline-report';
  const outputVariableName = 'brandOutput';
  return content
    .replaceAll('{{BRAND_DISPLAY_NAME}}', brand.displayName)
    .replaceAll('{{BRAND_SERVER_DISPLAY_NAME}}', brand.serverDisplayName)
    .replaceAll('{{BRAND_CLI_NAME}}', brand.cliName)
    .replaceAll('{{BRAND_INTERNAL_NAME}}', brand.internalName)
    .replaceAll('{{BRAND_CONFIG_FILE}}', primaryConfigFile)
    .replaceAll('{{BRAND_PROJECT_CONFIG_DIR}}', primaryProjectDir)
    .replaceAll('{{BRAND_ENV_PREFIX}}', primaryEnv)
    .replaceAll(
      '{{BRAND_GET_SCRIPT_OUTPUT_CLAUDE_TOOL}}',
      `mcp__${namespace}__GetScriptOutput`,
    )
    .replaceAll(
      '{{BRAND_GET_SCRIPT_OUTPUT_CODEX_TOOL}}',
      `${namespace}_get_script_output`,
    )
    .replaceAll(
      '{{BRAND_WATCH_COMMAND_CLAUDE_TOOL}}',
      `mcp__${namespace}__WatchCommand`,
    )
    .replaceAll(
      '{{BRAND_WATCH_COMMAND_CODEX_TOOL}}',
      `${namespace}_watch_command`,
    )
    .replaceAll('{{BRAND_EXPRESSION_ROOT}}', expressionRoot)
    .replaceAll('{{BRAND_REPORT_ACTION_ID}}', reportActionId)
    .replaceAll('{{BRAND_OUTPUT_VARIABLE_NAME}}', outputVariableName);
}

function replacePathTokens(value, brand) {
  return replaceTokens(value, brand);
}

// Token replacement must only ever touch text files. Reading a binary file
// (e.g. the code-graph grammar/runtime `.wasm` blobs) as utf8 replaces every
// invalid byte sequence with U+FFFD, so writing the decoded string back
// corrupts the file even when no token matches — a branded
// web-tree-sitter.wasm rendered this way inflated ~8% and failed
// WebAssembly.instantiate with "unknown section code #0x1e @+28" in the dev
// app (dev resource resolution prefers `.cache/brand/<id>/resources` over the
// pristine workspace tree). A file is treated as text only when its bytes
// survive a utf8 decode/encode round trip losslessly; everything else is
// copied byte-for-byte with no token replacement.
export function renderResourceFile(sourcePath, targetPath, brand) {
  const raw = readFileSync(sourcePath);
  const decoded = raw.toString('utf8');
  if (Buffer.compare(Buffer.from(decoded, 'utf8'), raw) === 0) {
    writeFileSync(targetPath, replaceTokens(decoded, brand), 'utf8');
    return;
  }
  writeFileSync(targetPath, raw);
}

function copyWithTokens(sourceDir, targetDir, brand) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, replacePathTokens(entry.name, brand));
    if (entry.isDirectory()) {
      copyWithTokens(sourcePath, targetPath, brand);
      continue;
    }
    if (entry.isFile()) {
      renderResourceFile(sourcePath, targetPath, brand);
    }
  }
}

function snapshotBuiltActionOutputs(targetResources) {
  const actionsDir = join(targetResources, 'actions');
  const snapshots = new Map();
  if (!existsSync(actionsDir)) {
    return snapshots;
  }

  for (const entry of readdirSync(actionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const actionDir = join(actionsDir, entry.name);
    const files = new Map();
    for (const fileName of ['index.js', 'index.js.map']) {
      const filePath = join(actionDir, fileName);
      if (existsSync(filePath)) {
        files.set(fileName, readFileSync(filePath));
      }
    }
    if (files.size > 0) {
      snapshots.set(entry.name, files);
    }
  }

  return snapshots;
}

function restoreBuiltActionOutputs(targetResources, snapshots) {
  const actionsDir = join(targetResources, 'actions');
  for (const [actionName, files] of snapshots) {
    const actionDir = join(actionsDir, actionName);
    if (!existsSync(join(actionDir, 'action.yml'))) {
      continue;
    }
    for (const [fileName, content] of files) {
      const targetPath = join(actionDir, fileName);
      if (!existsSync(targetPath)) {
        writeFileSync(targetPath, content);
      }
    }
  }
}

export function renderBrandedResources(brand, options = {}) {
  const sourceResources =
    options.sourceResources ??
    join(repoRoot, 'packages', 'desktop-shared', 'resources');
  const sourceSkillTemplates =
    options.sourceSkillTemplates ?? join(repoRoot, 'brand-templates', 'skills');
  const sourceBrandSkills =
    options.sourceBrandSkills ?? join(repoRoot, 'brands', brand.id, 'skills');
  const sourcePluginTemplates =
    options.sourcePluginTemplates ??
    join(repoRoot, 'brand-templates', 'plugins');
  const sourceBrandPlugins =
    options.sourceBrandPlugins ?? join(repoRoot, 'brands', brand.id, 'plugins');
  const sourcePreparedPluginTemplates =
    options.sourcePreparedPluginTemplates ??
    join(repoRoot, 'brand-templates', 'prepared-plugins');
  const sourceBrandPreparedPlugins =
    options.sourceBrandPreparedPlugins ??
    join(repoRoot, 'brands', brand.id, 'prepared-plugins');
  const targetResources =
    options.targetResources ??
    join(repoRoot, '.cache', 'brand', brand.id, 'resources');
  if (
    !existsSync(sourceResources) ||
    !statSync(sourceResources).isDirectory()
  ) {
    throw new Error(`Resource source directory not found: ${sourceResources}`);
  }
  const builtActionOutputs = snapshotBuiltActionOutputs(targetResources);
  rmSync(targetResources, { recursive: true, force: true });
  mkdirSync(targetResources, { recursive: true });
  for (const entry of readdirSync(sourceResources, { withFileTypes: true })) {
    if (entry.name === 'skills') {
      throw new Error(
        'Bundled skills must live under brand-templates/skills or brands/<id>/skills',
      );
    }
    const sourcePath = join(sourceResources, entry.name);
    const targetPath = join(targetResources, entry.name);
    if (entry.isDirectory()) {
      copyWithTokens(sourcePath, targetPath, brand);
    } else if (entry.isFile()) {
      renderResourceFile(sourcePath, targetPath, brand);
    }
  }
  const skillsDir = join(targetResources, 'skills');
  if (existsSync(sourceSkillTemplates)) {
    copyWithTokens(sourceSkillTemplates, skillsDir, brand);
  }
  if (existsSync(sourceBrandSkills)) {
    copyWithTokens(sourceBrandSkills, skillsDir, brand);
  }
  renderBrandedPlugins(brand, {
    targetResources,
    replaceTokens,
    sourcePluginTemplates,
    sourceBrandPlugins,
    sourcePreparedPluginTemplates,
    sourceBrandPreparedPlugins,
  });
  restoreBuiltActionOutputs(targetResources, builtActionOutputs);
  return targetResources;
}

if (isCliEntrypoint(import.meta.url)) {
  const brandArgIndex = process.argv.indexOf('--brand');
  const brandId =
    brandArgIndex >= 0
      ? process.argv[brandArgIndex + 1]
      : (process.env.CANOPY_BRAND ?? 'canopy');
  const brand = loadBrand(brandId, { repoRoot: root });
  const output = renderBrandedResources(brand);
  process.stdout.write(`Rendered ${brand.id} resources at ${output}\n`);
}
