import type { ProfileRoleId } from '@canopy/desktop-shared/types';
import { PROFILE_ROLE_OPTIONS } from '@canopy/protocol/plugin-catalog';

export interface ProfileOption<Id extends string> {
  id: Id;
  label: string;
}

/**
 * Role labels now live beside the ids in `@canopy/protocol`
 * (`PROFILE_ROLE_LABELS`), because hub-web's admin UI must render the same
 * names when targeting curated plugins and cannot import this renderer. They
 * are fixed product vocabulary, the same category as `ui-labels.ts`.
 *
 * The `Record` type there makes a missing label a compile error, so this list
 * can never fall behind `PROFILE_ROLES`.
 */
export const ROLE_OPTIONS: readonly ProfileOption<ProfileRoleId>[] =
  PROFILE_ROLE_OPTIONS;
