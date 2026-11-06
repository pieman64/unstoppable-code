#!/usr/bin/env node
// Public client build entrypoint. No deployment, signing, upload or hosted build.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
const modes = [
  'verify-lock',
  'setup',
  'prepare',
  'build',
  'typecheck',
  'test',
  'start',
];
const mode = process.argv[2];
if (!modes.includes(mode))
  throw new Error(`Expected one of: ${modes.join(', ')}`);
const tarballs =
  JSON.parse(readFileSync('package.json', 'utf8')).publicTarballs ?? {};
const lockedPackages =
  yaml.loadAll(readFileSync('pnpm-lock.yaml', 'utf8')).at(-1)?.packages ?? {};
for (const [name, expected] of Object.entries(tarballs)) {
  const matches = Object.entries(lockedPackages).filter(
    ([id]) =>
      id.startsWith(`${name}@`) ||
      id === expected.resolved ||
      lockedPackages[id]?.name === name ||
      lockedPackages[id]?.resolution?.name === name,
  );
  if (
    !matches.length ||
    matches.some(
      ([, entry]) =>
        entry.version !== expected.version ||
        entry.resolution?.tarball !== expected.resolved ||
        entry.resolution?.integrity !== expected.integrity,
    )
  )
    throw new Error(`Reviewed tarball lock mismatch: ${name}`);
}
if (mode === 'verify-lock') process.exit(0);
const node = (...args) =>
  execFileSync(process.execPath, args, { stdio: 'inherit' });
if (mode === 'setup') {
  node('scripts/build-delegation-file-broker.mjs', '--host');
  // pnpm applies reviewed patches even when install scripts are ignored.
  node('node_modules/electron/install.js');
  node(
    'node_modules/@electron/rebuild/lib/cli.js',
    '--only',
    'node-pty',
    '--force',
  );
  process.exit(0);
}
// Unit tests retain the isolated no-service configuration. Normal builds use
// the stable public services; forks can override these values at build time.
const isolatedTests = mode === 'test';
// Like the electron-vite config, a blank URL selects the default; production
// builds reject an empty origin. Opt out with a loopback URL instead.
const serviceUrl = (name, fallback) =>
  isolatedTests ? 'http://127.0.0.1:1' : process.env[name]?.trim() || fallback;
// These are public ingestion identifiers, not server/API secrets. Keep empty
// and false build overrides meaningful; the runtime's privacy gates still apply.
const clientConfig = (name, fallback, isolatedValue = '') =>
  isolatedTests ? isolatedValue : (process.env[name] ?? fallback);
const env = {
  ...process.env,
  CANOPY_BRAND: mode === 'test' ? 'canopy' : 'unstoppable-code',
  CANOPY_SOURCE_BUILD: 'true',
  CANOPY_CLOUD_BASE_URL: serviceUrl(
    'CANOPY_CLOUD_BASE_URL',
    'https://app.unstoppable.ai',
  ),
  CANOPY_UPDATE_BASE_URL: serviceUrl(
    'CANOPY_UPDATE_BASE_URL',
    'https://releases.unstoppable.ai',
  ),
  CANOPY_POSTHOG_ENABLED: clientConfig(
    'CANOPY_POSTHOG_ENABLED',
    'true',
    'false',
  ),
  CANOPY_POSTHOG_PROJECT_KEY: clientConfig(
    'CANOPY_POSTHOG_PROJECT_KEY',
    'phc_uix24BXT44S7s2ZbRBWfB3hGwmjAWaxt5s5ampN3C47m',
  ),
  CANOPY_POSTHOG_HOST: clientConfig(
    'CANOPY_POSTHOG_HOST',
    'https://us.i.posthog.com',
  ),
  // Public client-side ID shipped in the stable desktop app, not an SDK key.
  // Preserve an explicitly empty override for offline validation. At launch,
  // use the bundled value: an injected default could re-enable a blank build's
  // unpackaged runtime fallback.
  LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID: isolatedTests
    ? ''
    : (process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID ??
      (mode === 'start' ? '' : '6a1731af8a0c800aa68bd6ea')),
  CANOPY_GOOGLE_OAUTH_CLIENT_SECRET: clientConfig(
    'CANOPY_GOOGLE_OAUTH_CLIENT_SECRET',
    '',
  ),
  CANOPY_SKIP_BRAND_PREPARE: 'true',
};
const run = (...args) =>
  execFileSync(process.execPath, args, { env, stdio: 'inherit' });
if (mode === 'start') {
  if (!existsSync('out/main/index.js'))
    throw new Error('Run pnpm run build:public before pnpm run start:public');
  const electron = createRequire(resolve('package.json'))('electron');
  if (typeof electron !== 'string' || !existsSync(electron))
    throw new Error('Electron is missing. Run pnpm run setup:public first.');
  const extra = process.argv.slice(3);
  const smoke = extra.includes('--smoke');
  // Remaining arguments are Electron switches, such as --no-sandbox in CI.
  const switches = extra.filter((arg) => arg !== '--smoke');
  const app = spawn(electron, [...switches, '.'], {
    env,
    stdio: 'inherit',
  });
  if (smoke) {
    // CI launch check: the app must still be running after startup settles.
    const timer = setTimeout(() => {
      console.log('Desktop app is still running after 30 seconds.');
      app.kill();
      process.exit(0);
    }, 30_000);
    app.on('exit', (code, signal) => {
      clearTimeout(timer);
      console.error(`Desktop app exited during startup (${code ?? signal}).`);
      process.exit(1);
    });
  } else app.on('exit', (code) => process.exit(code ?? 1));
} else run('scripts/brand/prepare-brand.mjs', '--brand', env.CANOPY_BRAND);
if (mode === 'build') {
  run('--import', 'tsx', 'scripts/validate-model-config.ts');
  run('scripts/build-builtin-actions.mjs', '--skip-brand-prepare');
  run('apps/desktop-app/scripts/run-electron-vite-build.mjs');
} else if (mode === 'typecheck')
  run('node_modules/@typescript/native/bin/tsc', '--build', 'tsconfig.json');
else if (mode === 'test') {
  run('scripts/build-delegation-file-broker.mjs', '--host');
  // Unit tests run under Node, so build the native module for that ABI.
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['rebuild', 'node-pty'],
    {
      env,
      stdio: 'inherit',
    },
  );
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  run(
    // Workers inherit this explicit heap cap, including on smaller CI hosts.
    '--max-old-space-size=4096',
    // Node 24 before 24.22 on arm64: a Sparkplug frame bug crashes V8's
    // garbage collector (nodejs/node#62393); workers inherit this flag too.
    ...(process.arch === 'arm64' && nodeMajor === 24 && nodeMinor < 22
      ? ['--no-sparkplug']
      : []),
    'node_modules/jest/bin/jest.js',
    '--config',
    'jest.config.js',
    // Recycle workers between files to bound the heap.
    '--maxWorkers=2',
    '--workerIdleMemoryLimit=1MB',
    '--forceExit',
    '--json',
    '--outputFile=.cache/public-jest-results.json',
  );
}
