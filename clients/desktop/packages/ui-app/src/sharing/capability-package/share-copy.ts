import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';

/**
 * Copy the share dialog uses to disclose what leaves the machine and who can
 * then read it. One module for every resource, parameterized by the noun.
 */

/**
 * Where a team or organization share shows up for the people it is shared
 * with. Skills, pipelines, automations, agents, collections, plugins and
 * project templates all land in Customize. The `'marketplace'` value is the
 * stable internal identifier.
 */
export type ShareLanding = 'marketplace';

export interface ShareAudienceHelperOptions {
  /** The share carries dependency files (Public only). */
  readonly includesDependencies?: boolean;
  /** Where a team or organization share lands (Team and Organization only). */
  readonly landing?: ShareLanding;
  /** The picked team or organization, named once it is known. */
  readonly targetName?: string;
}

/**
 * Helper under the audience selector: who can see the share and where it
 * appears for them. One sentence per audience, so every share dialog answers
 * the same question in the same words.
 */
export function shareAudienceHelper(
  noun: string,
  audience: 'public',
  options?: ShareAudienceHelperOptions,
): string;
export function shareAudienceHelper(
  noun: string,
  audience: 'team' | 'organization',
  options: ShareAudienceHelperOptions & { readonly landing: ShareLanding },
): string;
export function shareAudienceHelper(
  noun: string,
  audience: 'team' | 'organization' | 'public',
  options: ShareAudienceHelperOptions = {},
): string {
  if (audience === 'public') {
    return options.includesDependencies === true
      ? `Anyone can view this ${noun} and download its included dependency files. It may appear in public discovery and search.`
      : `Anyone can view this ${noun}. It may appear in public discovery and search.`;
  }
  const targetName = options.targetName?.trim();
  if (audience === 'team') {
    return targetName
      ? `Members of ${targetName} can find this ${noun} in ${CUSTOMIZE_LABEL}.`
      : `Team members can find this ${noun} in ${CUSTOMIZE_LABEL}.`;
  }
  return targetName
    ? `Everyone in ${targetName} can find this ${noun} in ${CUSTOMIZE_LABEL}.`
    : `Everyone in the organization can find this ${noun} in ${CUSTOMIZE_LABEL}.`;
}

/**
 * Result when the cloud copy landed but its public link did not. Nobody else
 * can see the resource yet, so the sentence says so without naming a
 * "private" audience the author never picked.
 */
export function publicShareDegradedLabel(noun: string): string {
  return `The public link could not be created. Only you can see this ${noun} until you retry.`;
}

export const PUBLIC_SHARE_RETRY_LABEL = 'Try the public link again';
