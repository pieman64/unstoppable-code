import { resolveCodexHomeWithoutSpawn } from '../../../codex/resolve-codex-home';

/**
 * Resolves the existing Codex state directory without starting an app-server.
 * Delegates to the shared resolver so the memory import and the marketplace
 * staging janitor cannot drift apart on this rule.
 */
export async function resolveCodexMemoryHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  return resolveCodexHomeWithoutSpawn(env);
}
