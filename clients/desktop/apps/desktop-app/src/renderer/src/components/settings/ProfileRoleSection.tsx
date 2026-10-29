import {
  Fragment,
  type JSX,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  PreferencesData,
  ProfileRoleId,
} from '@canopy/desktop-shared/types';
import { Button } from '@canopy/ui-shared/components';
import { CheckIcon } from '@canopy/ui-shared/icons/AppIcons';
import { expandLegacyProfileRoles } from '@canopy/protocol/plugin-catalog';
import { DialogModal } from '@/components/shared/DialogModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ROLE_OPTIONS } from '@/lib/onboarding/profile-options';
import { clearOnboardingProfileRolesDurably } from '@/components/home/onboarding-suggestions/completionWriter';
import { SettingsDescriptionLoading, SettingsRow } from './SettingsLayout';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

const ROLE_DETAIL_MAX_LENGTH = 256;

/** Older profiles have only `profileRole`; the checklist saves the full list. */
function rolesFromPreferences(preferences: PreferencesData): ProfileRoleId[] {
  return expandLegacyProfileRoles(
    preferences.profileRoles?.length
      ? preferences.profileRoles
      : preferences.profileRole
        ? [preferences.profileRole]
        : [],
  );
}

/** Match the checklist's primary-role rule: first selected in option order. */
function primaryRole(roles: readonly ProfileRoleId[]): ProfileRoleId | null {
  return ROLE_OPTIONS.find((option) => roles.includes(option.id))?.id ?? null;
}

/**
 * Settings shows the complete checklist selection. Changes are staged in a
 * modal so dismissing it cannot accidentally replace the saved role list.
 */
export function ProfileRoleSection(): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const [roles, setRoles] = useState<ProfileRoleId[]>([]);
  const [detail, setDetail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftRoles, setDraftRoles] = useState<ProfileRoleId[]>([]);
  const [draftDetail, setDraftDetail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // The initial read and cross-window broadcasts can arrive after a local
  // save. During that save, its drafted selection remains authoritative.
  const inFlightSavesRef = useRef(0);
  const syncedRef = useRef(false);

  const applyPreferences = useCallback((preferences: PreferencesData): void => {
    setRoles(rolesFromPreferences(preferences));
    setDetail(preferences.profileRoleDetail ?? '');
    setLoaded(true);
    setLoadError(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled || syncedRef.current || inFlightSavesRef.current > 0)
          return;
        applyPreferences(preferences);
      })
      .catch(() => {
        if (!cancelled && !syncedRef.current) setLoadError(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyPreferences]);

  useEffect(() => {
    if (typeof window.api.onPreferencesSynced !== 'function') return undefined;
    return window.api.onPreferencesSynced((preferences) => {
      syncedRef.current = true;
      if (inFlightSavesRef.current > 0) return;
      applyPreferences(preferences);
      // Do not rewrite an open draft; Save and Cancel retain their ordinary
      // meaning even if onboarding is replayed in another window.
    });
  }, [applyPreferences]);

  const openEditor = (): void => {
    if (!loaded) return;
    setDraftRoles([...roles]);
    setDraftDetail(detail);
    setSaveError(false);
    setEditing(true);
  };

  const closeEditor = (): void => {
    if (!saving) setEditing(false);
  };

  const toggleRole = (role: ProfileRoleId): void => {
    setDraftRoles((current) =>
      current.includes(role)
        ? current.filter((entry) => entry !== role)
        : [...current, role],
    );
    setSaveError(false);
  };

  const saveRoles = async (): Promise<void> => {
    if (saving) return;
    const nextRoles = [...draftRoles];
    const nextDetail = nextRoles.length > 0 ? draftDetail : '';
    const primary = primaryRole(nextRoles);

    setSaving(true);
    setSaveError(false);
    inFlightSavesRef.current += 1;
    try {
      if (nextRoles.length === 0) {
        await clearOnboardingProfileRolesDurably();
      } else {
        await window.api.savePreferences({
          profileRole: primary ?? undefined,
          profileRoles: nextRoles,
          profileRoleDetail: nextDetail,
        });
      }
      setRoles(nextRoles);
      setDetail(nextDetail.trim());
      setEditing(false);
    } catch {
      setSaveError(true);
    } finally {
      inFlightSavesRef.current -= 1;
      setSaving(false);
    }
  };

  useCurrentUiStateReporter('settings.profileRole', {
    loaded,
    role: primaryRole(roles),
  });

  return (
    <SettingsRow
      label="Role"
      labelId="settings-profile-role-heading"
      dataTestId="settings-profile-role"
      description={
        loadError ? (
          <span className="fg-destructive">Could not load your roles.</span>
        ) : !loaded ? (
          <SettingsDescriptionLoading dataTestId="settings-profile-role-loading" />
        ) : roles.length > 0 ? (
          <>
            <span data-testid="settings-profile-role-tiles">
              {roles.map((role, index) => (
                <Fragment key={role}>
                  {index > 0 ? ', ' : null}
                  <span data-testid={`settings-profile-role-tile-${role}`}>
                    {ROLE_OPTIONS.find((option) => option.id === role)?.label}
                  </span>
                </Fragment>
              ))}
            </span>
            {detail ? (
              <span
                className="block"
                data-testid="settings-profile-role-detail"
              >
                {detail}
              </span>
            ) : null}
          </>
        ) : (
          'What kind of work do you do?'
        )
      }
      control={
        loaded && !loadError ? (
          <Button
            ref={editButtonRef}
            size={settingsButtonSize}
            onClick={openEditor}
            data-testid="settings-profile-role-edit"
          >
            Edit
          </Button>
        ) : null
      }
    >
      {editing ? (
        <DialogModal
          onClose={closeEditor}
          title="What kind of work do you do?"
          subtitle="Select all that apply."
          maxWidth="sm"
          dataTestId="settings-profile-role-modal"
          trapFocus
          restoreFocusRef={editButtonRef}
          closeOnBackdrop={!saving}
        >
          <div
            className="flex flex-wrap gap-2 p-5"
            data-testid="settings-profile-role-options"
          >
            {ROLE_OPTIONS.map((option) => {
              const selected = draftRoles.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={(): void => toggleRole(option.id)}
                  disabled={saving}
                  data-testid={`settings-profile-role-option-${option.id}`}
                  className={`focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-s ring-1 ring-inset transition-colors disabled:opacity-50 ${
                    selected
                      ? 'ring-line-accent bg-accent-subtle font-medium fg-primary hover:bg-accent-subtle/80'
                      : 'ring-line-base bg-secondary fg-secondary hover:bg-subtle hover:fg-primary'
                  }`}
                >
                  {selected ? (
                    <CheckIcon size={12} className="shrink-0 fg-accent" />
                  ) : null}
                  {option.label}
                </button>
              );
            })}
          </div>
          <div className="px-5 pb-5">
            <label
              htmlFor="settings-profile-role-detail-input"
              className="mb-1 block text-s fg-secondary"
            >
              Tell us more about what you do (optional)
            </label>
            <input
              id="settings-profile-role-detail-input"
              type="text"
              value={draftDetail}
              onChange={(event): void => setDraftDetail(event.target.value)}
              maxLength={ROLE_DETAIL_MAX_LENGTH}
              data-testid="settings-profile-role-detail-input"
              placeholder="Role, responsibilities, or goals"
              disabled={saving}
              className="focus-ring w-full rounded-md border bg-base px-3 py-2 text-s fg-primary"
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
            {saveError ? (
              <p role="alert" className="mr-auto text-s fg-destructive">
                Could not save your roles. Please try again.
              </p>
            ) : null}
            <Button
              size={settingsButtonSize}
              variant="ghost"
              onClick={closeEditor}
              disabled={saving}
              data-testid="settings-profile-role-cancel"
            >
              Cancel
            </Button>
            <Button
              size={settingsButtonSize}
              variant="primary"
              onClick={(): void => {
                void saveRoles();
              }}
              disabled={saving}
              data-testid="settings-profile-role-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogModal>
      ) : null}
    </SettingsRow>
  );
}
