import { z } from 'zod';
import { settingsRouteSchema, type SettingsRoute } from './routes';
import {
  accountPageDataKindForRoute,
  accountPageDataSchema,
  type AccountPageData,
  type AccountPageDataKind,
} from './page-data-account';
import {
  organizationPageDataKindForRoute,
  organizationPageDataSchema,
  type OrganizationPageData,
  type OrganizationPageDataKind,
} from './page-data-organization';

/**
 * Input for `settings.pageData`: the validated route whose first-screen data
 * the route's web server loader produces.
 */
export const settingsPageDataInputSchema = z.strictObject({
  route: settingsRouteSchema,
});

export type SettingsPageDataInput = z.infer<typeof settingsPageDataInputSchema>;

/**
 * First-screen data for one route, exactly as the route's web server loader
 * produces it, discriminated by `kind`.
 */
export const settingsPageDataSchema = z.union([
  accountPageDataSchema,
  organizationPageDataSchema,
]);

export type SettingsPageData = AccountPageData | OrganizationPageData;

export type SettingsPageDataKind =
  | AccountPageDataKind
  | OrganizationPageDataKind;

/** The page-data kind a validated route loads. */
export function settingsPageDataKindForRoute(
  route: SettingsRoute,
): SettingsPageDataKind {
  return route.scope === 'account'
    ? (accountPageDataKindForRoute(route) ?? 'account.account')
    : organizationPageDataKindForRoute(route);
}
