/**
 * Shared button styling for the Remote Control modal's inline CTAs.
 *
 * Deliberately NOT `ACCOUNT_BUTTON_PRIMARY` from `lib/account-button-styles`:
 * that constant is "primary" only within the account-settings tiles, where its
 * job is to outrank a quiet outline Disconnect. It is a bordered `bg-secondary`
 * fill, and in this modal — where every other primary action (Sign in / Enable /
 * Reconnect / View Web Portal) is an accent fill — it reads as a secondary
 * control. Both inline CTAs here are the single action of the state they appear
 * in, so they have to carry the modal's real primary weight.
 *
 * The class list matches those buttons in `CanopyPortalModal` exactly. If the
 * modal's primary styling changes, change it here too.
 */
export const MODAL_BUTTON_PRIMARY =
  'rounded-lg bg-accent px-3 py-1.5 text-s font-semibold fg-emphasis hover:bg-accent/90 transition-colors focus-ring';
