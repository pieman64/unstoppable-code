import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EXPECTED_PINS, REPO_ROOT } from '../../shared/constants.mjs';
import { PLACEHOLDER_API_KEY } from '../../shared/child-env.mjs';
import {
  ALLOWED_ENV_NAMES,
  REQUESTED_MODEL,
  buildProviderEnvironment,
  checkBinaryLocation,
  checkModelIdentity,
  loadProductionSeams,
  parseClaudeVersion,
  verifyPins,
  verifyProviderEnvironment,
} from '../probe-env.mjs';

async function layoutFor() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'bap0-env-test-')),
  );
  return {
    root,
    home: path.join(root, 'home'),
    claudeHomeDir: path.join(root, 'home', '.claude'),
    claudeConfigDir: path.join(root, 'claude-config'),
    tmp: path.join(root, 'tmp'),
  };
}

const BASE = 'http://127.0.0.1:45001';
const PROXY = 'http://127.0.0.1:45002';

async function build(options = {}) {
  const seams = await loadProductionSeams();
  const layout = await layoutFor();
  const built = buildProviderEnvironment({
    seams,
    layout,
    baseUrl: BASE,
    proxyUrl: PROXY,
    shimDir: path.join(layout.root, 'shim-bin'),
    claudeTmpDir: path.join(layout.tmp, 'claude-code-tmp'),
    ...options,
  });
  return { seams, layout, ...built };
}

test('the production seams load without Electron and resolve the bundled binary path', async () => {
  const seams = await loadProductionSeams();
  assert.equal(typeof seams.buildDelegationClaudeEnvironment, 'function');
  assert.equal(typeof seams.getBundledClaudeBinaryPath, 'function');
});

test('provider environment: production builder output, probe delta recorded, nothing else', async () => {
  const { env, envWithoutProxy, delta, layout } = await build();
  assert.equal(env.ANTHROPIC_API_KEY, PLACEHOLDER_API_KEY);
  assert.equal(env.ANTHROPIC_BASE_URL, BASE);
  assert.equal(env.HOME, layout.home);
  assert.equal(env.CLAUDE_CONFIG_DIR, layout.claudeConfigDir);
  assert.notEqual(env.CLAUDE_CONFIG_DIR, layout.claudeHomeDir);
  assert.ok(env.PATH.startsWith(path.join(layout.root, 'shim-bin')));
  for (const name of [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_AUTOUPDATER',
  ])
    assert.equal(env[name], '1', name);
  assert.equal('CLAUDE_CODE_DISABLE_AUTO_MEMORY' in env, false);
  assert.deepEqual(delta.removedFromProductionBuilder, [
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  ]);
  assert.equal('CLAUDE_CODE_DISABLE_CLAUDE_MDS' in env, false);
  assert.equal(env.HTTPS_PROXY, PROXY);
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
  for (const name of Object.keys(envWithoutProxy))
    assert.ok(ALLOWED_ENV_NAMES.has(name), name);
  assert.equal('HTTPS_PROXY' in envWithoutProxy, false);
});

test('variant C differs from B only by CLAUDE_CODE_DISABLE_CLAUDE_MDS', async () => {
  const b = await build();
  const c = await build({ disableClaudeMds: true });
  assert.equal(c.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  const strip = (env, layout) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(env)
          .filter(([name]) => name !== 'CLAUDE_CODE_DISABLE_CLAUDE_MDS')
          .map(([name, value]) => [
            name,
            String(value).replaceAll(layout.root, '<root>'),
          ]),
      ),
    );
  assert.equal(strip(b.env, b.layout), strip(c.env, c.layout));
});

test('canonical verification passes for the built environment and fails closed otherwise', async () => {
  const { env, envWithoutProxy, layout } = await build();
  const ok = verifyProviderEnvironment({
    env,
    envWithoutProxy,
    layout,
    baseUrl: BASE,
    proxyUrl: PROXY,
    expectDisableMds: false,
    hostEnv: {},
  });
  assert.equal(
    ok.ok,
    true,
    JSON.stringify(ok.checks.filter((check) => !check.ok)),
  );
  const failing = (mutate, expectDisableMds = false) => {
    const copy = { ...envWithoutProxy };
    mutate(copy);
    const full = {
      ...copy,
      HTTPS_PROXY: PROXY,
      HTTP_PROXY: PROXY,
      https_proxy: PROXY,
      http_proxy: PROXY,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };
    return verifyProviderEnvironment({
      env: full,
      envWithoutProxy: copy,
      layout,
      baseUrl: BASE,
      proxyUrl: PROXY,
      expectDisableMds,
      hostEnv: {},
    });
  };
  assert.equal(
    failing((e) => {
      e.HOME = '/Users/someone';
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      e.ANTHROPIC_API_KEY = 'sk-ant-real-looking';
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      e.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      e.GITHUB_TOKEN = 'ghp_xxxxxxxxxxxxxxxx';
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      e.BAP0_HOST_ENV_CANARY = 'x';
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      e.SOME_OTHER_VARIABLE = '1';
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      delete e.DISABLE_TELEMETRY;
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      e.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    }).ok,
    false,
  );
  assert.equal(
    failing((e) => {
      e.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    }, true).ok,
    true,
  );
  assert.equal(
    failing((e) => {
      e.CLAUDE_CODE_TMPDIR = '/tmp/elsewhere';
    }).ok,
    false,
  );
});

test('pins: version parse, binary location and versions must match', async () => {
  assert.equal(parseClaudeVersion('2.1.284 (Claude Code)\n'), '2.1.284');
  assert.equal(parseClaudeVersion(''), null);
  const good = path.join(REPO_ROOT, '.cache', 'bin', 'darwin-arm64', 'claude');
  assert.equal(checkBinaryLocation(good).ok, true);
  assert.equal(checkBinaryLocation('/usr/local/bin/claude').ok, false);
  assert.equal(
    checkBinaryLocation(
      path.join(REPO_ROOT, '.cache', 'bin', 'darwin-arm64', 'codex'),
    ).ok,
    false,
  );
  const readSdkPackage = async () => ({
    version: EXPECTED_PINS.claudeAgentSdk,
  });
  const pass = await verifyPins({
    binaryPath: good,
    env: {},
    cwd: '/',
    readSdkPackage,
    runVersion: async () => ({
      stdout: `${EXPECTED_PINS.claudeCli} (Claude Code)`,
      stderr: '',
      error: null,
    }),
  });
  assert.equal(pass.ok, true);
  const wrongCli = await verifyPins({
    binaryPath: good,
    env: {},
    cwd: '/',
    readSdkPackage,
    runVersion: async () => ({ stdout: '2.1.283', stderr: '', error: null }),
  });
  assert.equal(wrongCli.ok, false);
  const wrongSdk = await verifyPins({
    binaryPath: good,
    env: {},
    cwd: '/',
    readSdkPackage: async () => ({ version: '0.3.283' }),
    runVersion: async () => ({
      stdout: EXPECTED_PINS.claudeCli,
      stderr: '',
      error: null,
    }),
  });
  assert.equal(wrongSdk.ok, false);
  let ran = false;
  const outside = await verifyPins({
    binaryPath: '/opt/claude',
    env: {},
    cwd: '/',
    readSdkPackage,
    runVersion: async () => {
      ran = true;
      return { stdout: EXPECTED_PINS.claudeCli, stderr: '', error: null };
    },
  });
  assert.equal(outside.ok, false);
  assert.equal(ran, false, 'a binary outside .cache/bin is never executed');
});

test('the installed SDK package is the pinned version', async () => {
  const result = await verifyPins({
    binaryPath: '/opt/claude',
    env: {},
    cwd: '/',
  });
  assert.equal(result.sdk.version, EXPECTED_PINS.claudeAgentSdk);
});

test('model identity: any difference from the request is a silent fallback', () => {
  assert.equal(REQUESTED_MODEL, 'claude-sonnet-5-5');
  assert.equal(
    checkModelIdentity({
      requested: REQUESTED_MODEL,
      initModel: REQUESTED_MODEL,
      requestModels: [REQUESTED_MODEL],
    }).ok,
    true,
  );
  assert.equal(
    checkModelIdentity({
      requested: REQUESTED_MODEL,
      initModel: `${REQUESTED_MODEL}[1m]`,
      requestModels: [],
    }).ok,
    true,
  );
  const bad = checkModelIdentity({
    requested: REQUESTED_MODEL,
    initModel: 'claude-sonnet-4-6',
    requestModels: ['claude-haiku-4-5'],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 2);
});
