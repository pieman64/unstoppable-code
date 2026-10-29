// Probe child environment: built from scratch (never a copy of process.env),
// pointing every home/config/data directory at the synthetic root.
import path from 'node:path';
import { REPO_ROOT } from './constants.mjs';
import { HOST_ENV_CANARY_NAME } from './canaries.mjs';
import { isInside } from './synthetic-root.mjs';

/** Placeholder accepted where a client insists on an API key being present. */
export const PLACEHOLDER_API_KEY = 'bap0-placeholder-not-a-credential';

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const CREDENTIAL_NAME =
  /(API_?KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH|COOKIE|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?ID|BEARER)/i;
const PROVIDER_PREFIX =
  /^(OPENAI|ANTHROPIC|CLAUDE_CODE_OAUTH|CODEX_API|AWS|GOOGLE|GEMINI|AZURE|GH|GITHUB|VERCEL|CURSOR|OPENROUTER|DEEPSEEK|MOONSHOT|ZHIPU|MINIMAX)_/i;
const PROXY_NAME = /^(HTTPS?|ALL|NO)_PROXY$/i;

/** True when a variable name looks like a credential or provider secret. */
export function isCredentialName(name) {
  return CREDENTIAL_NAME.test(name) || PROVIDER_PREFIX.test(name);
}

/**
 * Environment for a provider probe child process.
 *
 * @param {import('./synthetic-root.mjs').SyntheticLayout} layout
 * @param {{ hostEnvCanary: string }} options
 * @returns {Record<string, string>}
 */
export function buildProbeChildEnv(layout, { hostEnvCanary }) {
  const target =
    process.platform === 'win32'
      ? 'win32-x64'
      : `${process.platform}-${process.arch}`;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binDir = path.join(REPO_ROOT, '.cache', 'bin', target);
  return {
    // Existing central resolver overrides keep the pinned binaries independent
    // of the disposable process cwd; self-check verifies this cache first.
    CODEX_EXECUTABLE: path.join(binDir, `codex${suffix}`),
    CLAUDE_CODE_EXECUTABLE: path.join(binDir, `claude${suffix}`),
    BROWSER_AGENT_PROBE_PROCESS_SNAPSHOT: path.join(
      layout.records,
      'process-snapshot.json',
    ),
    PATH: SYSTEM_PATH,
    // Resolve repository aliases without using the checkout as process cwd.
    TSX_TSCONFIG_PATH: path.join(REPO_ROOT, 'tsconfig.json'),
    HOME: layout.home,
    USER: 'bap0-probe',
    LOGNAME: 'bap0-probe',
    // Keeps any login-shell probe off the user's rc files.
    SHELL: '/bin/sh',
    CODEX_HOME: layout.codexHome,
    CLAUDE_CONFIG_DIR: layout.claudeConfigDir,
    CANOPY_DATA_DIR: layout.canopyDataDir,
    // Dev runtime so the centralized resolver uses `<repo>/.cache/bin/<target>`.
    CANOPY_ENV: 'development',
    TMPDIR: layout.tmp,
    TMP: layout.tmp,
    TEMP: layout.tmp,
    LANG: 'en_US.UTF-8',
    TZ: 'UTC',
    // Not on any allowlist; must never reach a provider request.
    [HOST_ENV_CANARY_NAME]: hostEnvCanary,
  };
}

/**
 * Check an environment for credentials and host leakage. Returns violations
 * by variable NAME only; values are never reported.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ root: string, allow?: Record<string, (value: string) => boolean>, hostEnv?: NodeJS.ProcessEnv }} options
 *   `allow` maps permitted credential-looking names to a value predicate
 *   (for example the loopback base URL or `PLACEHOLDER_API_KEY`).
 */
export function checkProbeEnv(
  env,
  { root, allow = {}, hostEnv = process.env },
) {
  const violations = [];
  const hostSecretValues = new Set(
    Object.entries(hostEnv)
      .filter(
        ([name, value]) =>
          isCredentialName(name) &&
          typeof value === 'string' &&
          value.length >= 8,
      )
      .map(([, value]) => value),
  );
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (PROXY_NAME.test(name) && !(name in allow))
      violations.push({ name, reason: 'proxy-variable' });
    if (isCredentialName(name)) {
      const predicate = allow[name];
      if (!predicate || !predicate(value))
        violations.push({ name, reason: 'credential-name' });
    }
    if (hostSecretValues.has(value))
      violations.push({ name, reason: 'host-credential-value' });
  }
  for (const name of [
    'HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'CANOPY_DATA_DIR',
    'TMPDIR',
  ]) {
    if (env[name] !== undefined && !isInside(root, env[name]))
      violations.push({ name, reason: 'outside-synthetic-root' });
  }
  return { ok: violations.length === 0, violations };
}

/** Count (not names or values) of host credential-looking variables withheld. */
export function countWithheldHostCredentials(hostEnv = process.env) {
  return Object.keys(hostEnv).filter(isCredentialName).length;
}

/** Loopback URL predicate for base-URL style allowances. */
export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'ws:') &&
      (url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}
