import type { DesktopPublisherSkill } from '@canopy/desktop-shared/types/skills';
import { listPublisherSkills } from '../canopy-cloud/publisher-skill-catalog';
import { listCapabilityPackageInstalls } from '../pipelines/pipeline-package-install-store';
import { getPipelinePackageInstallStorePath } from '../lib/paths';
import { loadSkills } from './skill-service';
import { filterStoredSkillContexts } from './skill-install-context';

/** Read-only projection; package installation retains its existing writer. */
export async function listDesktopPublisherSkills(): Promise<
  DesktopPublisherSkill[]
> {
  const rows = await listPublisherSkills();
  if (rows.length === 0) return rows;
  try {
    const records = await listCapabilityPackageInstalls(
      getPipelinePackageInstallStorePath(),
    );
    const local = loadSkills();
    const visible =
      local.success && local.data
        ? await filterStoredSkillContexts(local.data)
        : [];
    const names = new Set(
      visible
        .filter((skill) => skill.sourceId === 'custom:app')
        .map((skill) => skill.name),
    );
    return rows.map((row) => {
      const record = records.find(
        (candidate) =>
          candidate.owner.kind === 'skill' &&
          names.has(candidate.owner.localId) &&
          candidate.originExternalId === row.externalId &&
          candidate.distributionMode !== 'definition_only',
      );
      return record?.owner.kind === 'skill'
        ? {
            ...row,
            installedSkillName: record.owner.localId,
            installedPackageDigest: record.packageDigest,
          }
        : row;
    });
  } catch {
    // A local inventory failure must not hide public discovery. Details still
    // resolve/detect the chosen skill through the existing install controller.
    return rows;
  }
}
