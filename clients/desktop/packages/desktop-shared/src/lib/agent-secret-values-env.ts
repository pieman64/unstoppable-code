import { brandEnvCandidates } from '../brand/env';

/**
 * `env` without the step's `AGENT_SECRET_VALUES` aggregate (or its
 * `PIPELINE_LEDGER_TOOLS` route, below).
 *
 * The step runner hands a builtin agent action one JSON list of every
 * configured value so the action can mask what it writes itself. That list is
 * for the action process only. A provider it starts (the Claude CLI and the
 * tools it runs, a structured helper, a hook) has no use for it, and an agent
 * that prints it prints every value at once, already JSON-escaped. Each value
 * stays available to the provider under its own configured name, exactly as
 * before; only the aggregate is withheld. Every other variable, credentials
 * and provider settings included, is kept.
 */
const AGENT_SECRET_VALUES_NAMES = brandEnvCandidates('AGENT_SECRET_VALUES');
/**
 * The Agent Ledger route a desktop step hands its action (phase 08). The
 * action passes it to the provider as MCP configuration; the environment the
 * provider and its tools inherit never carries the route's token.
 */
const PIPELINE_LEDGER_TOOLS_NAMES = brandEnvCandidates('PIPELINE_LEDGER_TOOLS');

export function withoutAgentSecretValues(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return stripAgentSecretValues({ ...env });
}

/**
 * The same removal applied to an environment object the caller already owns.
 *
 * `getEnhancedEnv` runs once per spawned process and already builds a fresh
 * environment object, so calling `withoutAgentSecretValues` there copied the
 * whole environment a SECOND time per spawn. Under the worktree-concurrency
 * benchmark that showed up as the hottest Electron-main frame. Stripping in
 * place keeps one copy per spawn, as before this change.
 */
export function stripAgentSecretValues(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const name of AGENT_SECRET_VALUES_NAMES) delete env[name];
  for (const name of PIPELINE_LEDGER_TOOLS_NAMES) delete env[name];
  return env;
}
