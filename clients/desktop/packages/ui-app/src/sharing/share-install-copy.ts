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
  | 'open';

/**
 * The noun for each entity as it appears in sentence-case copy. A workspace
 * share is a Blueprint, which the reader receives as a project.
 */
const ENTITY_NOUN: Readonly<Record<ShareInstallEntity, string>> = {
  skill: 'skill',
  plugin: 'plugin',
  pipeline: 'pipeline',
  automation: 'automation',
  agent: 'agent',
  collection: 'collection',
  workspace: 'project',
};

const DEFAULT_DESCRIPTION: Readonly<Record<ShareInstallEntity, string>> = {
  skill: 'A skill your agents can use when it fits the task.',
  plugin: 'A plugin that adds tools and skills to your agents.',
  pipeline: 'A pipeline you can run on a project when you need it.',
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
