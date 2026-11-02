import {
  Bot,
  CreditCard,
  ExperimentIcon,
  Eye,
  FileText,
  Globe,
  Lock,
  Mail,
  PluginsIcon,
  User,
} from '@canopy/ui-shared/icons/AppIcons';
import { AI_CREDITS_LABEL } from '@canopy/ui-shared';
import {
  ACCOUNT_PUBLIC_PROFILE_PATH,
  accountSettingsNavKeyForRoute,
  type AccountSettingsNavFlags,
} from '@canopy/protocol/settings';
import {
  EXTERNAL_AGENTS_LABEL,
  EXTERNAL_AGENTS_PATH,
} from '../../external-agents/paths';
import { parseSettingsPathname } from './settings-path';

export type AccountNavKey =
  | 'account'
  | 'profile'
  | 'digests'
  | 'notifications'
  | 'integrations'
  | 'externalAgents'
  | 'security'
  | 'billing'
  | 'labs'
  | 'appearance';

export interface AccountNavItem {
  readonly key: AccountNavKey;
  readonly label: string;
  /** One sentence under the page header title. See `docs/ux-writing.md`. */
  readonly description: string;
  readonly href: string;
  readonly icon: typeof User;
}

/**
 * Order follows the convention the org Settings subtabs adopted: identity
 * first, then how that identity is published, then the controls that protect
 * it, then the commercial surface last. Billing is the target of every
 * external deep link into this surface (/subscribe, the desktop portal
 * hand-off), so its tail position costs it no discoverability.
 *
 * Notifications sits after Public profile on the same reasoning: it is about
 * what Canopy sends outward on the user's behalf, so it follows identity and
 * publication and precedes the protective and commercial controls.
 *
 * Digests sits between publication and Notifications because a digest archive
 * is durable work content, not delivery configuration. Notifications keeps the
 * cadence/opt-in settings; Digests is where the reports themselves live.
 *
 * Integrations (GitHub for cloud work) follows Notifications and precedes
 * Security: it is a connection to a third party that works on the user's
 * behalf, which reads as a continuation of what leaves the account outward,
 * ahead of the controls that protect the account itself.
 *
 * Labs comes last: it holds features still being tried, not settings of
 * the account itself.
 *
 * The settings rail lists these items; the account page header shows the
 * current item's label and description.
 */
export const ACCOUNT_NAV_ITEMS: readonly AccountNavItem[] = [
  {
    key: 'account',
    label: 'Account',
    description: 'Your name, photo and the email we use to reach you.',
    href: '/account',
    icon: User,
  },
  {
    key: 'profile',
    label: 'Public profile',
    description: 'What visitors see when they open your profile.',
    href: ACCOUNT_PUBLIC_PROFILE_PATH,
    icon: Globe,
  },
  {
    key: 'digests',
    label: 'Digests',
    description: 'Summaries of the work you shipped.',
    href: '/account/digests',
    icon: FileText,
  },
  {
    key: 'notifications',
    label: 'Notifications',
    description: 'Choose which emails and push alerts you get.',
    href: '/account/notifications',
    icon: Mail,
  },
  {
    key: 'integrations',
    label: 'Integrations',
    description:
      'Connect the accounts agents use to work for you, such as GitHub.',
    href: '/account/integrations',
    icon: PluginsIcon,
  },
  {
    key: 'externalAgents',
    label: EXTERNAL_AGENTS_LABEL,
    description:
      'Agents outside this app that you have allowed to act for you. Change what each one can do, pause it, or remove it.',
    href: EXTERNAL_AGENTS_PATH,
    icon: Bot,
  },
  {
    key: 'security',
    label: 'Security',
    description:
      'Manage how you sign in, two-factor authentication and API keys.',
    href: '/account/security',
    icon: Lock,
  },
  {
    key: 'billing',
    label: 'Billing',
    description: 'Your plan, AI credits, payment method and past payments.',
    href: '/account/billing',
    icon: CreditCard,
  },
  {
    key: 'appearance',
    label: 'Appearance',
    description: 'How chats look while agents work.',
    href: '/account/appearance',
    icon: Eye,
  },
  {
    key: 'labs',
    label: 'Labs',
    description: 'Try features we are still working on.',
    href: '/account/labs',
    icon: ExperimentIcon,
  },
];

/** The item for a key; the page header reads its label and description. */
export function accountNavItem(
  key: AccountNavKey,
  freeAccess = false,
): AccountNavItem {
  const item = ACCOUNT_NAV_ITEMS.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`Unknown account nav item: ${key}`);
  return key === 'billing' && freeAccess
    ? {
        ...item,
        label: AI_CREDITS_LABEL,
        description: 'Your AI Credit balance, payment methods and top-ups.',
      }
    : item;
}

/**
 * The flag-gated items each follow the flag their own page guards on, resolved
 * server-side, so an item never leads to a feature-off 404 or a redirect.
 *
 * With free access on, Billing keeps its key and `/account/billing` route (so
 * desktop, email, and credit deep links keep working) but is named "AI
 * Credits", the only thing the page still sells.
 */
export function visibleAccountNavItems(
  flags: AccountSettingsNavFlags,
): readonly AccountNavItem[] {
  return ACCOUNT_NAV_ITEMS.filter((item) => {
    if (item.key === 'billing') return flags.billingEnabled;
    if (item.key === 'digests') return flags.digestsEnabled;
    if (item.key === 'integrations') return flags.integrationsEnabled;
    if (item.key === 'externalAgents')
      return flags.externalAgentsEnabled === true;
    if (item.key === 'labs') return flags.labsEnabled === true;
    if (item.key === 'appearance') return flags.appearanceEnabled === true;
    return true;
  }).map((item) => accountNavItem(item.key, flags.freeAccess === true));
}

/**
 * The account item a route belongs to, including deep sub-routes. `null` for
 * routes outside `/account` and for unknown account sub-routes, so a caller
 * never marks an unrelated item current.
 */
export function matchAccountNavKey(
  pathname: string | null | undefined,
): AccountNavKey | null {
  // External agents is a hosted web page, not a shared settings route.
  if (/^\/account\/external-agents(?:[/?#]|$)/.test(pathname ?? ''))
    return 'externalAgents';
  return accountSettingsNavKeyForRoute(parseSettingsPathname(pathname));
}
