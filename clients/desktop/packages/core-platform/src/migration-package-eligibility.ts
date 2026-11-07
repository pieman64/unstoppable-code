/** A successful reporting check is not positive migration eligibility. */
export function isMigrationRolePackageEligible(report: unknown): boolean {
  if (typeof report !== 'object' || report === null) return false;
  const fields = Object.getOwnPropertyDescriptors(report);
  const disabled: unknown = fields.disabledReasons?.value;
  const violations: unknown = fields.violations?.value;
  return (
    fields.migrationRole?.value === 'eligible' &&
    Array.isArray(disabled) &&
    disabled.length === 0 &&
    Array.isArray(violations) &&
    violations.length === 0
  );
}
