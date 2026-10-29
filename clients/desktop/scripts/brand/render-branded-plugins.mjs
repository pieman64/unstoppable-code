import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';

export const TEXT_EXTENSIONS = new Set([
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.txt',
  '.js',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
  '.svg',
]);

const PLUGIN_NAME_PATTERN = /^[a-z0-9-]+$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function titleCase(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function ensureSafePluginName(name, context) {
  if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `${context}: plugin name must match ${PLUGIN_NAME_PATTERN.toString()}`,
    );
  }
  if (name.includes('/') || name.includes('\\') || /\s/.test(name)) {
    throw new Error(
      `${context}: plugin name must not contain separators or whitespace`,
    );
  }
}

function readYamlFile(filePath) {
  const parsed = yaml.load(readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${filePath}: expected a YAML object`);
  }
  return parsed;
}

function renderConditionals(content, provider) {
  return content.replace(
    /{%\s*if\s+(claude|codex)\s*%}([\s\S]*?)(?:{%\s*else\s*%}([\s\S]*?))?{%\s*endif\s*%}/g,
    (_match, condition, truthy, falsy = '') =>
      condition === provider ? truthy : falsy,
  );
}

function renderText(content, brand, provider, replaceTokens) {
  const branded = replaceTokens(content, brand);
  return provider ? renderConditionals(branded, provider) : branded;
}

export function copyTreeWithBrandTokens(
  sourceDir,
  targetDir,
  brand,
  { replaceTokens, provider, exclude = () => false },
) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Plugin sources may not contain symlinks: ${sourcePath}`);
    }
    if (exclude(sourcePath, entry)) {
      continue;
    }

    const renderedName = replaceTokens(entry.name, brand);
    const targetPath = join(targetDir, renderedName);
    if (entry.isDirectory()) {
      copyTreeWithBrandTokens(sourcePath, targetPath, brand, {
        replaceTokens,
        provider,
        exclude,
      });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      writeFileSync(
        targetPath,
        renderText(
          readFileSync(sourcePath, 'utf8'),
          brand,
          provider,
          replaceTokens,
        ),
        'utf8',
      );
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function pluginManifestMetadata(metadata, provider) {
  const target =
    isRecord(metadata.targets) && isRecord(metadata.targets[provider])
      ? metadata.targets[provider]
      : {};
  const displayName =
    (typeof target.displayName === 'string' && target.displayName.trim()) ||
    (typeof metadata.displayName === 'string' && metadata.displayName.trim()) ||
    titleCase(metadata.name);
  const description =
    (typeof target.description === 'string' && target.description.trim()) ||
    metadata.description;
  const category =
    (typeof target.category === 'string' && target.category.trim()) ||
    metadata.category;
  return {
    name: metadata.name,
    displayName,
    version: metadata.version,
    description,
    shortDescription:
      (typeof target.shortDescription === 'string' &&
        target.shortDescription.trim()) ||
      description,
    longDescription:
      (typeof target.longDescription === 'string' &&
        target.longDescription.trim()) ||
      description,
    developerName:
      (typeof target.developerName === 'string' &&
        target.developerName.trim()) ||
      metadata.author.name,
    capabilities:
      Array.isArray(target.capabilities) && target.capabilities.length > 0
        ? target.capabilities
        : ['Skills'],
    defaultPrompt:
      Array.isArray(target.defaultPrompt) && target.defaultPrompt.length > 0
        ? target.defaultPrompt.slice(0, 3)
        : [`Use ${displayName}.`],
    author: metadata.author,
    homepage: metadata.homepage,
    repository: metadata.repository,
    license: metadata.license,
    keywords: Array.isArray(metadata.keywords) ? metadata.keywords : undefined,
    category,
  };
}

function validateSourceMetadata(metadata, pluginName, context) {
  ensureSafePluginName(pluginName, context);
  if (metadata.name !== pluginName) {
    throw new Error(
      `${context}: plugin.yaml name must match directory name "${pluginName}"`,
    );
  }
  for (const key of ['version', 'description', 'category']) {
    if (typeof metadata[key] !== 'string' || !metadata[key].trim()) {
      throw new Error(`${context}: plugin.yaml ${key} is required`);
    }
  }
  if (
    !isRecord(metadata.author) ||
    typeof metadata.author.name !== 'string' ||
    !metadata.author.name.trim()
  ) {
    throw new Error(`${context}: plugin.yaml author.name is required`);
  }
}

function readRenderedPluginMetadata(pluginDir, brand, replaceTokens) {
  const renderedName = replaceTokens(basename(pluginDir), brand);
  const metadata = readYamlFile(join(pluginDir, 'plugin.yaml'));
  const renderedMetadata = readYamlFileFromString(
    renderText(yaml.dump(metadata), brand, undefined, replaceTokens),
    join(pluginDir, 'plugin.yaml'),
  );
  validateSourceMetadata(renderedMetadata, renderedName, pluginDir);
  return renderedMetadata;
}

function readYamlFileFromString(content, context) {
  const parsed = yaml.load(content);
  if (!isRecord(parsed)) {
    throw new Error(`${context}: expected a YAML object`);
  }
  return parsed;
}

function shouldCopyToClaude(sourcePath, entry) {
  return entry.name !== 'plugin.yaml' && entry.name !== '.codex-plugin';
}

function shouldCopyBaseToCodex(_sourcePath, entry) {
  const name = entry.name;
  if (
    name === 'plugin.yaml' ||
    name === '.claude-plugin' ||
    name === 'commands' ||
    name === 'agents'
  ) {
    return false;
  }
  return true;
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function emitClaudePlugin(
  sourceDir,
  targetDir,
  metadata,
  brand,
  replaceTokens,
) {
  rmSync(targetDir, { recursive: true, force: true });
  copyTreeWithBrandTokens(sourceDir, targetDir, brand, {
    replaceTokens,
    provider: 'claude',
    exclude: (sourcePath, entry) => !shouldCopyToClaude(sourcePath, entry),
  });
  const providerMetadata = pluginManifestMetadata(metadata, 'claude');
  writeJson(join(targetDir, '.claude-plugin', 'plugin.json'), {
    name: providerMetadata.name,
    version: providerMetadata.version,
    description: providerMetadata.description,
    author: providerMetadata.author,
    ...(providerMetadata.homepage
      ? { homepage: providerMetadata.homepage }
      : {}),
    ...(providerMetadata.repository
      ? { repository: providerMetadata.repository }
      : {}),
    ...(providerMetadata.license ? { license: providerMetadata.license } : {}),
    ...(providerMetadata.keywords
      ? { keywords: providerMetadata.keywords }
      : {}),
  });
  return providerMetadata;
}

function parseMarkdownFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    return { frontmatter: {}, body: content };
  }
  try {
    const frontmatter = yaml.load(content.slice(4, end));
    return {
      frontmatter: isRecord(frontmatter) ? frontmatter : {},
      body: content.slice(content.indexOf('\n', end + 4) + 1),
    };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function skillDescriptionFromMarkdown(content, fallback) {
  const { frontmatter, body } = parseMarkdownFrontmatter(content);
  if (
    typeof frontmatter.description === 'string' &&
    frontmatter.description.trim()
  ) {
    return frontmatter.description.trim();
  }
  const firstLine = body
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return firstLine || fallback;
}

function uniqueSkillName(baseName, used) {
  let candidate = baseName;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function writeOpenAiAgentConfig(skillDir, displayName, description) {
  mkdirSync(join(skillDir, 'agents'), { recursive: true });
  writeFileSync(
    join(skillDir, 'agents', 'openai.yaml'),
    yaml.dump({
      interface: {
        display_name: displayName,
        short_description: description,
      },
      policy: {
        allow_implicit_invocation: false,
      },
    }),
    'utf8',
  );
}

function firstExistingPluginPath(targetDir, candidates) {
  const relativePath = candidates.find((candidate) =>
    existsSync(join(targetDir, candidate)),
  );
  return relativePath ? `./${relativePath}` : undefined;
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function emitCodexPlugin(sourceDir, targetDir, metadata, brand, replaceTokens) {
  rmSync(targetDir, { recursive: true, force: true });
  copyTreeWithBrandTokens(sourceDir, targetDir, brand, {
    replaceTokens,
    provider: 'codex',
    exclude: (sourcePath, entry) => !shouldCopyBaseToCodex(sourcePath, entry),
  });

  const usedSkillNames = new Set(listDirs(join(targetDir, 'skills')));

  for (const skillName of listDirs(join(sourceDir, 'skills'))) {
    const skillPath = join(targetDir, 'skills', skillName, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const { frontmatter } = parseMarkdownFrontmatter(
      readFileSync(skillPath, 'utf8'),
    );
    if (frontmatter['disable-model-invocation'] === true) {
      writeOpenAiAgentConfig(
        join(targetDir, 'skills', skillName),
        titleCase(skillName),
        typeof frontmatter.description === 'string'
          ? frontmatter.description
          : `${skillName} skill`,
      );
    }
  }

  for (const fileName of listMarkdownFiles(join(sourceDir, 'commands'))) {
    const baseName = basename(fileName, '.md');
    const skillName = uniqueSkillName(baseName, usedSkillNames);
    const raw = renderText(
      readFileSync(join(sourceDir, 'commands', fileName), 'utf8'),
      brand,
      'codex',
      replaceTokens,
    );
    const description = skillDescriptionFromMarkdown(
      raw,
      `${titleCase(baseName)} command`,
    );
    const { body } = parseMarkdownFrontmatter(raw);
    const skillDir = join(targetDir, 'skills', skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        `name: ${skillName}`,
        `description: $${metadata.name}:${skillName} only. ${description}`,
        '---',
        '',
        body.trimStart(),
      ].join('\n'),
      'utf8',
    );
    writeOpenAiAgentConfig(skillDir, titleCase(skillName), description);
  }

  for (const fileName of listMarkdownFiles(join(sourceDir, 'agents'))) {
    const baseName = basename(fileName, '.md');
    const skillName = uniqueSkillName(baseName, usedSkillNames);
    const raw = renderText(
      readFileSync(join(sourceDir, 'agents', fileName), 'utf8'),
      brand,
      'codex',
      replaceTokens,
    );
    const description = skillDescriptionFromMarkdown(
      raw,
      `${titleCase(baseName)} agent`,
    );
    const { body } = parseMarkdownFrontmatter(raw);
    const skillDir = join(targetDir, 'skills', skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        `name: ${skillName}`,
        `description: $${metadata.name}:${skillName} only. ${description}`,
        '---',
        '',
        body.trimStart(),
      ].join('\n'),
      'utf8',
    );
    writeOpenAiAgentConfig(skillDir, titleCase(skillName), description);
  }

  const providerMetadata = pluginManifestMetadata(metadata, 'codex');
  const mcpServersPath = firstExistingPluginPath(targetDir, [
    '.mcp.json',
    'mcp/.mcp.json',
  ]);
  const appsPath = firstExistingPluginPath(targetDir, [
    '.app.json',
    'apps/.app.json',
  ]);
  const manifest = {
    name: providerMetadata.name,
    version: providerMetadata.version,
    description: providerMetadata.description,
    author: providerMetadata.author,
    ...(providerMetadata.homepage
      ? { homepage: providerMetadata.homepage }
      : {}),
    ...(providerMetadata.repository
      ? { repository: providerMetadata.repository }
      : {}),
    ...(providerMetadata.license ? { license: providerMetadata.license } : {}),
    ...(providerMetadata.keywords
      ? { keywords: providerMetadata.keywords }
      : {}),
    ...(existsSync(join(targetDir, 'skills')) ? { skills: './skills/' } : {}),
    ...(mcpServersPath ? { mcpServers: mcpServersPath } : {}),
    ...(appsPath ? { apps: appsPath } : {}),
    interface: {
      displayName: providerMetadata.displayName,
      shortDescription: providerMetadata.shortDescription,
      longDescription: providerMetadata.longDescription,
      developerName: providerMetadata.developerName,
      category: providerMetadata.category,
      capabilities: providerMetadata.capabilities,
      defaultPrompt: providerMetadata.defaultPrompt,
    },
  };
  writeJson(join(targetDir, '.codex-plugin', 'plugin.json'), manifest);
  return providerMetadata;
}

function providerManifestPath(provider, root) {
  return provider === 'claude'
    ? join(root, '.claude-plugin', 'plugin.json')
    : join(root, '.codex-plugin', 'plugin.json');
}

function readProviderManifest(provider, root) {
  const manifestPath = providerManifestPath(provider, root);
  if (!existsSync(manifestPath)) {
    throw new Error(`${root}: missing ${relative(root, manifestPath)}`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${manifestPath}: expected a JSON object`);
  }
  return parsed;
}

function preparedMetadataFromManifest(pluginName, manifest, provider) {
  return {
    name: typeof manifest.name === 'string' ? manifest.name : pluginName,
    version: typeof manifest.version === 'string' ? manifest.version : '1.0.0',
    description:
      typeof manifest.description === 'string' ? manifest.description : '',
    author: isRecord(manifest.author)
      ? manifest.author
      : { name: typeof manifest.author === 'string' ? manifest.author : '' },
    homepage:
      typeof manifest.homepage === 'string' ? manifest.homepage : undefined,
    repository:
      typeof manifest.repository === 'string' ? manifest.repository : undefined,
    license:
      typeof manifest.license === 'string' ? manifest.license : undefined,
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : undefined,
    category: provider === 'codex' ? 'Development' : 'development',
  };
}

function collectPluginDirs(sourceDirs, brand, replaceTokens) {
  const result = [];
  for (const sourceRoot of sourceDirs) {
    if (!existsSync(sourceRoot)) continue;
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const renderedName = replaceTokens(entry.name, brand);
      ensureSafePluginName(renderedName, join(sourceRoot, entry.name));
      result.push({
        sourceDir: join(sourceRoot, entry.name),
        name: renderedName,
      });
    }
  }
  return result;
}

function loadOptionalPreparedMetadata(
  sourceDir,
  pluginName,
  brand,
  replaceTokens,
) {
  const metadataPath = join(sourceDir, 'plugin.yaml');
  if (!existsSync(metadataPath)) {
    return null;
  }
  const metadata = readYamlFileFromString(
    renderText(
      readFileSync(metadataPath, 'utf8'),
      brand,
      undefined,
      replaceTokens,
    ),
    metadataPath,
  );
  validateSourceMetadata(metadata, pluginName, sourceDir);
  return metadata;
}

export function renderBrandedPlugins(brand, options) {
  const {
    targetResources,
    replaceTokens,
    sourcePluginTemplates,
    sourceBrandPlugins,
    sourcePreparedPluginTemplates,
    sourceBrandPreparedPlugins,
  } = options;
  const pluginsRoot = join(targetResources, 'plugins');
  const sourcePlugins = collectPluginDirs(
    [sourcePluginTemplates, sourceBrandPlugins],
    brand,
    replaceTokens,
  );
  const preparedPlugins = collectPluginDirs(
    [sourcePreparedPluginTemplates, sourceBrandPreparedPlugins],
    brand,
    replaceTokens,
  );

  if (sourcePlugins.length === 0 && preparedPlugins.length === 0) {
    rmSync(pluginsRoot, { recursive: true, force: true });
    return;
  }

  rmSync(pluginsRoot, { recursive: true, force: true });
  mkdirSync(pluginsRoot, { recursive: true });

  const metadataByPlugin = new Map();
  const providerMetadata = {
    claude: new Map(),
    codex: new Map(),
  };

  for (const plugin of sourcePlugins) {
    const metadata = readRenderedPluginMetadata(
      plugin.sourceDir,
      brand,
      replaceTokens,
    );
    metadataByPlugin.set(plugin.name, metadata);
    providerMetadata.claude.set(
      plugin.name,
      emitClaudePlugin(
        plugin.sourceDir,
        join(pluginsRoot, 'claude-plugins', plugin.name),
        metadata,
        brand,
        replaceTokens,
      ),
    );
    providerMetadata.codex.set(
      plugin.name,
      emitCodexPlugin(
        plugin.sourceDir,
        join(pluginsRoot, 'codex-plugins', plugin.name),
        metadata,
        brand,
        replaceTokens,
      ),
    );
  }

  for (const plugin of preparedPlugins) {
    const metadata = loadOptionalPreparedMetadata(
      plugin.sourceDir,
      plugin.name,
      brand,
      replaceTokens,
    );
    if (metadata) {
      metadataByPlugin.set(plugin.name, metadata);
    }
    let hasProvider = false;
    for (const provider of ['claude', 'codex']) {
      const sourceProviderDir = join(plugin.sourceDir, provider);
      if (!existsSync(sourceProviderDir)) continue;
      hasProvider = true;
      const targetDir = join(
        pluginsRoot,
        provider === 'claude' ? 'claude-plugins' : 'codex-plugins',
        plugin.name,
      );
      rmSync(targetDir, { recursive: true, force: true });
      copyTreeWithBrandTokens(sourceProviderDir, targetDir, brand, {
        replaceTokens,
        provider,
      });
      const manifest = readProviderManifest(provider, targetDir);
      providerMetadata[provider].set(
        plugin.name,
        metadata
          ? pluginManifestMetadata(metadata, provider)
          : preparedMetadataFromManifest(plugin.name, manifest, provider),
      );
    }
    if (!hasProvider) {
      throw new Error(
        `${plugin.sourceDir}: prepared plugin must contain claude or codex provider directory`,
      );
    }
  }

  if (providerMetadata.claude.size > 0) {
    writeJson(join(pluginsRoot, '.claude-plugin', 'marketplace.json'), {
      name: `${brand.internalName}-plugins`,
      version: '1.0.0',
      description: `Built-in plugin marketplace for ${brand.displayName}.`,
      metadata: {
        description: `Built-in plugins bundled with ${brand.displayName}.`,
      },
      owner: { name: brand.displayName },
      plugins: Array.from(providerMetadata.claude.entries()).map(
        ([name, metadata]) => ({
          name,
          description: metadata.description,
          version: metadata.version,
          source: `./claude-plugins/${name}`,
          category: metadata.category || 'development',
          author: metadata.author,
        }),
      ),
    });
  }

  if (providerMetadata.codex.size > 0) {
    writeJson(join(pluginsRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: `${brand.internalName}-plugins`,
      interface: {
        displayName: `${brand.displayName} Marketplace`,
      },
      plugins: Array.from(providerMetadata.codex.entries()).map(
        ([name, metadata]) => ({
          name,
          source: {
            source: 'local',
            path: `./codex-plugins/${name}`,
          },
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
          category: metadata.category || 'Development',
          author: metadata.author,
        }),
      ),
    });
  }
}
