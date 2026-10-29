// ---------------------------------------------------------------------------
// Shared card-display formatting for the billing surfaces.
//
// Both the account-page billing section (CAN-1035) and the org Billing tab
// (CAN-1036) render the same default-card affordance, so the label/expiry
// formatting lives here to keep the two surfaces visually consistent instead
// of drifting apart. Pure, browser-safe string helpers — no Stripe, DOM, or
// server imports.
// ---------------------------------------------------------------------------

/** Title-case a lowercase Stripe card brand (e.g. `visa` -> `Visa`). */
export function formatCardBrand(brand: string): string {
  if (brand.length === 0) return brand;
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** `mm/yyyy` card expiry display. */
export function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${year}`;
}

/** `Visa ····4242` style card label. */
export function formatCardLabel(brand: string, last4: string): string {
  return `${formatCardBrand(brand)} ····${last4}`;
}
