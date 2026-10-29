import {
  isCanopyOrganizationRole,
  type CanopyOrganizationSummary,
} from '@canopy/protocol/pipelines';
import { isRecord } from '../lib/type-guards';

/**
 * An organization branding logo the renderer may load: an absolute http(s)
 * URL only, never a local or script scheme from the wire (CAN-3522).
 */
export function isDisplayableLogoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Normalize one organization summary from an untrusted wire or stored value.
 * Returns `null` when a required field is missing or mistyped. Unknown fields
 * are stripped. A `role` is kept only when it is a known
 * {@link CanopyOrganizationRole}; an unknown role is dropped rather than
 * failing the entry, because an older or newer server disagreeing on the
 * vocabulary must not hide the organization itself (consumers treat an absent
 * role as MEMBER).
 */
export function normalizeCanopyOrganizationSummary(
  value: unknown,
): CanopyOrganizationSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    ...(isCanopyOrganizationRole(value.role) ? { role: value.role } : {}),
    // The branding logo the scope switcher shows, as on the web portal
    // (CAN-3522). Only an absolute http(s) URL is kept, so the renderer never
    // loads a local or script scheme from the wire.
    ...(isDisplayableLogoUrl(value.logoUrl) ? { logoUrl: value.logoUrl } : {}),
    // Decides whether the shared-container invite modal can offer Public for
    // an organization-owned container. Absent (older servers) reads as off.
    ...(typeof value.allowExternalContainerSharing === 'boolean'
      ? { allowExternalContainerSharing: value.allowExternalContainerSharing }
      : {}),
    ...(typeof value.automaticPersonalProjectConversionExcluded === 'boolean'
      ? {
          automaticPersonalProjectConversionExcluded:
            value.automaticPersonalProjectConversionExcluded,
        }
      : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** List form of {@link normalizeCanopyOrganizationSummary}; drops bad entries. */
export function normalizeCanopyOrganizationSummaries(
  value: unknown,
): CanopyOrganizationSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeCanopyOrganizationSummary)
    .filter((entry): entry is CanopyOrganizationSummary => entry !== null);
}
