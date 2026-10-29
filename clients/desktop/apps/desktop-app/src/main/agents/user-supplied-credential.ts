import { getEnhancedEnv } from '../pipelines/config-paths';

/**
 * Value-bearing provider credentials a user can supply through Canopy
 * Environments, which the spawn honors but the auth probe cannot see.
 * `user-environment.ts` reserves only `PATH`, so every one of these is settable
 * per workspace.
 *
 * Boolean provider redirects live in
 * {@link USER_SUPPLIED_PROVIDER_REDIRECT_FLAGS} below, because presence alone
 * does not mean enabled.
 *
 * `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` are DELIBERATELY absent. A base URL
 * is a ROUTE, not a credential: it says where requests go, never that the user
 * can authenticate there. Counting one on presence alone was a false positive
 * in the dangerous direction — a user pointing at a proxy while genuinely
 * logged out flipped `claudeNativeAuth` to `true`, got a native model seeded,
 * and then hit the raw `Please run /login` this whole change exists to remove
 * (the same mistake the `CLAUDE_CODE_USE_BEDROCK=0` interpretation below was
 * written to avoid). A base URL paired with a real key is already covered by
 * the key itself, so nothing is lost; a proxy needing no auth at all now reads
 * as "no user-supplied credential" and routes to AI Credits, which is a
 * recoverable wrong lane rather than an unrecoverable login prompt, and matches
 * the fail-closed posture the rest of this file commits to.
 */
const USER_SUPPLIED_PROVIDER_CREDENTIAL_KEYS: Readonly<
  Record<'claude' | 'codex', readonly string[]>
> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
};

/**
 * Provider-redirect keys from the same source that are BOOLEAN rather than
 * value-bearing. They must be interpreted, not merely tested for presence: a
 * user who sets `CLAUDE_CODE_USE_BEDROCK=0` to explicitly *disable* Bedrock
 * would otherwise trip the guard, fall back to native, and get the raw
 * `Please run /login` this whole change exists to remove.
 */
const USER_SUPPLIED_PROVIDER_REDIRECT_FLAGS: Readonly<
  Record<'claude' | 'codex', readonly string[]>
> = {
  claude: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  codex: [],
};

/** Values a boolean redirect flag can carry that mean "not enabled". */
const DISABLED_FLAG_VALUES: ReadonlySet<string> = new Set([
  '0',
  'false',
  'off',
  'no',
]);

/**
 * Whether the effective spawn environment supplies a provider credential the
 * auth probe could not have seen.
 *
 * The probe runs `getEnhancedEnv({ environment: false })`, which deliberately
 * drops the Canopy Environments injector, while the agent spawn runs
 * `getEnhancedEnv({ environment: { runtime: 'agent', workspaceId } })`. A user
 * who supplies `ANTHROPIC_API_KEY` (or a Bedrock/Vertex redirect, or the Codex
 * equivalent) through Environments therefore looks signed out to the probe but
 * has a perfectly good provider at spawn time. Routing them would not merely
 * bypass that provider — `buildClaudeProxyEnv` blanks `ANTHROPIC_API_KEY` and
 * overrides `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, and is spread *after*
 * the user environment, so it wins — meaning their own paid credential is
 * suppressed and Canopy AI Credits are spent instead (ECW-9091 review round 5).
 *
 * Only consulted on the `no-native-auth` path. Reaching that path means the
 * probe already returned a CONFIRMED logout, so anything found here arrived via
 * the injector rather than the process environment — a process-level credential
 * would have made the probe report `loggedIn: true` and never routed at all.
 *
 * Fail-closed: any error resolving the environment returns `false`, preserving
 * the ECW-9091 routing fix rather than stranding a genuinely credits-only user.
 *
 * @param workspaceId Workspace whose Environments assignments apply. Optional
 * because `EnvironmentRuntimeAssignments` has a global slot per runtime and the
 * workspace is only an override — so helper and pipeline callers with no
 * workspace in hand still get the globally-assigned environment resolved.
 * @param runtime Which runtime slot to resolve. Pipeline callers pass
 * `'pipeline'`; everything else uses the agent slot.
 */
export function hasUserSuppliedProviderCredential(
  provider: 'claude' | 'codex',
  workspaceId?: string,
  runtime: 'agent' | 'pipeline' = 'agent',
): boolean {
  try {
    const env = getEnhancedEnv({
      environment: {
        runtime,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      },
    });
    const hasCredential = USER_SUPPLIED_PROVIDER_CREDENTIAL_KEYS[provider].some(
      (key) => (env[key] ?? '').trim().length > 0,
    );
    if (hasCredential) {
      return true;
    }
    // Boolean redirects are interpreted rather than merely present: `=0` means
    // the user turned the redirect OFF, which is not a credential.
    return USER_SUPPLIED_PROVIDER_REDIRECT_FLAGS[provider].some((key) => {
      const value = (env[key] ?? '').trim().toLowerCase();
      return value.length > 0 && !DISABLED_FLAG_VALUES.has(value);
    });
  } catch {
    return false;
  }
}
