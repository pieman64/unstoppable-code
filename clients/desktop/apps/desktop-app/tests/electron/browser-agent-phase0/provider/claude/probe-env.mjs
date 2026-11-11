// Provider environment for the Claude probe, built from scratch through the
// production restricted-environment builder (packages/desktop-shared), then
// checked against an explicit allowlist before any turn is sent.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXPECTED_PINS, REPO_ROOT } from '../shared/constants.mjs';
import {
  PLACEHOLDER_API_KEY,
  checkProbeEnv,
  isLoopbackUrl,
} from '../shared/child-env.mjs';
import { SYNTHETIC_OAUTH_TOKEN } from '../shared/followup-policy.mjs';
import { isInside } from '../shared/synthetic-root.mjs';
import { NO_PROXY_VALUE } from './refusing-proxy.mjs';
import * as environmentModule from '@canopy/desktop-shared/node/delegation/environment';
import * as configPathsModule from '@canopy/execution-engine/pipelines/config-paths';

/** Concrete Claude id from package.json claude-code.models (cursorModelId of the `sonnet` entry). */
export const REQUESTED_MODEL = 'claude-sonnet-5-5';

export const REQUIRED_TRAFFIC_FLAGS = Object.freeze([
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_AUTOUPDATER',
]);

/** Every name the provider process may receive (proxy names are validated separately). */
export const ALLOWED_ENV_NAMES = Object.freeze(
  new Set([
    'HOME',
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_TMPDIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    ...REQUIRED_TRAFFIC_FLAGS,
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  ]),
);

/**
 * Names only the follow-up arms may add on top of ALLOWED_ENV_NAMES. The
 * first-run probe keeps its own list unchanged (it removes the memory flag).
 */
export const FOLLOWUP_EXTRA_ENV_NAMES = Object.freeze([
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
  'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
]);

/** Targeted controls (07 section 11 table) expressed as explicit environment values. */
export const TARGETED_CONTROL_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
});

/** Variables that switch the CLI into the mode that skips OAuth/keychain credentials. */
export const BARE_MODE_ENV_NAMES = Object.freeze(['CLAUDE_CODE_SIMPLE']);

/**
 * `api-key`: the first-run credential shape (placeholder key + loopback base URL).
 * `oauth-init`: production-shaped synthetic OAuth: oauthToken ONLY, no base URL, no API key.
 * `oauth-loopback`: synthetic OAuth + loopback base URL; a labelled NON-production transport delta.
 */
export const CREDENTIAL_MODES = Object.freeze([
  'api-key',
  'oauth-init',
  'oauth-loopback',
]);

const PROXY_NAMES = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

export const PRODUCTION_BUILDER_SOURCE =
  'packages/desktop-shared/src/node/delegation/environment.ts buildDelegationClaudeEnvironment (Electron-free; ' +
  'the production call site is the desktop main delegation route-runtime.ts, lines ~985-1010, read as text only)';

function pick(namespace, name) {
  const direct = namespace?.[name];
  if (typeof direct === 'function') return direct;
  const viaDefault = namespace?.default?.[name];
  return typeof viaDefault === 'function' ? viaDefault : null;
}

/**
 * The production environment builder and the centralized binary resolver,
 * both from packages/desktop-shared (Electron-free). Static namespace imports;
 * tsx exposes the TypeScript modules through `default` or as named exports.
 */
export async function loadProductionSeams() {
  const environment = environmentModule;
  const configPaths = configPathsModule;
  const buildDelegationClaudeEnvironment = pick(
    environment,
    'buildDelegationClaudeEnvironment',
  );
  const getBundledClaudeBinaryPath = pick(
    configPaths,
    'getBundledClaudeBinaryPath',
  );
  if (!buildDelegationClaudeEnvironment)
    throw new Error('buildDelegationClaudeEnvironment is not exported');
  if (!getBundledClaudeBinaryPath)
    throw new Error('getBundledClaudeBinaryPath is not exported');
  return { buildDelegationClaudeEnvironment, getBundledClaudeBinaryPath };
}

/**
 * Provider environment for one variant.
 *
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is removed from the production builder's
 * output on purpose: with it set, the memory fixture could never be live and
 * the memory-absence result could not distinguish the SDK options from the
 * env switch. The delta is recorded in the report.
 */
export function buildProviderEnvironment({
  seams,
  layout,
  baseUrl,
  proxyUrl,
  shimDir,
  claudeTmpDir,
  disableClaudeMds = false,
  keepAutoMemoryDisable = false,
  credentialMode = 'api-key',
  extraEnv = {},
}) {
  if (process.platform === 'win32')
    throw new Error('The Claude probe supports POSIX hosts only');
  if (!CREDENTIAL_MODES.includes(credentialMode))
    throw new Error(`Unknown credential mode ${credentialMode}`);
  for (const name of Object.keys(extraEnv))
    if (
      !FOLLOWUP_EXTRA_ENV_NAMES.includes(name) &&
      !(name in TARGETED_CONTROL_ENV)
    )
      throw new Error(`Environment name ${name} is not an admitted extra`);
  const credentials =
    credentialMode === 'api-key'
      ? { apiKey: PLACEHOLDER_API_KEY, baseUrl }
      : credentialMode === 'oauth-loopback'
        ? { oauthToken: SYNTHETIC_OAUTH_TOKEN, baseUrl }
        : { oauthToken: SYNTHETIC_OAUTH_TOKEN };
  const produced = seams.buildDelegationClaudeEnvironment({
    canonicalHome: layout.home,
    temporaryDirectory: layout.tmp,
    backgroundTaskDirectory: claudeTmpDir,
    claudeConfigDirectory: layout.claudeConfigDir,
    credentials,
    commandPath: `${shimDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
  });
  const removed = [];
  const kept = [];
  if ('CLAUDE_CODE_DISABLE_AUTO_MEMORY' in produced) {
    if (keepAutoMemoryDisable) kept.push('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    else {
      delete produced.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
      removed.push('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    }
  }
  const added = [];
  for (const [name, value] of Object.entries(extraEnv)) {
    produced[name] = value;
    added.push(name);
  }
  for (const name of ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING']) {
    produced[name] = '1';
    added.push(name);
  }
  if (disableClaudeMds) {
    produced.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    added.push('CLAUDE_CODE_DISABLE_CLAUDE_MDS');
  }
  const envWithoutProxy = { ...produced };
  const env = {
    ...produced,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: NO_PROXY_VALUE,
    no_proxy: NO_PROXY_VALUE,
  };
  added.push(...PROXY_NAMES);
  return {
    env,
    envWithoutProxy,
    delta: {
      removedFromProductionBuilder: removed,
      keptFromProductionBuilder: kept,
      addedByProbe: added,
      credentialMode,
    },
  };
}

/** checkProbeEnv `allow` predicates for one credential mode (placeholder values only). */
export function allowForCredentialMode(credentialMode, { baseUrl } = {}) {
  const baseOk = (value) => value === baseUrl && isLoopbackUrl(value);
  if (credentialMode === 'oauth-init')
    return {
      CLAUDE_CODE_OAUTH_TOKEN: (value) => value === SYNTHETIC_OAUTH_TOKEN,
    };
  if (credentialMode === 'oauth-loopback')
    return {
      CLAUDE_CODE_OAUTH_TOKEN: (value) => value === SYNTHETIC_OAUTH_TOKEN,
      ANTHROPIC_BASE_URL: baseOk,
    };
  return {
    ANTHROPIC_BASE_URL: baseOk,
    ANTHROPIC_API_KEY: (value) => value === PLACEHOLDER_API_KEY,
  };
}

/**
 * Canonical-state environment checks. Returns one entry per check; nothing is
 * sent unless every entry is ok. Reports names, never credential values.
 */
export function verifyProviderEnvironment({
  env,
  envWithoutProxy,
  layout,
  baseUrl,
  proxyUrl,
  expectDisableMds,
  hostEnv = process.env,
  credentialMode = 'api-key',
  extraAllowedNames = [],
  expectAutoMemoryDisabled = false,
  expectedExtraEnv = {},
}) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const loopbackBase = credentialMode !== 'oauth-init';
  const strict = checkProbeEnv(envWithoutProxy, {
    root: layout.root,
    allow: allowForCredentialMode(credentialMode, { baseUrl }),
    hostEnv,
  });
  add(
    'checkProbeEnv',
    strict.ok,
    strict.ok
      ? credentialMode === 'api-key'
        ? 'only ANTHROPIC_BASE_URL (loopback capture) and the placeholder ANTHROPIC_API_KEY are credential-named'
        : 'only the synthetic placeholder OAuth token (and, in the loopback arm, the loopback base URL) are credential-named'
      : strict.violations,
  );
  add(
    'home-synthetic',
    env.HOME === layout.home && isInside(layout.root, env.HOME),
    { HOME: env.HOME },
  );
  add(
    'config-dir-synthetic',
    env.CLAUDE_CONFIG_DIR === layout.claudeConfigDir &&
      isInside(layout.root, env.CLAUDE_CONFIG_DIR) &&
      env.CLAUDE_CONFIG_DIR !== layout.claudeHomeDir,
    { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR },
  );
  add(
    'tmp-synthetic',
    [env.TMPDIR, env.TMP, env.TEMP, env.CLAUDE_CODE_TMPDIR].every(
      (value) => typeof value === 'string' && isInside(layout.root, value),
    ),
    { CLAUDE_CODE_TMPDIR: env.CLAUDE_CODE_TMPDIR },
  );
  if (credentialMode === 'api-key') {
    add(
      'base-url-loopback-capture',
      env.ANTHROPIC_BASE_URL === baseUrl &&
        isLoopbackUrl(env.ANTHROPIC_BASE_URL),
      { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL },
    );
    add(
      'api-key-placeholder',
      env.ANTHROPIC_API_KEY === PLACEHOLDER_API_KEY,
      'ANTHROPIC_API_KEY equals the placeholder',
    );
  } else {
    add(
      'oauth-token-placeholder',
      env.CLAUDE_CODE_OAUTH_TOKEN === SYNTHETIC_OAUTH_TOKEN,
      'CLAUDE_CODE_OAUTH_TOKEN equals the synthetic placeholder (value not reported)',
    );
    add(
      'no-api-key',
      !('ANTHROPIC_API_KEY' in env) && !('ANTHROPIC_AUTH_TOKEN' in env),
      'no API key or auth token variable is present',
    );
    add(
      'base-url-expectation',
      loopbackBase
        ? env.ANTHROPIC_BASE_URL === baseUrl &&
            isLoopbackUrl(env.ANTHROPIC_BASE_URL)
        : !('ANTHROPIC_BASE_URL' in env),
      loopbackBase
        ? {
            ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
            label: 'non-production loopback transport',
          }
        : 'production-shaped: no ANTHROPIC_BASE_URL',
    );
    add(
      'no-bare-mode-environment',
      BARE_MODE_ENV_NAMES.every((name) => !(name in env)),
      'bare/SIMPLE mode skips OAuth and keychain credentials; never used for OAuth arms',
    );
  }
  add(
    'no-host-canary-variable',
    !('BAP0_HOST_ENV_CANARY' in env),
    'host environment canary variable is not passed',
  );
  add(
    'traffic-flags',
    REQUIRED_TRAFFIC_FLAGS.every((name) => env[name] === '1'),
    Object.fromEntries(
      REQUIRED_TRAFFIC_FLAGS.map((name) => [name, env[name] ?? null]),
    ),
  );
  const allowedNames = new Set([...ALLOWED_ENV_NAMES, ...extraAllowedNames]);
  const names = Object.keys(env).filter((name) => !PROXY_NAMES.includes(name));
  const unexpected = names.filter((name) => !allowedNames.has(name));
  add(
    'name-allowlist',
    unexpected.length === 0,
    unexpected.length ? { unexpected } : { names: names.sort() },
  );
  add(
    'auto-memory-flag-expectation',
    (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') ===
      Boolean(expectAutoMemoryDisabled),
    {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY:
        env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
      expected: Boolean(expectAutoMemoryDisabled),
    },
  );
  const wrongExtras = Object.entries(expectedExtraEnv).filter(
    ([name, value]) => env[name] !== value,
  );
  add(
    'expected-extra-env',
    wrongExtras.length === 0,
    wrongExtras.length
      ? { mismatched: wrongExtras.map(([name]) => name) }
      : { names: Object.keys(expectedExtraEnv) },
  );
  add(
    'disable-mds-expectation',
    (env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1') === Boolean(expectDisableMds),
    {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS:
        env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
      expected: Boolean(expectDisableMds),
    },
  );
  const proxyOk =
    ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].every(
      (name) => env[name] === proxyUrl,
    ) &&
    isLoopbackUrl(proxyUrl) &&
    env.NO_PROXY === NO_PROXY_VALUE;
  add('proxy-refusing-loopback', proxyOk, {
    proxy: proxyUrl,
    NO_PROXY: env.NO_PROXY ?? null,
  });
  return { ok: checks.every((check) => check.ok), checks };
}

/** Resolved binary must live under <repo>/.cache/bin and be named `claude`. */
export function checkBinaryLocation(binaryPath, repoRoot = REPO_ROOT) {
  const resolved = path.resolve(binaryPath);
  const cacheBin = path.join(repoRoot, '.cache', 'bin');
  const ok =
    isInside(cacheBin, resolved) && path.basename(resolved) === 'claude';
  return { ok, resolved, expectedUnder: cacheBin };
}

/** Extract the version from `claude --version` output (`2.1.284 (Claude Code)`). */
export function parseClaudeVersion(output) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(output));
  return match ? match[1] : null;
}

function defaultRunVersion(binary, env, cwd) {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--version'],
      { env, cwd, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          error: error ? String(error.message).slice(0, 300) : null,
          stdout: String(stdout),
          stderr: String(stderr).slice(0, 500),
        });
      },
    );
  });
}

/** Pin verification: binary location + `--version` + installed SDK package version. */
export async function verifyPins({
  binaryPath,
  env,
  cwd,
  runVersion = defaultRunVersion,
  readSdkPackage,
} = {}) {
  const location = checkBinaryLocation(binaryPath);
  const sdkPackagePath = path.join(
    REPO_ROOT,
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'package.json',
  );
  const readSdk =
    readSdkPackage ??
    (async () => JSON.parse(await readFile(sdkPackagePath, 'utf8')));
  const sdk = await readSdk()
    .then((pkg) => ({ version: pkg.version }))
    .catch((error) => ({
      version: null,
      error: String(error.message).slice(0, 200),
    }));
  let cli = { version: null, error: 'skipped: binary outside .cache/bin' };
  if (location.ok) {
    const result = await runVersion(binaryPath, env, cwd);
    cli = {
      version: parseClaudeVersion(result.stdout),
      raw: result.stdout.trim().slice(0, 120),
      error: result.error,
    };
  }
  const cliOk = cli.version === EXPECTED_PINS.claudeCli;
  const sdkOk = sdk.version === EXPECTED_PINS.claudeAgentSdk;
  return {
    ok: location.ok && cliOk && sdkOk,
    location,
    cli: { ...cli, expected: EXPECTED_PINS.claudeCli, ok: cliOk },
    sdk: { ...sdk, expected: EXPECTED_PINS.claudeAgentSdk, ok: sdkOk },
  };
}

/** Requested versus reported model; any difference is a silent fallback. */
export function checkModelIdentity({
  requested,
  initModel,
  requestModels = [],
}) {
  const norm = (value) => String(value ?? '').replace(/\[1m\]$/, '');
  const problems = [];
  if (
    initModel !== null &&
    initModel !== undefined &&
    norm(initModel) !== norm(requested)
  )
    problems.push(
      `init model ${initModel} differs from requested ${requested}`,
    );
  for (const model of requestModels)
    if (norm(model) !== norm(requested))
      problems.push(
        `request body model ${model} differs from requested ${requested}`,
      );
  return {
    ok: problems.length === 0,
    requested,
    initModel: initModel ?? null,
    requestModels,
    problems,
  };
}
