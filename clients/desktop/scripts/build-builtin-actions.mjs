#!/usr/bin/env node

import { context, build } from 'esbuild';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadBrand } from './brand/load-brand.mjs';
import { prepareBrand } from './brand/prepare-brand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const selectedBrandId = process.env.CANOPY_BRAND ?? 'canopy';
const args = new Set(process.argv.slice(2));
const watchMode = args.has('--watch');
const skipBrandPrepare =
  args.has('--skip-brand-prepare') || args.has('--no-prepare-brand');
const selectedBrand = skipBrandPrepare
  ? loadBrand(selectedBrandId, { repoRoot: root })
  : prepareBrand(selectedBrandId, { log: false });
const srcRoot = join(
  root,
  'packages',
  'desktop-shared',
  'src',
  'builtin-actions',
);
const resourcesRoot = join(
  root,
  '.cache',
  'brand',
  selectedBrand.id,
  'resources',
  'actions',
);
const brandPrepareLockDir = join(root, '.cache', 'brand', '.prepare.lock');
const OUTPUT_HEALTH_CHECK_INTERVAL_MS = 2_000;
let buildInProgress = false;

function discoverEntryPoints() {
  if (!existsSync(srcRoot)) {
    return [];
  }

  return readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => join(srcRoot, entry.name, 'index.ts'))
    .filter((entryPath) => existsSync(entryPath))
    .sort((left, right) => left.localeCompare(right));
}

function validateManifest(entryPoint) {
  const actionName = basename(dirname(entryPoint));
  const manifestPath = join(resourcesRoot, actionName, 'action.yml');

  if (!existsSync(manifestPath)) {
    throw new Error(
      `Missing action manifest for builtin action "${actionName}": ${manifestPath}`,
    );
  }

  const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid action manifest: ${manifestPath}`);
  }

  const runs = manifest.runs;
  if (!runs || typeof runs !== 'object' || Array.isArray(runs)) {
    throw new Error(`Action manifest is missing runs block: ${manifestPath}`);
  }

  if (!runsUseBuiltEntry(runs)) {
    throw new Error(
      `Builtin action "${actionName}" must use runs.using=node and runs.main=index.js, or runs.using=host with that pair as runs.fallback`,
    );
  }
}

function isBuiltNodeEntry(runs) {
  return (
    !!runs &&
    typeof runs === 'object' &&
    !Array.isArray(runs) &&
    runs.using === 'node' &&
    runs.main === 'index.js'
  );
}

/** A built action runs `index.js` directly or as a host action's Node fallback. */
function runsUseBuiltEntry(runs) {
  return (
    isBuiltNodeEntry(runs) ||
    (runs.using === 'host' && isBuiltNodeEntry(runs.fallback))
  );
}

function getActionName(entryPoint) {
  return basename(dirname(entryPoint));
}

function getActionOutputPath(entryPoint) {
  return join(resourcesRoot, getActionName(entryPoint), 'index.js');
}

function getMissingActionOutputs(entryPoints) {
  return entryPoints
    .map((entryPoint) => ({
      actionName: getActionName(entryPoint),
      outputPath: getActionOutputPath(entryPoint),
    }))
    .filter((entry) => !existsSync(entry.outputPath));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function trackBuildActivityPlugin() {
  return {
    name: 'track-build-activity',
    setup(buildContext) {
      buildContext.onStart(() => {
        buildInProgress = true;
      });
      buildContext.onEnd(() => {
        buildInProgress = false;
      });
    },
  };
}

function forbidMainProcessImportsInBuiltinActionsPlugin() {
  const forbiddenAppRoots = [
    join(root, 'apps', 'desktop-app', 'src', 'main') + sep,
    join(root, 'apps', 'desktop-app', 'src', 'preload') + sep,
    join(root, 'apps', 'desktop-app', 'src', 'renderer') + sep,
  ];
  const resourcesActionsRoot = join(resourcesRoot, '') + sep;

  return {
    name: 'forbid-main-process-imports-in-builtin-actions',
    setup(buildContext) {
      buildContext.onEnd((result) => {
        const metafile = result.metafile;
        if (!metafile) {
          return undefined;
        }

        const errors = [];
        for (const [outputPath, outputMeta] of Object.entries(
          metafile.outputs,
        )) {
          const resolvedOutputPath = resolve(outputPath);
          if (
            !resolvedOutputPath.startsWith(resourcesActionsRoot) ||
            !resolvedOutputPath.endsWith(`${sep}index.js`)
          ) {
            continue;
          }

          const mainInputs = Object.keys(outputMeta.inputs)
            .map((inputPath) => resolve(inputPath))
            .filter((inputPath) =>
              forbiddenAppRoots.some((rootPath) =>
                inputPath.startsWith(rootPath),
              ),
            )
            .sort();

          if (mainInputs.length === 0) {
            continue;
          }

          const actionName = basename(dirname(resolvedOutputPath));
          const formattedInputs = mainInputs
            .map((inputPath) => `- ${inputPath}`)
            .join('\n');
          errors.push({
            text:
              `Builtin action "${actionName}" cannot import desktop app files. ` +
              'Move reusable logic into packages/desktop-shared or packages/protocol.\n' +
              formattedInputs,
          });
        }

        if (errors.length > 0) {
          return { errors };
        }

        return undefined;
      });
    },
  };
}

function getBuildOptions(entryPoints) {
  return {
    entryPoints,
    outdir: resourcesRoot,
    outbase: srcRoot,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    metafile: true,
    alias: {
      '@canopy/protocol': join(root, 'packages', 'protocol', 'src'),
      '@canopy/agent-actions': join(root, 'packages', 'agent-actions', 'src'),
      '@canopy/plugin-interop': join(root, 'packages', 'plugin-interop', 'src'),
      '@canopy/copilot-recipient': join(
        root,
        'packages',
        'copilot-recipient',
        'src',
      ),
      '@canopy/code-graph': join(root, 'packages', 'code-graph', 'src'),
      '@canopy/execution-engine': join(
        root,
        'packages',
        'execution-engine',
        'src',
      ),
      '@canopy/desktop-shared': join(root, 'packages', 'desktop-shared', 'src'),
      '@canopy/ui-shared': join(root, 'packages', 'ui-shared', 'src'),
      '@canopy/brand/current': join(
        root,
        '.cache',
        'brand',
        selectedBrand.id,
        'desktop-brand.ts',
      ),
    },
    external: ['node:*'],
    // The bundled ESM Claude SDK calls createRequire(import.meta.url). esbuild's cjs
    // output rewrites import.meta to {}, so import.meta.url becomes undefined
    // and createRequire throws at module load. Resolve every import.meta.url
    // to the emitted bundle's own file URL instead.
    define: {
      'import.meta.url': '__canopyBundleImportMetaUrl',
      // Mirror the renderer/main `__CANOPY_E2E__` build gate
      // (electron.vite.config.ts) so build-time-gated UI-automation seams in
      // shared code are inlined
      // to a boolean literal here too. `false` in every production build → the
      // gated branch (and its `CANOPY_MOCK_*` markers) is dead-code-eliminated
      // from builtin-action subprocess bundles; only `CANOPY_E2E_BUILD=1` sets
      // it true. See docs/ui-automation-coverage/11-build-time-gating-principle.md.
      __CANOPY_E2E__: JSON.stringify(process.env.CANOPY_E2E_BUILD === '1'),
      __CANOPY_MOCK_LLM_BASE_URL__:
        process.env.CANOPY_E2E_BUILD === '1'
          ? (JSON.stringify(process.env.CANOPY_MOCK_LLM_BASE_URL) ??
            'undefined')
          : 'undefined',
      __CANOPY_LINEAR_API_BASE_URL__:
        process.env.CANOPY_E2E_BUILD === '1'
          ? (JSON.stringify(process.env.CANOPY_LINEAR_API_BASE_URL) ??
            'undefined')
          : 'undefined',
    },
    banner: {
      js: "var __canopyBundleImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    },
    logLevel: 'info',
    plugins: [
      trackBuildActivityPlugin(),
      forbidMainProcessImportsInBuiltinActionsPlugin(),
    ],
  };
}

function startOutputHealthCheck(buildContext, entryPoints) {
  let rebuildInProgress = false;

  async function rebuildMissingOutputs(reason) {
    if (
      buildInProgress ||
      rebuildInProgress ||
      existsSync(brandPrepareLockDir)
    ) {
      return;
    }

    const missing = getMissingActionOutputs(entryPoints);
    if (missing.length === 0) {
      return;
    }

    const names = missing.map((entry) => entry.actionName).join(', ');
    process.stdout.write(
      `Builtin action output(s) missing after ${reason}; rebuilding: ${names}\n`,
    );

    rebuildInProgress = true;
    try {
      await buildContext.rebuild();
    } catch (error) {
      process.stderr.write(
        `Failed to rebuild builtin action output(s): ${formatError(error)}\n`,
      );
    } finally {
      rebuildInProgress = false;
    }
  }

  const timer = setInterval(() => {
    void rebuildMissingOutputs('cache check');
  }, OUTPUT_HEALTH_CHECK_INTERVAL_MS);

  return () => clearInterval(timer);
}

async function main() {
  const entryPoints = discoverEntryPoints();
  entryPoints.forEach(validateManifest);

  if (entryPoints.length === 0) {
    return;
  }

  const options = getBuildOptions(entryPoints);

  if (watchMode) {
    const buildContext = await context(options);
    await buildContext.watch();
    startOutputHealthCheck(buildContext, entryPoints);
    await new Promise(() => {});
    return;
  }

  await build(options);
}

await main();
