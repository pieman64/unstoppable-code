import { useEffect, useState } from 'react';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';

/** Saved roles, preferring the multi-role list over the legacy single role. */
export function savedProfileRoles(
  prefs: Pick<PreferencesData, 'profileRoles' | 'profileRole'>,
): readonly ProfileRoleId[] | null {
  if (prefs.profileRoles?.length) return prefs.profileRoles;
  return prefs.profileRole ? [prefs.profileRole] : null;
}

function sameRoles(
  a: readonly ProfileRoleId[] | null | undefined,
  b: readonly ProfileRoleId[] | null,
): boolean {
  if (a === b) return true;
  if (a === undefined || a === null || b === null || a.length !== b.length) {
    return false;
  }
  return a.every((role, index) => role === b[index]);
}

/**
 * The user's saved work roles, kept current across Settings edits and cloud
 * preference sync. `undefined` means the initial read is unresolved; `null`
 * means the read confirmed no saved role. Sync broadcasts can arrive out of
 * order, so each one triggers a canonical re-read and only the newest read is
 * applied.
 */
export function useSavedProfileRoles():
  | readonly ProfileRoleId[]
  | null
  | undefined {
  const [roles, setRoles] = useState<
    readonly ProfileRoleId[] | null | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    let readVersion = 0;
    const read = (): void => {
      const version = ++readVersion;
      void window.api
        .loadPreferences()
        .then((prefs) => {
          if (cancelled || version !== readVersion || prefs.__error) return;
          const next = savedProfileRoles(prefs);
          setRoles((previous) => (sameRoles(previous, next) ? previous : next));
        })
        .catch(() => {
          // Keep the last confirmed roles until another read succeeds.
        });
    };
    const unsubscribe = window.api.onPreferencesSynced?.(() => read());
    read();
    return (): void => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return roles;
}
