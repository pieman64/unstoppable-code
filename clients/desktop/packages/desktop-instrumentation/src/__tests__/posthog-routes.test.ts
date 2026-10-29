import { PANEL_KINDS } from '@canopy/protocol/panels';
import type { NavigationPage } from '@canopy/desktop-shared/types';
import { redactText } from '../privacy';
import {
  HOSTED_SETTINGS_PAGE_ROUTES,
  NAVIGATION_PAGE_ROUTES,
  PANEL_KIND_ROUTES,
  POSTHOG_APP_ADVISOR_ROUTE,
  POSTHOG_CURRENT_URL_PROPERTY,
  POSTHOG_MAIN_ROUTE,
  POSTHOG_PAGELEAVE_EVENT,
  POSTHOG_PAGEVIEW_EVENT,
  POSTHOG_ROUTES,
  POSTHOG_ROUTE_VALUES,
  POSTHOG_SCREEN_ROUTE_PROPERTY,
  POSTHOG_SETTINGS_ROUTE,
  POSTHOG_WORKTREE_CHAT_ROUTE,
  SETTINGS_SECTION_ROUTES,
  buildPostHogRouteProperties,
  hostedSettingsPageKey,
  isPostHogRoute,
  routeForHostedSettingsRoute,
  routeForNavigationPage,
  routeForPanelKind,
  routeForSettingsSection,
  toPostHogRoute,
} from '../posthog-routes';
import type { PostHogRoute } from '../posthog-routes';

/**
 * Frozen snapshot of the complete generated route set. Any accidental route
 * string change — a rename, a typo, a silently added screen — shows up as a
 * diff here, in review, rather than as a downstream analytics mystery.
 */
const EXPECTED_ROUTES: readonly string[] = [
  'app://app-advisor',
  'app://main',
  'app://main/activity-states',
  'app://main/audit',
  'app://main/automations',
  'app://main/change-review',
  'app://main/chat',
  'app://main/environments',
  'app://main/feed',
  'app://main/header-states',
  'app://main/home',
  'app://main/kanban',
  'app://main/mcp-account-connections',
  'app://main/message-bubble-states',
  'app://main/notice-states',
  'app://main/overview',
  'app://main/pipelines',
  'app://main/plugins',
  'app://main/statistics',
  'app://main/usage',
  'app://main/watchers',
  'app://main/workers',
  'app://main/workflows',
  'app://main/workflows-library',
  'app://main/workflows-schedule',
  'app://main/worktree-chat',
  'app://main/worktree-states',
  'app://panel/activity-card',
  'app://panel/activity-section',
  'app://panel/automations',
  'app://panel/browser',
  'app://panel/change-diagram',
  'app://panel/chat-visuals',
  'app://panel/cost',
  'app://panel/file-diff',
  'app://panel/file-explorer',
  'app://panel/ledger',
  'app://panel/new-tab',
  'app://panel/pipeline-execution',
  'app://panel/plan',
  'app://panel/plan-diagram',
  'app://panel/session-breakdown',
  'app://panel/subagent-chat',
  'app://panel/subagents',
  'app://panel/terminal',
  'app://panel/usage',
  'app://settings',
  'app://settings/account',
  'app://settings/account-proxy',
  'app://settings/account/account',
  'app://settings/account/billing',
  'app://settings/account/digests',
  'app://settings/account/integrations',
  'app://settings/account/labs',
  'app://settings/account/notifications',
  'app://settings/account/profile',
  'app://settings/account/security',
  'app://settings/app-advisor',
  'app://settings/applications',
  'app://settings/approvals',
  'app://settings/browser',
  'app://settings/canopy',
  'app://settings/chat',
  'app://settings/claude',
  'app://settings/code-graph',
  'app://settings/codex',
  'app://settings/dictation',
  'app://settings/display',
  'app://settings/environment',
  'app://settings/experiments',
  'app://settings/feedback',
  'app://settings/files',
  'app://settings/git',
  'app://settings/harnesses',
  'app://settings/instructions',
  'app://settings/legal',
  'app://settings/mcp',
  'app://settings/memory',
  'app://settings/notifications',
  'app://settings/ollama',
  'app://settings/organization/digests',
  'app://settings/organization/feed',
  'app://settings/organization/groups',
  'app://settings/organization/members',
  'app://settings/organization/memory',
  'app://settings/organization/projects',
  'app://settings/organization/settings',
  'app://settings/organization/statistics',
  'app://settings/organizations/list',
  'app://settings/performance',
  'app://settings/plan-detection',
  'app://settings/plugins',
  'app://settings/privacy',
  'app://settings/remote-access',
  'app://settings/shortcuts',
  'app://settings/terminal',
];

function sortedRoutes(): string[] {
  return [...POSTHOG_ROUTE_VALUES].sort();
}

describe('PostHog synthetic screen routes', () => {
  describe('exhaustiveness', () => {
    it('maps every NavigationPage member', () => {
      // 25 members of the `NavigationPage` union in
      // `packages/desktop-shared/src/types.ts`. A new page fails compilation
      // in `posthog-routes.ts` first; this count is the runtime backstop.
      expect(Object.keys(NAVIGATION_PAGE_ROUTES)).toHaveLength(25);
      for (const route of Object.values(NAVIGATION_PAGE_ROUTES)) {
        expect(POSTHOG_ROUTES.has(route)).toBe(true);
      }
    });

    it('maps every one of the 32 SettingsSection members', () => {
      expect(Object.keys(SETTINGS_SECTION_ROUTES)).toHaveLength(32);
      for (const route of Object.values(SETTINGS_SECTION_ROUTES)) {
        if (route !== null) {
          expect(POSTHOG_ROUTES.has(route)).toBe(true);
        }
      }
    });

    it('maps every PanelKind member', () => {
      expect(Object.keys(PANEL_KIND_ROUTES)).toHaveLength(PANEL_KINDS.length);
      expect(Object.keys(PANEL_KIND_ROUTES).sort()).toEqual(
        [...PANEL_KINDS].sort(),
      );
      for (const route of Object.values(PANEL_KIND_ROUTES)) {
        if (route !== null) {
          expect(POSTHOG_ROUTES.has(route)).toBe(true);
        }
      }
    });

    it('routes the environment section to Settings → Environments (CAN-4269)', () => {
      expect(SETTINGS_SECTION_ROUTES.environment).toBe(
        'app://settings/environment',
      );
      expect(routeForSettingsSection('environment')).toBe(
        'app://settings/environment',
      );
      expect(
        POSTHOG_ROUTES.has('app://settings/environment' as PostHogRoute),
      ).toBe(true);
    });

    it('gives every Settings section a route', () => {
      for (const route of Object.values(SETTINGS_SECTION_ROUTES)) {
        expect(route).not.toBeNull();
      }
    });

    it('deliberately gives a focused chat panel no route of its own', () => {
      // A focused chat panel retains the containing worktree/Co-Work route.
      expect(PANEL_KIND_ROUTES.chat).toBeNull();
      expect(routeForPanelKind('chat')).toBeNull();
      expect(POSTHOG_ROUTES.has('app://panel/chat' as PostHogRoute)).toBe(
        false,
      );
    });

    it('has no pipeline-advisor key: it is a LegacySettingsSection', () => {
      // `resolveSettingsSection` migrates it to `app-advisor` before any value
      // can reach the record, so an entry here would be dead weight.
      expect(Object.keys(SETTINGS_SECTION_ROUTES)).not.toContain(
        'pipeline-advisor',
      );
      expect(
        POSTHOG_ROUTES.has('app://settings/pipeline-advisor' as PostHogRoute),
      ).toBe(false);
    });

    it('keeps the reachable feedback section in the catalog', () => {
      expect(SETTINGS_SECTION_ROUTES.feedback).toBe('app://settings/feedback');
      expect(routeForSettingsSection('feedback')).toBe(
        'app://settings/feedback',
      );
    });
  });

  describe('mapping', () => {
    it('matches the named-routes contract table', () => {
      expect(POSTHOG_MAIN_ROUTE).toBe('app://main');
      expect(NAVIGATION_PAGE_ROUTES.main).toBe('app://main');
      expect(NAVIGATION_PAGE_ROUTES.home).toBe('app://main/home');
      expect(POSTHOG_WORKTREE_CHAT_ROUTE).toBe('app://main/worktree-chat');
      expect(NAVIGATION_PAGE_ROUTES.chat).toBe('app://main/chat');
      expect(NAVIGATION_PAGE_ROUTES.pipelines).toBe('app://main/pipelines');
      expect(NAVIGATION_PAGE_ROUTES.plugins).toBe('app://main/plugins');
      expect(SETTINGS_SECTION_ROUTES.display).toBe('app://settings/display');
      expect(SETTINGS_SECTION_ROUTES.account).toBe('app://settings/account');
      expect(POSTHOG_SETTINGS_ROUTE).toBe('app://settings');
      expect(PANEL_KIND_ROUTES.terminal).toBe('app://panel/terminal');
      expect(PANEL_KIND_ROUTES.browser).toBe('app://panel/browser');
      expect(POSTHOG_APP_ADVISOR_ROUTE).toBe('app://app-advisor');
    });

    it('maps remaining navigation pages to app://main/<page>', () => {
      expect(NAVIGATION_PAGE_ROUTES['mcp-account-connections']).toBe(
        'app://main/mcp-account-connections',
      );
      expect(NAVIGATION_PAGE_ROUTES.environments).toBe(
        'app://main/environments',
      );
      expect(NAVIGATION_PAGE_ROUTES.kanban).toBe('app://main/kanban');
      expect(NAVIGATION_PAGE_ROUTES.feed).toBe('app://main/feed');
      expect(NAVIGATION_PAGE_ROUTES['message-bubble-states']).toBe(
        'app://main/message-bubble-states',
      );
      expect(NAVIGATION_PAGE_ROUTES['notice-states']).toBe(
        'app://main/notice-states',
      );
    });

    it('maps settings sections to app://settings/<suffix>', () => {
      expect(routeForSettingsSection('code-graph')).toBe(
        'app://settings/code-graph',
      );
      expect(SETTINGS_SECTION_ROUTES.canopy).toBe('app://settings/canopy');
      expect(SETTINGS_SECTION_ROUTES['app-advisor']).toBe(
        'app://settings/app-advisor',
      );
      expect(SETTINGS_SECTION_ROUTES['plan-detection']).toBe(
        'app://settings/plan-detection',
      );
      expect(SETTINGS_SECTION_ROUTES.legal).toBe('app://settings/legal');
    });

    it('maps non-chat panel kinds to app://panel/<kind>', () => {
      expect(PANEL_KIND_ROUTES['file-diff']).toBe('app://panel/file-diff');
      expect(PANEL_KIND_ROUTES['activity-section']).toBe(
        'app://panel/activity-section',
      );
      expect(PANEL_KIND_ROUTES['file-explorer']).toBe(
        'app://panel/file-explorer',
      );
      expect(PANEL_KIND_ROUTES['change-diagram']).toBe(
        'app://panel/change-diagram',
      );
      expect(PANEL_KIND_ROUTES['activity-card']).toBe(
        'app://panel/activity-card',
      );
      expect(PANEL_KIND_ROUTES.usage).toBe('app://panel/usage');
      expect(PANEL_KIND_ROUTES.automations).toBe('app://panel/automations');
      expect(PANEL_KIND_ROUTES['pipeline-execution']).toBe(
        'app://panel/pipeline-execution',
      );
      expect(PANEL_KIND_ROUTES.plan).toBe('app://panel/plan');
      expect(PANEL_KIND_ROUTES['plan-diagram']).toBe(
        'app://panel/plan-diagram',
      );
      expect(PANEL_KIND_ROUTES['chat-visuals']).toBe(
        'app://panel/chat-visuals',
      );
      expect(PANEL_KIND_ROUTES.subagents).toBe('app://panel/subagents');
      expect(PANEL_KIND_ROUTES['subagent-chat']).toBe(
        'app://panel/subagent-chat',
      );
      expect(PANEL_KIND_ROUTES.ledger).toBe('app://panel/ledger');
    });

    it('generates exactly the frozen route set', () => {
      expect(sortedRoutes()).toEqual([...EXPECTED_ROUTES]);
      expect(POSTHOG_ROUTES.size).toBe(EXPECTED_ROUTES.length);
    });

    it('resolves lookup helpers without re-deriving the mapping', () => {
      expect(routeForNavigationPage('home')).toBe('app://main/home');
      expect(routeForNavigationPage('main')).toBe('app://main');
      expect(routeForSettingsSection('privacy')).toBe('app://settings/privacy');
      expect(routeForPanelKind('browser')).toBe('app://panel/browser');
    });

    it('keeps the lookup helpers total against prototype-chain keys', () => {
      // A hostile or buggy caller must never leak `Object.prototype` members.
      const hostile = [
        'constructor',
        'toString',
        '__proto__',
        'hasOwnProperty',
      ];
      for (const key of hostile) {
        expect(
          routeForNavigationPage(
            key as Parameters<typeof routeForNavigationPage>[0],
          ),
        ).toBe('app://main');
        expect(
          routeForSettingsSection(
            key as Parameters<typeof routeForSettingsSection>[0],
          ),
        ).toBeNull();
        expect(
          routeForPanelKind(key as Parameters<typeof routeForPanelKind>[0]),
        ).toBeNull();
      }
    });
  });

  describe('hosted settings pages (CAN-4386)', () => {
    const ORGANIZATION_ID = 'a0000000-0000-4000-8000-000000000002';

    it('reports scope and page without identifiers or query values', () => {
      expect(
        routeForHostedSettingsRoute({
          scope: 'account',
          page: 'billing',
          invoiceId: 'in_secret123',
        }),
      ).toBe('app://settings/account/billing');
      expect(routeForHostedSettingsRoute({ scope: 'organizations' })).toBe(
        'app://settings/organizations/list',
      );
      const memberDigest = routeForHostedSettingsRoute({
        scope: 'organization',
        organizationId: ORGANIZATION_ID,
        page: 'members',
        userId: 'user-1',
        digestId: 'digest-1',
      });
      expect(memberDigest).toBe('app://settings/organization/members');
      const billing = routeForHostedSettingsRoute({
        scope: 'organization',
        organizationId: ORGANIZATION_ID,
        page: 'settings',
        subtab: 'billing',
      });
      expect(billing).toBe('app://settings/organization/settings');
      for (const route of Object.values(HOSTED_SETTINGS_PAGE_ROUTES)) {
        expect(route).not.toContain(ORGANIZATION_ID);
        expect(isPostHogRoute(route)).toBe(true);
      }
    });

    it('keeps hosted Account apart from the local Accounts section', () => {
      expect(
        routeForHostedSettingsRoute({ scope: 'account', page: 'account' }),
      ).toBe('app://settings/account/account');
      expect(routeForSettingsSection('account')).toBe('app://settings/account');
    });

    it('keys every hosted page by scope and page', () => {
      expect(
        hostedSettingsPageKey({
          scope: 'organization',
          organizationId: ORGANIZATION_ID,
          page: 'memory',
          factId: 'fact-1',
        }),
      ).toBe('organization/memory');
      expect(Object.isFrozen(HOSTED_SETTINGS_PAGE_ROUTES)).toBe(true);
    });
  });

  describe('path-free invariant', () => {
    it('contains no user-controlled names, paths, queries, or fragments', () => {
      // At most two fixed segments: hosted settings pages are
      // `app://settings/<scope>/<page>`.
      const SAFE_ROUTE = /^app:\/\/[a-z-]+(\/[a-z0-9-]+){0,2}$/;
      for (const route of POSTHOG_ROUTE_VALUES) {
        expect(route).toMatch(SAFE_ROUTE);
        expect(route).not.toMatch(/[.%?#\s]/);
        expect(route).not.toMatch(/[A-Z]/);
      }
    });
  });

  describe('validator', () => {
    it('accepts every catalog member', () => {
      expect(POSTHOG_ROUTES.size).toBe(POSTHOG_ROUTE_VALUES.length);
      for (const route of POSTHOG_ROUTE_VALUES) {
        expect(isPostHogRoute(route)).toBe(true);
        expect(toPostHogRoute(route)).toBe(route);
      }
    });

    it('rejects adversarial and near-miss input', () => {
      const userWorkspaceName = 'acme-secret-project';
      const hostile: unknown[] = [
        'app://main/../etc/passwd',
        'app://main/home?x=1',
        'app://main/home#frag',
        'app://main/home/',
        'app://MAIN/home',
        'app://main/home%2F..',
        'app://main/home extra',
        'http://main/home',
        'app://',
        `app://main/${userWorkspaceName}`,
        'app://main/home\n',
        ' app://main/home',
        'app://panel/chat',
        '',
        null,
        undefined,
        0,
        1,
        Number.NaN,
        true,
        false,
        {},
        { toString: (): string => 'app://main' },
        [],
        ['app://main'],
        new String('app://main'),
        Symbol('app://main'),
        (): string => 'app://main',
      ];
      for (const value of hostile) {
        expect(isPostHogRoute(value)).toBe(false);
        expect(toPostHogRoute(value)).toBeNull();
      }
    });

    it('is total and idempotent', () => {
      const inputs: unknown[] = [
        ...POSTHOG_ROUTE_VALUES,
        'app://main/../etc/passwd',
        'app://main/home?x=1',
        '',
        null,
        undefined,
        42,
        {},
        [],
        new String('app://main'),
      ];
      for (const value of inputs) {
        expect(() => toPostHogRoute(value)).not.toThrow();
        const once = toPostHogRoute(value);
        expect(toPostHogRoute(once)).toBe(once);
      }
    });
  });

  describe('redaction survival', () => {
    it('passes every catalog route through redactText byte-identically', () => {
      for (const route of POSTHOG_ROUTE_VALUES) {
        expect(redactText(route)).toBe(route);
      }
    });
  });

  describe('wire property keys', () => {
    it('pins the property and event names', () => {
      expect(POSTHOG_SCREEN_ROUTE_PROPERTY).toBe('screen_route');
      expect(POSTHOG_CURRENT_URL_PROPERTY).toBe('$current_url');
      expect(POSTHOG_PAGEVIEW_EVENT).toBe('$pageview');
      expect(POSTHOG_PAGELEAVE_EVENT).toBe('$pageleave');
    });

    it('serializes a route onto both keys with the same value', () => {
      expect(buildPostHogRouteProperties('app://main/home')).toEqual({
        screen_route: 'app://main/home',
        $current_url: 'app://main/home',
      });
    });
  });

  describe('type-level guard', () => {
    it('rejects a non-catalog literal at compile time', () => {
      // @ts-expect-error — the closed union must not admit arbitrary app:// strings.
      const invalid: PostHogRoute = 'app://main/not-a-real-screen';
      expect(isPostHogRoute(invalid)).toBe(false);
    });

    it('rejects an incomplete record at compile time', () => {
      // Dropping any union member from a catalog record must fail to satisfy
      // its `Record<...>` constraint — the same check `posthog-routes.ts`
      // relies on for exhaustiveness.
      // @ts-expect-error — `kanban` (and every other NavigationPage) is required.
      const incomplete: Record<NavigationPage, PostHogRoute> = {
        main: 'app://main',
      };
      expect(incomplete.main).toBe('app://main');
    });
  });
});
