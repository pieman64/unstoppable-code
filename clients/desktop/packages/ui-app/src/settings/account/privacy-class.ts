/**
 * Append a replay-privacy class (`useSettingsPrivacy().blockClassName`) to an
 * element's classes. The class is empty on hosts that record no replay, so
 * the markup there keeps exactly its previous class list.
 */
export function withPrivacyClass(
  className: string,
  privacyClassName: string,
): string {
  if (privacyClassName === '') return className;
  return className === ''
    ? privacyClassName
    : `${className} ${privacyClassName}`;
}
