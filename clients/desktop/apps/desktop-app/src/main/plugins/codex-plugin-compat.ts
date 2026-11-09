import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { BRAND } from '@canopy/brand/current';
import {
  CANOPY_COMPATIBILITY_VERSION,
  claudeModCodexWarning,
  comparePluginPaths,
  createGeneratedSkillName,
  normalizePluginCategory,
  projectClaudePluginForCodex,
  projectClaudePluginMcpEnvironment,
  projectStandaloneMcpServersForCodex,
  type PluginFileContent,
  type ProjectClaudePluginForCodexInput,
} from '@canopy/plugin-interop';
import type { PluginManifest } from '@canopy/desktop-shared/types/plugins';
import { safeReadJson, safeReadText } from '../lib/fs-utils';
import { parseFrontmatter, parseFrontmatterAndBody } from '../lib/frontmatter';
import { isPathInside } from '../lib/path-safety';
import { getCodexCompatibilityCacheRootDir } from '../lib/paths';
import { scanPluginMods } from './plugin-scanner';
import {
  discoverPluginMarkdownMembers,
  discoverPluginSkills,
  normalizePaths,
  type ClaudeSkillSource,
  type ParsedFrontmatter,
} from './plugin-members';

export type { ClaudeSkillSource, ParsedFrontmatter } from './plugin-members';

export { CANOPY_COMPATIBILITY_VERSION, createGeneratedSkillName };
export const BUILTIN_APP_PLUGIN_NAME = 'builtin-app-plugin';

export interface ClaudeCommandSource {
  name: string;
  description: string;
  filePath: string;
}

export interface ClaudeAgentSource {
  name: string;
  description: string;
  filePath: string;
}

interface CompatibilitySidecar {
  canopyCompatibilityVersion: number;
  sourcePluginName: string;
  sourceVersion: string;
  sourceLastUpdatedAt: string;
}

export interface CodexCompatibilityFreshness {
  sourceVersion: string;
  sourceLastUpdatedAt: string;
  compatibilityVersion: number;
}

export interface CodexCompatibilityPluginResult {
  cacheDir: string;
  pluginName: string;
  category: string;
  warnings: string[];
  freshness: CodexCompatibilityFreshness;
}

export interface ClaudePluginCompatibilitySource {
  pluginName: string;
  pluginPath: string;
  marketplaceId: string;
  category: string;
  manifest: PluginManifest | null;
  rawManifest: Record<string, unknown>;
  skills: ClaudeSkillSource[];
  commands: ClaudeCommandSource[];
  agents: ClaudeAgentSource[];
  sourceVersion: string;
  sourceLastUpdatedAt: string;
  /** Member roots that were skipped during discovery, for the user to see. */
  warnings: string[];
}

export interface AggregateSkillSource {
  name: string;
  description: string;
  sourceDir: string;
  skillMdPath: string;
}

export interface PluginProjectionPlan {
  generatedCommandNames: Map<string, string>;
  generatedAgentNames: Map<string, string>;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeProjectedFiles(
  root: string,
  files: ReadonlyMap<string, PluginFileContent>,
): void {
  for (const [relativePath, content] of Array.from(files.entries()).sort(
    ([left], [right]) => comparePluginPaths(left, right),
  )) {
    const destination = path.join(root, ...relativePath.split('/'));
    ensureDir(path.dirname(destination));
    fs.writeFileSync(destination, content);
  }
}

function readPluginFileMap(pluginPath: string): Map<string, PluginFileContent> {
  const files = new Map<string, PluginFileContent>();
  const walk = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => comparePluginPaths(left.name, right.name))) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          'Refusing Claude plugin compatibility projection through a symlinked source path.',
        );
      }
      if (stat.isDirectory()) {
        walk(entryPath);
      } else if (stat.isFile()) {
        const relativePath = path
          .relative(pluginPath, entryPath)
          .split(path.sep)
          .join('/');
        files.set(relativePath, new Uint8Array(fs.readFileSync(entryPath)));
      }
    }
  };
  const rootStat = fs.lstatSync(pluginPath);
  if (rootStat.isSymbolicLink()) {
    throw new Error(
      'Refusing Claude plugin compatibility projection through a symlinked source path.',
    );
  }
  walk(pluginPath);
  return files;
}

function collectRecursiveFiles(targetPath: string, files: string[]): void {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    files.push(targetPath);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    collectRecursiveFiles(path.join(targetPath, entry.name), files);
  }
}

function collectFreshnessCandidatePaths(
  pluginPath: string,
  manifest: PluginManifest | null,
): string[] {
  const results = new Set<string>([
    path.join(pluginPath, '.claude-plugin', 'plugin.json'),
    path.join(pluginPath, 'skills'),
    path.join(pluginPath, 'commands'),
    path.join(pluginPath, 'agents'),
    path.join(pluginPath, 'references'),
    path.join(pluginPath, 'assets'),
    path.join(pluginPath, 'hooks'),
    path.join(pluginPath, '.mcp.json'),
    path.join(pluginPath, '.app.json'),
    path.join(pluginPath, 'index.md'),
    path.join(pluginPath, 'README.md'),
  ]);
  const manifestPaths = [
    ...normalizePaths(manifest?.skills),
    ...normalizePaths(manifest?.commands),
    ...normalizePaths(manifest?.agents),
    ...normalizePaths(
      typeof manifest?.hooks === 'string' || Array.isArray(manifest?.hooks)
        ? manifest.hooks
        : undefined,
    ),
    ...normalizePaths(
      typeof manifest?.mcpServers === 'string' ||
        Array.isArray(manifest?.mcpServers)
        ? manifest.mcpServers
        : undefined,
    ),
  ];
  for (const relativePath of manifestPaths) {
    const resolved = path.resolve(pluginPath, relativePath);
    const relative = path.relative(pluginPath, resolved);
    if (
      relative.length === 0 ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    ) {
      results.add(resolved);
    }
  }
  return Array.from(results);
}

function computePathMtimeMs(targetPath: string): number {
  if (!fs.existsSync(targetPath)) return 0;
  const files: string[] = [];
  collectRecursiveFiles(targetPath, files);
  if (files.length === 0) return fs.statSync(targetPath).mtimeMs;
  let latest = 0;
  for (const filePath of files) {
    latest = Math.max(latest, fs.statSync(filePath).mtimeMs);
  }
  return latest;
}

function computePluginSourceLastUpdatedAt(
  pluginPath: string,
  manifest: PluginManifest | null,
): string {
  let latest = 0;
  for (const candidate of collectFreshnessCandidatePaths(
    pluginPath,
    manifest,
  )) {
    latest = Math.max(latest, computePathMtimeMs(candidate));
  }
  return new Date(latest > 0 ? latest : 0).toISOString();
}

function sidecarFilePath(cacheDir: string): string {
  return path.join(path.dirname(cacheDir), 'canopy-compatibility.json');
}

function cacheFreshnessMatches(
  cacheDir: string,
  freshness: CodexCompatibilityFreshness,
): boolean {
  if (!fs.existsSync(cacheDir)) return false;
  const sidecar = safeReadJson<CompatibilitySidecar>(sidecarFilePath(cacheDir));
  return (
    sidecar?.canopyCompatibilityVersion === freshness.compatibilityVersion &&
    sidecar.sourceVersion === freshness.sourceVersion &&
    sidecar.sourceLastUpdatedAt === freshness.sourceLastUpdatedAt
  );
}

function writeFreshnessSidecar(
  cacheDir: string,
  pluginName: string,
  freshness: CodexCompatibilityFreshness,
): void {
  writeJsonFile(sidecarFilePath(cacheDir), {
    canopyCompatibilityVersion: freshness.compatibilityVersion,
    sourcePluginName: pluginName,
    sourceVersion: freshness.sourceVersion,
    sourceLastUpdatedAt: freshness.sourceLastUpdatedAt,
  } satisfies CompatibilitySidecar);
}

function sanitizeKebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function realPluginCacheDir(marketplaceId: string, pluginName: string): string {
  return path.join(
    getCodexCompatibilityCacheRootDir(),
    sanitizeKebab(marketplaceId) || 'marketplace',
    sanitizeKebab(pluginName) || 'plugin',
    'local',
  );
}

function aggregatePluginCacheDir(selectionDigest: string): string {
  return path.join(
    getCodexCompatibilityCacheRootDir(),
    '_aggregate',
    selectionDigest,
    'local',
  );
}

function titleCaseKebab(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function mcpConfigFileMap(
  source: ClaudePluginCompatibilitySource,
): Map<string, PluginFileContent> {
  const configured = source.manifest?.mcpServers;
  const relativePaths =
    typeof configured === 'string'
      ? [configured]
      : Array.isArray(configured)
        ? configured
        : configured
          ? []
          : ['.mcp.json'];
  const files = new Map<string, PluginFileContent>();
  for (const relativePath of relativePaths) {
    const resolved = path.resolve(source.pluginPath, relativePath);
    if (
      !isPathInside(source.pluginPath, resolved) ||
      !fs.existsSync(resolved)
    ) {
      continue;
    }
    const content = safeReadText(resolved);
    if (content === null) continue;
    const key = path
      .relative(source.pluginPath, resolved)
      .split(path.sep)
      .join('/');
    files.set(key, content);
  }
  return files;
}

function toInteropInput(
  source: ClaudePluginCompatibilitySource,
  files: ReadonlyMap<string, PluginFileContent>,
  pluginRoot?: string,
  qualifiedReferenceMap?: ReadonlyMap<string, string>,
  includeMcpServers?: boolean,
): ProjectClaudePluginForCodexInput {
  return {
    pluginName: source.pluginName,
    category: source.category,
    manifest: source.manifest,
    rawManifest: source.rawManifest,
    files,
    ...(pluginRoot ? { pluginRoot } : {}),
    ...(qualifiedReferenceMap ? { qualifiedReferenceMap } : {}),
    ...(includeMcpServers !== undefined ? { includeMcpServers } : {}),
  };
}

export function readClaudePluginCompatibilitySource(options: {
  pluginName: string;
  pluginPath: string;
  marketplaceId: string;
  category: string;
}): ClaudePluginCompatibilitySource {
  const manifest = safeReadJson<PluginManifest>(
    path.join(options.pluginPath, '.claude-plugin', 'plugin.json'),
  );
  const rawManifest =
    safeReadJson<Record<string, unknown>>(
      path.join(options.pluginPath, '.claude-plugin', 'plugin.json'),
    ) ?? {};
  const warnings: string[] = [];
  return {
    pluginName: options.pluginName,
    pluginPath: options.pluginPath,
    marketplaceId: options.marketplaceId,
    category: options.category,
    manifest,
    rawManifest,
    skills: discoverPluginSkills(options.pluginPath, manifest, warnings),
    commands: discoverPluginMarkdownMembers(
      options.pluginPath,
      manifest,
      'commands',
      warnings,
    ),
    agents: discoverPluginMarkdownMembers(
      options.pluginPath,
      manifest,
      'agents',
      warnings,
    ),
    warnings,
    sourceVersion:
      manifest?.version ??
      (typeof rawManifest.version === 'string'
        ? rawManifest.version
        : '0.0.0-compat'),
    sourceLastUpdatedAt: computePluginSourceLastUpdatedAt(
      options.pluginPath,
      manifest,
    ),
  };
}

export function buildProjectionPlan(
  source: ClaudePluginCompatibilitySource,
): PluginProjectionPlan {
  const usedNames = new Set(source.skills.map((skill) => skill.name));
  const generatedCommandNames = new Map<string, string>();
  for (const command of [...source.commands].sort((left, right) =>
    comparePluginPaths(left.filePath, right.filePath),
  )) {
    generatedCommandNames.set(
      command.name,
      createGeneratedSkillName(command.name, usedNames),
    );
  }
  const generatedAgentNames = new Map<string, string>();
  for (const agent of [...source.agents].sort((left, right) =>
    comparePluginPaths(left.filePath, right.filePath),
  )) {
    generatedAgentNames.set(
      agent.name,
      createGeneratedSkillName(agent.name, usedNames),
    );
  }
  return { generatedCommandNames, generatedAgentNames };
}

export function buildCodexQualifiedReferenceMap(
  sources: readonly ClaudePluginCompatibilitySource[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const source of sources) {
    const plan = buildProjectionPlan(source);
    for (const skill of source.skills) {
      result.set(
        `${source.pluginName}:${skill.name}`,
        `$${source.pluginName}:${skill.name}`,
      );
    }
    for (const command of source.commands) {
      const generated =
        plan.generatedCommandNames.get(command.name) ?? command.name;
      result.set(
        `${source.pluginName}:${command.name}`,
        `$${source.pluginName}:${generated}`,
      );
    }
    for (const agent of source.agents) {
      const generated = plan.generatedAgentNames.get(agent.name) ?? agent.name;
      result.set(
        `${source.pluginName}:${agent.name}`,
        `$${source.pluginName}:${generated}`,
      );
    }
  }
  return result;
}

export function ensureCodexCompatibleClaudePlugin(
  source: ClaudePluginCompatibilitySource,
  qualifiedReferenceMap: ReadonlyMap<string, string>,
  options?: { includeMcpServers?: boolean },
): CodexCompatibilityPluginResult & { extraEnv: Record<string, string> } {
  const cacheDir = realPluginCacheDir(source.marketplaceId, source.pluginName);
  const includeMcpServers = options?.includeMcpServers !== false;
  const freshness: CodexCompatibilityFreshness = {
    sourceVersion: `${source.sourceVersion}:mcp-${String(includeMcpServers)}`,
    sourceLastUpdatedAt: source.sourceLastUpdatedAt,
    compatibilityVersion: CANOPY_COMPATIBILITY_VERSION,
  };
  if (cacheFreshnessMatches(cacheDir, freshness)) {
    const extraEnv = includeMcpServers
      ? projectClaudePluginMcpEnvironment({
          pluginName: source.pluginName,
          manifest: source.manifest,
          files: mcpConfigFileMap(source),
          pluginRoot: cacheDir,
        })
      : {};
    return {
      cacheDir,
      pluginName: source.pluginName,
      category: normalizePluginCategory(source.category),
      // The projection's own warnings are not cached, so repeat its Mod notice.
      warnings:
        scanPluginMods(source.pluginPath, source.manifest).length > 0
          ? [...source.warnings, claudeModCodexWarning(source.pluginName)]
          : [...source.warnings],
      freshness,
      extraEnv,
    };
  }
  const files = readPluginFileMap(source.pluginPath);
  const input = toInteropInput(
    source,
    files,
    cacheDir,
    qualifiedReferenceMap,
    includeMcpServers,
  );
  const extraEnv = includeMcpServers
    ? projectClaudePluginMcpEnvironment(input)
    : {};
  const projection = projectClaudePluginForCodex(input);
  removePath(path.dirname(cacheDir));
  ensureDir(cacheDir);
  writeProjectedFiles(cacheDir, projection.files);
  writeFreshnessSidecar(cacheDir, source.pluginName, freshness);
  return {
    cacheDir,
    pluginName: source.pluginName,
    category: normalizePluginCategory(source.category),
    warnings: [...source.warnings, ...projection.warnings],
    freshness,
    extraEnv,
  };
}

function buildAggregateDigest(options: {
  pluginName: string;
  skills: readonly AggregateSkillSource[];
  mcpServers: Record<string, unknown>;
}): { selectionDigest: string; lastUpdatedAt: string } {
  const fingerprints: string[] = [];
  let latest = 0;
  for (const skill of options.skills) {
    const mtime = computePathMtimeMs(skill.sourceDir);
    latest = Math.max(latest, mtime);
    fingerprints.push(
      `skill:${skill.name}:${skill.sourceDir}:${new Date(mtime).toISOString()}`,
    );
  }
  for (const serverName of Object.keys(options.mcpServers).sort()) {
    fingerprints.push(
      `mcp:${serverName}:${JSON.stringify(options.mcpServers[serverName])}`,
    );
  }
  return {
    selectionDigest: createHash('sha256')
      .update([options.pluginName, ...fingerprints].join('\n'))
      .digest('hex')
      .slice(0, 16),
    lastUpdatedAt: new Date(latest > 0 ? latest : 0).toISOString(),
  };
}

function copyAggregateSkill(
  source: AggregateSkillSource,
  destinationDir: string,
  targetName: string,
): void {
  fs.cpSync(source.sourceDir, destinationDir, { recursive: true });
  const skillPath = path.join(destinationDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return;
  const content = fs.readFileSync(skillPath, 'utf8');
  const parsed = parseFrontmatterAndBody(content);
  const frontmatter = parseFrontmatter<ParsedFrontmatter>(content) ?? {
    name: source.name,
    description: source.description,
  };
  const frontmatterText = yaml.dump(
    {
      name: targetName,
      description: frontmatter.description?.trim() ?? source.description,
    },
    { lineWidth: -1, noRefs: true },
  );
  const projected = `---\n${frontmatterText}---\n${parsed.body}`;
  fs.writeFileSync(skillPath, projected, 'utf8');
}

function buildCompatibilityReadme(
  pluginName: string,
  projectedSkills: readonly string[],
): string {
  const lines = [
    '# Generated Codex Plugin',
    '',
    `This plugin is generated by Canopy compatibility rework for \`${pluginName}\`.`,
    '',
    '## Projected Skills',
    '',
  ];
  if (projectedSkills.length === 0) {
    lines.push('No skills were projected for this plugin.', '');
  } else {
    for (const skillName of projectedSkills) lines.push(`- \`${skillName}\``);
    lines.push('');
  }
  lines.push('## Compatibility Notes', '', 'No compatibility notes.', '');
  return lines.join('\n');
}

export function ensureAggregateCodexCompatiblePlugin(options: {
  pluginName: string;
  category: string;
  skills: readonly AggregateSkillSource[];
  mcpServers: Record<string, unknown>;
}): CodexCompatibilityPluginResult & { extraEnv: Record<string, string> } {
  const digest = buildAggregateDigest(options);
  const cacheDir = aggregatePluginCacheDir(digest.selectionDigest);
  const freshness: CodexCompatibilityFreshness = {
    sourceVersion: digest.selectionDigest,
    sourceLastUpdatedAt: digest.lastUpdatedAt,
    compatibilityVersion: CANOPY_COMPATIBILITY_VERSION,
  };
  const mcpProjection = projectStandaloneMcpServersForCodex({
    pluginName: options.pluginName,
    mcpServers: options.mcpServers,
  });
  if (cacheFreshnessMatches(cacheDir, freshness)) {
    return {
      cacheDir,
      pluginName: options.pluginName,
      category: normalizePluginCategory(options.category),
      warnings: [],
      freshness,
      extraEnv: mcpProjection.extraEnv,
    };
  }
  removePath(path.dirname(cacheDir));
  ensureDir(cacheDir);
  const usedNames = new Set<string>();
  const projectedSkills: string[] = [];
  for (const skill of options.skills) {
    const targetName = createGeneratedSkillName(skill.name, usedNames);
    copyAggregateSkill(
      skill,
      path.join(cacheDir, 'skills', targetName),
      targetName,
    );
    projectedSkills.push(targetName);
  }
  if (Object.keys(mcpProjection.config).length > 0) {
    writeJsonFile(path.join(cacheDir, '.mcp.json'), {
      mcpServers: mcpProjection.config,
    });
  }
  writeJsonFile(path.join(cacheDir, '.codex-plugin', 'plugin.json'), {
    name: options.pluginName,
    version: digest.selectionDigest,
    description: `${BRAND.displayName}-generated Codex compatibility bundle.`,
    author: { name: BRAND.displayName },
    skills: projectedSkills.length > 0 ? './skills/' : undefined,
    mcpServers:
      Object.keys(mcpProjection.config).length > 0 ? './.mcp.json' : undefined,
    interface: {
      displayName: titleCaseKebab(options.pluginName),
      shortDescription: `Generated compatibility bundle for ${BRAND.displayName} selections.`,
      category: normalizePluginCategory(options.category),
      developerName: BRAND.displayName,
    },
  });
  fs.writeFileSync(
    path.join(cacheDir, 'README.md'),
    buildCompatibilityReadme(options.pluginName, projectedSkills),
    'utf8',
  );
  writeFreshnessSidecar(cacheDir, options.pluginName, freshness);
  return {
    cacheDir,
    pluginName: options.pluginName,
    category: normalizePluginCategory(options.category),
    warnings: mcpProjection.warnings,
    freshness,
    extraEnv: mcpProjection.extraEnv,
  };
}
