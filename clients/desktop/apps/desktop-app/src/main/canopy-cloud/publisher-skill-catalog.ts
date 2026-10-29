import type { PublisherSkillSummary } from '@canopy/protocol';
import { CanopyCloudClientError, requestCanopyCloudPublicJson } from './client';

/** Public metadata only. Snapshot and package reads remain explicit actions. */
export async function listPublisherSkills(): Promise<PublisherSkillSummary[]> {
  const value = await requestCanopyCloudPublicJson<unknown>(
    '/api/v1/marketplace/skills',
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('skills' in value) ||
    !Array.isArray(value.skills)
  ) {
    throw new CanopyCloudClientError(
      'invalid-response',
      'Invalid publisher skill catalog.',
    );
  }
  const seen = new Set<string>();
  return value.skills.map((row: unknown): PublisherSkillSummary => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('externalId' in row) ||
      typeof row.externalId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        row.externalId,
      ) ||
      !('name' in row) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      !('description' in row) ||
      typeof row.description !== 'string' ||
      !('publisher' in row) ||
      typeof row.publisher !== 'string' ||
      !row.publisher.trim() ||
      seen.has(row.externalId.toLowerCase())
    ) {
      throw new CanopyCloudClientError(
        'invalid-response',
        'Invalid publisher skill catalog.',
      );
    }
    const externalId = row.externalId.toLowerCase();
    seen.add(externalId);
    return {
      externalId,
      name: row.name,
      description: row.description,
      publisher: row.publisher,
    };
  });
}
