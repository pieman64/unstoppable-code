/**
 * Canonical grammar for user-visible skill and plugin-member invocations.
 * Unknown and tool-loop harnesses intentionally use bare names.
 */
export type InvocationHarness = string | null | undefined;

export function invocationPrefixForHarness(harness: InvocationHarness): string {
  if (harness === 'claude') return '/';
  if (harness === 'codex') return '$';
  return '';
}

export function standaloneSkillInsertText(
  name: string,
  harness: InvocationHarness,
): string {
  return `${invocationPrefixForHarness(harness)}${name} `;
}

export function pluginMemberInvocation(
  pluginName: string,
  memberName: string,
  harness: InvocationHarness,
): string {
  return `${invocationPrefixForHarness(harness)}${pluginName}:${memberName}`;
}

export function pluginMemberInsertText(
  pluginName: string,
  memberName: string,
  harness: InvocationHarness,
): string {
  return `${pluginMemberInvocation(pluginName, memberName, harness)} `;
}
