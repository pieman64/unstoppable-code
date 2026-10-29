// Drift guard: the probe re-declares the production delegation spawn profile
// instead of importing route-runtime.ts (Electron-coupled). This module reads
// that source text and proves the copy still matches.

/** The profile the probe uses; must equal the production delegation profile. */
export const PROBE_CONFIG_ARGS = Object.freeze([
  '-c',
  'features.hooks=false',
  '-c',
  'features.apps=false',
]);

/** Extract the literal string array returned by `delegationCodexConfigArgs`. */
export function extractDelegationConfigArgs(source) {
  const match =
    /export function delegationCodexConfigArgs\(\): string\[\] \{\s*return \[([^\]]*)\];/.exec(
      source,
    );
  if (!match) return null;
  return [...match[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map(
    (m) => m[1] ?? m[2],
  );
}

/**
 * @returns {{ status: 'pass'|'fail', extracted: string[]|null, problems: string[] }}
 */
export function checkDelegationProfileDrift(source) {
  const problems = [];
  const extracted = extractDelegationConfigArgs(source);
  if (!extracted)
    problems.push(
      'delegationCodexConfigArgs literal not found in route-runtime.ts',
    );
  else if (JSON.stringify(extracted) !== JSON.stringify(PROBE_CONFIG_ARGS))
    problems.push(
      `configArgs differ: source ${JSON.stringify(extracted)} vs probe ${JSON.stringify(PROBE_CONFIG_ARGS)}`,
    );
  const profileBlock =
    /profile: \{([\s\S]*?configArgs: delegationCodexConfigArgs\(\),)/.exec(
      source,
    )?.[1] ?? '';
  if (!/environmentPolicy: 'restricted'/.test(profileBlock))
    problems.push("profile no longer has environmentPolicy: 'restricted'");
  if (!/includeCanopySecrets: false/.test(profileBlock))
    problems.push('profile no longer has includeCanopySecrets: false');
  if (!/:delegation`/.test(profileBlock))
    problems.push(
      'profile no longer uses the :delegation logical workspace environment suffix',
    );
  return {
    status: problems.length === 0 ? 'pass' : 'fail',
    extracted,
    problems,
  };
}
