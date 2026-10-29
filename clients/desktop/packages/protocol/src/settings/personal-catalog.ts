import type { PersonalCatalogProject } from './account';

export type { PersonalCatalogProject } from './account';

/**
 * Narrow one row of the desktop-synced Personal project list
 * (`GET /api/account/projects/personal`), including a parseable `updatedAt`.
 */
export function isPersonalCatalogProject(
  value: unknown,
): value is PersonalCatalogProject {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'kind' in value &&
    (value.kind === 'CODE' || value.kind === 'COWORK') &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    'online' in value &&
    typeof value.online === 'boolean'
  );
}
