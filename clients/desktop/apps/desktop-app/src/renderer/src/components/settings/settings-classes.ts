/**
 * Class strings shared by the settings kit (`SettingsLayout.tsx`) and the few
 * settings controls that render their own element with the kit's look.
 */

/**
 * Native checkbox and radio marks in the theme accent at one size. Without
 * `accent-accent` the platform paints them in the system blue, which clashes
 * with every non-blue theme.
 */
export const SETTINGS_CHECK_INPUT_CLASS_NAME =
  'size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50';
