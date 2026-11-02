import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadBrand } from '../../../../../scripts/brand/load-brand.mjs';

export const cliName = loadBrand(process.env.CANOPY_BRAND || 'canopy').cliName;

// Tiny executable/resource stand-ins for the .deb's split distribution. The
// installer never executes package members to identify or copy them.
export async function seedLinuxCliPackage(root, version) {
  const resources = path.join(root, 'package/resources');
  const cli = path.join(resources, 'cli');
  async function write(file, text, mode = 0o644) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { mode });
  }
  await mkdir(path.join(root, 'home'), { recursive: true });
  await write(
    path.join(cli, cliName),
    `#!/bin/sh\nprintf '${version}\\n'\n`,
    0o755,
  );
  for (const tool of [
    'claude',
    'codex',
    'codex-code-mode-host',
    'gh',
    'rg',
    'rtk',
  ]) {
    await write(
      path.join(resources, 'bin', tool),
      `fixture-${tool}-${version}`,
      0o755,
    );
  }
  for (const file of [
    'resources/code-graph/parser.wasm',
    'resources/code-graph/query.scm',
    'node_modules/web-tree-sitter/package.json',
    'node_modules/web-tree-sitter/index.js',
    'node_modules/web-tree-sitter/parser.wasm',
    'node_modules/typescript/package.json',
    'node_modules/typescript/index.js',
  ])
    await write(path.join(cli, file), `fixture-${version}`);
  await write(
    path.join(resources, 'THIRD_PARTY_NOTICES.txt'),
    `notices-${version}`,
  );
}

export function linuxCliEnv(root) {
  return { CANOPY_E2E_PLATFORM: 'linux', CANOPY_E2E_LINUX_CLI_ROOT: root };
}
