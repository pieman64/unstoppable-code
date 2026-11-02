import type { DeepLinkResolveShareResponse } from '@canopy/protocol/share-deep-link';
/**
 * Copy for installing a shared resource (CAN-3710), shared by the desktop
 * install review and the web `/share/*` landers so both say the same thing.
 *
 * It lives apart from the sharing barrel so first-screen web code can import
 * it through `@canopy/ui-app/sharing/share-install-copy` without loading the
 * sharing dialogs.
 */
import type { DesktopShareDeepLinkEntity } from '@canopy/protocol/share-deep-link';
import {
  WORKSPACE_TEMPLATE_SHARE_LABEL,
  WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER,
} from '@canopy/protocol/workspace-templates';

/** Every shared resource that installs; a shared container is accepted, not installed. */
export type ShareInstallEntity = Exclude<
  DesktopShareDeepLinkEntity,
  'shared-container'
>;

/** Where the install's primary action stands. */
export type ShareInstallActionState =
  | 'install'
  | 'installing'
  | 'update'
  | 'updating'
  | 'open'
  // An installed skill over a chat: stages its invocation in that chat's
  // composer without sending (CAN-5219).
  | 'use-in-chat';

/**
 * The noun for each entity as it appears in sentence-case copy. A workspace
 * share is a Blueprint, which the reader receives as a project.
 */
const ENTITY_NOUN: Readonly<Record<ShareInstallEntity, string>> = {
  skill: 'skill',
  plugin: 'plugin',
  pipeline: 'workflow',
  automation: 'automation',
  agent: 'agent',
  collection: 'collection',
  workspace: 'project',
};

const DEFAULT_DESCRIPTION: Readonly<Record<ShareInstallEntity, string>> = {
  skill: 'A skill your agents can use when it fits the task.',
  plugin: 'A plugin that adds tools and skills to your agents.',
  pipeline: 'A workflow you can run on a project when you need it.',
  automation: 'An automation that runs a task for you on a schedule.',
  agent: 'An agent you can start from any chat.',
  collection: 'A set of skills and plugins that install together.',
  workspace: 'A project template with its setup ready to use.',
};

/**
 * The primary action's label. `Install` is a plain verb with no noun on every
 * entity, Blueprints included; the installed state names the outcome
 * (`Open project`), as `docs/ux-writing.md` requires.
 */
export function shareInstallActionLabel(
  entity: ShareInstallEntity,
  state: ShareInstallActionState,
): string {
  switch (state) {
    case 'install':
      return 'Install';
    case 'installing':
      return 'Installing…';
    case 'update':
      return 'Update';
    case 'updating':
      return 'Updating…';
    case 'open':
      return `Open ${ENTITY_NOUN[entity]}`;
    case 'use-in-chat':
      return 'Use in this chat';
  }
}

/** The entity's noun in sentence-case copy (`project` for a Blueprint). */
export function shareInstallEntityNoun(entity: ShareInstallEntity): string {
  return ENTITY_NOUN[entity];
}

/**
 * The shared item's type, as the install review's subtitle shows it. A
 * workspace share arrives as a project template and installs as a project.
 */
export function shareInstallTypeLabel(entity: ShareInstallEntity): string {
  if (entity === 'workspace') return WORKSPACE_TEMPLATE_SHARE_LABEL;
  const noun = ENTITY_NOUN[entity];
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
}

/** The loading title before the item's own name is known (`Shared skill`). */
export function shareInstallPlaceholderTitle(
  entity: ShareInstallEntity,
): string {
  return `Shared ${
    entity === 'workspace'
      ? WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER
      : ENTITY_NOUN[entity]
  }`;
}

/** One friendly line for a shared item published without a description. */
export function shareInstallDefaultDescription(
  entity: ShareInstallEntity,
): string {
  return DEFAULT_DESCRIPTION[entity];
}

/**
 * One segment of a share's attribution, in display order. Hosts render each
 * part themselves so a person's name can carry their replay protection.
 */
export type ShareAttributionPart =
  | { readonly kind: 'sharer'; readonly name: string }
  | { readonly kind: 'owner'; readonly name: string }
  | {
      readonly kind: 'audience';
      readonly label: string;
      readonly name?: string;
    };

/** The separator between attribution parts (`Shared by Ada · Platform`). */
export const SHARE_ATTRIBUTION_SEPARATOR = ' · ';

/** The copy before the sharer's name; hosts render the name separately. */
export const SHARE_ATTRIBUTION_SHARER_PREFIX = 'Shared by ';

/**
 * Who shared it, who owns it, and who can see it, dropping any part that is
 * missing or blank.
 */
export function shareAttributionParts({
  sharerName,
  ownerName,
  audienceLabel,
  audienceName,
  preserveOwnerWhitespace = false,
}: {
  readonly sharerName?: string | null;
  readonly ownerName?: string | null;
  readonly audienceLabel?: string | null;
  readonly audienceName?: string | null;
  /** The existing web attribution preserves its owner text verbatim. */
  readonly preserveOwnerWhitespace?: boolean;
}): readonly ShareAttributionPart[] {
  const parts: ShareAttributionPart[] = [];
  const sharer = sharerName?.trim();
  if (sharer) parts.push({ kind: 'sharer', name: sharer });
  const owner = preserveOwnerWhitespace ? ownerName : ownerName?.trim();
  if (owner) parts.push({ kind: 'owner', name: owner });
  const audience = audienceLabel?.trim();
  const name = audienceName?.trim();
  if (audience) {
    parts.push({
      kind: 'audience',
      label: audience,
      ...(name ? { name } : {}),
    });
  }
  return parts;
}

/** One part's text (`Shared by Ada`, `Acme`, `Team: Platform`). */
function shareAttributionPartText(part: ShareAttributionPart): string {
  switch (part.kind) {
    case 'sharer':
      return `${SHARE_ATTRIBUTION_SHARER_PREFIX}${part.name}`;
    case 'owner':
      return part.name;
    case 'audience':
      return part.name ? `${part.label}: ${part.name}` : part.label;
  }
}

/** The parts joined as plain text, or `''` when there are none. */
export function shareAttributionText(
  parts: readonly ShareAttributionPart[],
): string {
  return parts.map(shareAttributionPartText).join(SHARE_ATTRIBUTION_SEPARATOR);
}

/**
 * Where an installed skill copy is available, as the install path decides it.
 * `organization` without a name is a scoped install whose owning
 * organization's name is unavailable; `unknown` is an install whose scope
 * itself cannot be established.
 */
export type SkillInstallScope =
  | { readonly kind: 'all-contexts' }
  | { readonly kind: 'organization'; readonly name: string | null }
  | { readonly kind: 'personal' }
  | { readonly kind: 'unknown' };

const SKILL_INSTALL_UPDATE_NOTE =
  "Later edits to the shared skill won't automatically update this copy.";

/** What installing a shared skill does, said before the reader installs it. */
export function shareInstallSkillEffect(scope: SkillInstallScope): string {
  return shareInstallSkillEffectParts(scope)
    .map((part) => part.text)
    .join('');
}

/** Keep context names separate so hosts can protect identifying text in replay. */
export function shareInstallSkillEffectParts(
  scope: SkillInstallScope,
): readonly { readonly kind: 'copy' | 'name'; readonly text: string }[] {
  switch (scope.kind) {
    case 'all-contexts':
      return [
        {
          kind: 'copy',
          text: `Adds a copy to this device, available in every context. ${SKILL_INSTALL_UPDATE_NOTE}`,
        },
      ];
    case 'personal':
      return [
        {
          kind: 'copy',
          text: `Adds a copy to this device for your Personal context. ${SKILL_INSTALL_UPDATE_NOTE}`,
        },
      ];
    case 'organization': {
      const name = scope.name?.trim();
      return name
        ? [
            { kind: 'copy', text: 'Adds a copy to this device for the ' },
            { kind: 'name', text: name },
            { kind: 'copy', text: ` context. ${SKILL_INSTALL_UPDATE_NOTE}` },
          ]
        : [
            {
              kind: 'copy',
              text: `Adds a copy to this device for the owning organization's context. ${SKILL_INSTALL_UPDATE_NOTE}`,
            },
          ];
    }
    case 'unknown':
      return [
        {
          kind: 'copy',
          text: `Adds a copy to this device. ${SKILL_INSTALL_UPDATE_NOTE}`,
        },
      ];
  }
}

/**
 * Why a shared item could not be opened (CAN-5222). It derives from the portable
 * resolve response contract shared with the desktop host. A failed read never proves why: an unauthorized read may answer a
 * uniform 404, and a 403 covers more than organization membership.
 */
export type ShareLandingFailureReason = Extract<
  DeepLinkResolveShareResponse,
  { ok: false }
>['reason'];

/** The product names a landing failure may mention, from the host's brand. */
export interface ShareLandingBrandNames {
  /** The app's name, e.g. `Canopy`. */
  readonly appName: string;
  /** The hosted service's name, as the host shows it. */
  readonly serverName: string;
}

/**
 * The failure as one line for the reader. It never claims the share was
 * revoked or names an organization: neither follows from a failed read.
 */
export function shareLandingErrorCopy(
  reason: ShareLandingFailureReason,
  entity: ShareInstallEntity,
  brand: ShareLandingBrandNames,
): string {
  const noun = ENTITY_NOUN[entity];
  switch (reason) {
    case 'not-found':
      return "This share isn't available. It may no longer exist, or you may not have access.";
    case 'sign-in-required':
      return `Sign in to open this ${noun}.`;
    case 'not-a-member':
      return `This account doesn't have access to this ${noun}. Try signing in with another account.`;
    case 'client-upgrade-required':
      // Never offer a YAML-only fallback here: the share is packaged, and
      // installing the definition alone would be an incomplete install
      // presented as a success.
      return `This shared workflow includes dependencies that this version of ${brand.appName} cannot install. Update to the latest version to continue.`;
    case 'share-changed':
      return 'This share changed. Return to the share page to review the updated version.';
    case 'cloud-unreachable':
      return `Couldn't reach ${brand.serverName}. Check your connection and try again.`;
  }
}

/**
 * The one action that may recover a landing failure. The host wires each to
 * its own sign-in, account, retry and update surfaces.
 */
export type ShareLandingRecoveryAction =
  | 'sign-in'
  | 'switch-account'
  | 'retry'
  | 'check-for-updates';

/**
 * The failure's recovery action, or `null` when nothing the reader can do
 * here would help: an unavailable share, or one that changed after review.
 */
export function shareLandingRecoveryAction(
  reason: ShareLandingFailureReason,
): ShareLandingRecoveryAction | null {
  switch (reason) {
    case 'sign-in-required':
      return 'sign-in';
    case 'not-a-member':
      return 'switch-account';
    case 'cloud-unreachable':
      return 'retry';
    case 'client-upgrade-required':
      return 'check-for-updates';
    case 'not-found':
    case 'share-changed':
      return null;
  }
}

/** The recovery action's button label. */
export function shareLandingRecoveryActionLabel(
  action: ShareLandingRecoveryAction,
): string {
  switch (action) {
    case 'sign-in':
      return 'Sign in';
    case 'switch-account':
      return 'Switch account';
    case 'retry':
      return 'Retry';
    case 'check-for-updates':
      return 'Check for updates';
  }
}
