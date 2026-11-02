import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const configPathsModule = await tsImport(
  '../../../../../packages/desktop-shared/src/pipelines/config-paths.ts',
  import.meta.url,
);
const { getBundledCodexBinaryPath } =
  configPathsModule.default ?? configPathsModule;

// Same staged-binary lookup as initializeIsolatedCodexState.mjs, which is
// hash-pinned by the browser-profile harness and so isn't imported from here.
function getStagedCodexBinaryPath() {
  const previousCanopyEnv = process.env.CANOPY_ENV;
  process.env.CANOPY_ENV = 'development';
  try {
    return getBundledCodexBinaryPath();
  } finally {
    if (previousCanopyEnv === undefined) delete process.env.CANOPY_ENV;
    else process.env.CANOPY_ENV = previousCanopyEnv;
  }
}

/**
 * Give the isolated Codex home a catalog entry for a model the bundled binary
 * doesn't ship yet. Production Codex learns new models from the remote catalog;
 * the mock server doesn't serve one, so an unknown slug falls back to default
 * metadata without the Fast service tier. Scripted delegation fixtures drive
 * inline tool calls, so the entry copies a bundled profile that isn't
 * code-mode-only.
 */
export function seedCodexFixtureModelCatalog(
  userDataDir,
  {
    slug = 'gpt-6.1-sol',
    displayName = 'GPT 6.1 Sol',
    profile = 'gpt-5.5',
  } = {},
) {
  const codexHome = path.join(userDataDir, 'provider-state', 'codex');
  mkdirSync(codexHome, { recursive: true });
  const catalog = JSON.parse(
    execFileSync(getStagedCodexBinaryPath(), ['debug', 'models', '--bundled'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      timeout: 15_000,
    }),
  );
  // A bundled entry is kept only when it already drives inline tools: Codex
  // 0.164 ships gpt-6.x itself as code-mode-only.
  const bundled = catalog.models.find((model) => model.slug === slug);
  if (bundled && bundled.tool_mode !== 'code_mode_only') return;
  const template = catalog.models.find((model) => model.slug === profile);
  if (!template || template.tool_mode === 'code_mode_only') {
    throw new Error(
      `Bundled Codex catalog has no inline-tool "${profile}" profile to copy for ${slug}`,
    );
  }
  catalog.models = catalog.models.filter((model) => model.slug !== slug);
  catalog.models.push({ ...template, slug, display_name: displayName });
  const catalogPath = path.join(codexHome, 'fixture-models.json');
  writeFileSync(catalogPath, JSON.stringify(catalog));
  appendFileSync(
    path.join(codexHome, 'config.toml'),
    `model_catalog_json = ${JSON.stringify(catalogPath)}\n`,
  );
}
