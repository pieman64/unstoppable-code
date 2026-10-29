import {
  isCanopyOrganizationRole,
  type CanopyOrganizationSummary,
} from '@canopy/protocol/pipelines';
import { isRecord } from '../lib/type-guards';
import { isDisplayableLogoUrl } from './organization-summary';

function isCanonicalRequiredString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

export function parseAuthoritativeOrganizationSnapshot(
  value: unknown,
): CanopyOrganizationSummary[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const organizations: CanopyOrganizationSummary[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isCanonicalRequiredString(entry.id) ||
      !isCanonicalRequiredString(entry.name) ||
      !isCanonicalRequiredString(entry.createdAt) ||
      !isCanonicalRequiredString(entry.updatedAt) ||
      ids.has(entry.id)
    ) {
      return null;
    }
    ids.add(entry.id);
    organizations.push({
      id: entry.id,
      name: entry.name,
      // An unknown role must not make the snapshot non-authoritative: the
      // membership list is still exact, only the role vocabulary drifted.
      ...(isCanopyOrganizationRole(entry.role) ? { role: entry.role } : {}),
      // The switcher's branding logo (CAN-3522); a bad URL is dropped, never
      // fatal to the membership snapshot.
      ...(isDisplayableLogoUrl(entry.logoUrl)
        ? { logoUrl: entry.logoUrl }
        : {}),
      // Optional policy detail; a missing or malformed value reads as off and
      // never makes the membership snapshot non-authoritative.
      ...(typeof entry.allowExternalContainerSharing === 'boolean'
        ? { allowExternalContainerSharing: entry.allowExternalContainerSharing }
        : {}),
      ...(typeof entry.automaticPersonalProjectConversionExcluded === 'boolean'
        ? {
            automaticPersonalProjectConversionExcluded:
              entry.automaticPersonalProjectConversionExcluded,
          }
        : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }
  return organizations;
}
