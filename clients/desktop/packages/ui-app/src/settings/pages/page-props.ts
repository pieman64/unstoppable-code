import type {
  SettingsPageData,
  SettingsPageDataKind,
  SettingsRoute,
} from '@canopy/protocol/settings';

/** The page-data member for one kind. */
export type SettingsPageDataFor<K extends SettingsPageDataKind> = Extract<
  SettingsPageData,
  { kind: K }
>;

/**
 * Props of a shared settings page: the validated route and the first-screen
 * data its web server loader (or `settings.pageData`) produced. Web route
 * files render these components with server-loaded data; desktop renders the
 * same components with data from the shared settings store.
 */
export interface SettingsPageProps<K extends SettingsPageDataKind> {
  readonly route: SettingsRoute;
  readonly page: SettingsPageDataFor<K>;
}
