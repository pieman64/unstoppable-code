import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
// ---------------------------------------------------------------------------
// Shared skill import helper.
//
// Persists a `SharedSkillDetail` as a local custom skill via the raw write
// preload API so the on-disk SKILL.md bytes match the server-stored content
// exactly. Resolves a few collision scenarios:
//
//   - If a local custom skill with the identical `contentHash` already exists,
//     the helper returns that skill's id/name unchanged. This is how
//     Collection import deduplicates linked custom skills (the resolver passes
//     each `SharedSkillDetail` through here and expects a stable local id
//     back).
//
//   - If a different local custom skill already owns the same name, the
//     server-recommended suffix scheme (`<name>-2`, `<name>-3`, …) picks the
//     first non-colliding alternative. We never overwrite an existing local
//     skill silently.
// ---------------------------------------------------------------------------

import { extractIpcErrorMessage } from './errors';
import type {
  InstallSkillCapabilityPackageResult,
  PublicShareSkillOrigin,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';

/**
 * The subset of `SharedSkillDetail` the import actually reads. Widened so
 * snapshot-shaped callers (e.g. the deep-link public-share landing, which
 * only has the pinned name/raw/hash) can import without fabricating a full
 * detail object.
 */
export type SharedSkillImportSource = Pick<
  SharedSkillDetail,
  'name' | 'rawSkill' | 'contentHash'
> & {
  /**
   * Set when the share carries supporting files. `id` is the remote id the
   * package is fetched from, which for a public-share import is the share's
   * external id rather than the skill's.
   */
  id?: string;
  sourceRemoteId?: string;
  package?: SharedSkillDetail['package'];
  distributionMode?: SharedSkillDetail['distributionMode'];
  /**
   * True when `id` addresses a public share rather than an owned skill.
   * Deliberately not named `publicShare`: `SharedSkillDetail` already has a
   * field by that name holding the share's metadata object, and reusing it
   * here would make a detail assignable only by accident.
   */
  fromPublicShare?: boolean;
  /**
   * The Public collection snapshot that pins this skill. Such a skill has no
   * standalone share, so main verifies it against this collection instead.
   */
  publicCollection?: PublicShareSkillOrigin['collection'];
  /**
   * Imported as a member of a team or organization collection, whose own
   * update-email subscription covers it.
   */
  inCollection?: boolean;
};

/**
 * The only source id shared-skill imports ever write to. Exported so callers
 * (e.g. the deep-link landing) reference the same literal instead of keeping
 * private copies.
 */
export const CUSTOM_SKILL_SOURCE_ID = 'custom:app';

export interface LocalImportedSkill {
  /** Local skill id used by `readContent` / `removeSkill`. */
  skillId: string;
  /** Local custom-skill name as it appears in the Skills tab. */
  skillName: string;
  /**
   * `true` when the import found an existing identical local skill instead
   * of writing a new file. Surfaced for tests and for the import progress
   * UI; callers can ignore it during normal happy-path.
   */
  reused: boolean;
  /**
   * What the share's capability package added beyond SKILL.md, when it had
   * one. Absent for a definition-only share, which is every share published
   * before packaging existed.
   */
  packageInstall?: InstallSkillCapabilityPackageResult;
  /**
   * Why the share's supporting files could not be installed, when it carried
   * a package and the install failed. The skill itself still landed — this is
   * a partial-success signal, not an error result.
   */
  packageInstallError?: string;
}

const MAX_SUFFIX_ATTEMPTS = 100;

/**
 * Persist `detail.rawSkill` verbatim to the local custom-skill source.
 *
 * On name collision the helper retries with a numeric suffix
 * (`<name>-2`, `<name>-3`, …). On `contentHash` collision (computed by the
 * server before responding) the helper short-circuits and returns the
 * already-installed local skill so Collection import does not fork the link.
 *
 * `writeRawSkill` reports the resulting id/name and writes the exact bytes;
 * the helper never re-serializes the body through `saveCustomSkill` (which
 * would re-emit frontmatter and shift the hash).
 */
export async function importSharedSkill(
  detail: SharedSkillImportSource,
): Promise<LocalImportedSkill> {
  // 1. If we already have a local custom skill with the same content, link to
  //    it directly. `loadSkills` returns hashes only indirectly (via the lock
  //    file) so we fall back to listing the custom source and reading raw
  //    bytes — this is the only reliable way to detect content-hash equality
  //    from the renderer.
  const sourceRemoteId = detail.sourceRemoteId ?? detail.id;
  const contextEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
  if (sourceRemoteId && !detail.fromPublicShare && contextEnabled) {
    const written = await window.skills.writeRawSkill({
      skillName: detail.name,
      rawSkill: detail.rawSkill,
      sourceRemoteId,
      ...(detail.inCollection === true ? { inCollection: true } : {}),
    });
    return {
      ...written,
      reused: false,
      ...(await installPackagedFiles(detail, written.skillName)),
    };
  }
  // With enforcement on, only main can decide whether an identical copy has
  // an owned-source receipt and may be reused by a public import.
  const existing =
    detail.fromPublicShare && contextEnabled
      ? null
      : await findExistingByContent(detail);
  if (existing) {
    // Reusing the SKILL.md does not mean reusing the package: a recipient who
    // took the definition-only version before the publisher added supporting
    // files would otherwise never receive them on re-import.
    const packaged = await installPackagedFiles(detail, existing.skillName);
    await recordDefinitionOnlyOrigin(detail, existing.skillName, packaged);
    return {
      ...existing,
      reused: true,
      ...packaged,
    };
  }

  // 2. Walk numeric suffixes until a name lands.
  const baseName = detail.name;
  // A public share has no owned source to receipt. Naming the share lets main
  // verify the origin itself when context enforcement is on; without
  // enforcement main writes the bytes as before and ignores it. Under
  // enforcement main also resolves the name itself from the published
  // skill, so the suffix walk below completes on its first attempt and the
  // name it returns is the one to use.
  const publicShare =
    detail.fromPublicShare === true && detail.id !== undefined
      ? {
          externalId: detail.id,
          contentHash: detail.contentHash,
          ...(detail.publicCollection
            ? { collection: detail.publicCollection }
            : {}),
        }
      : undefined;
  for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
    try {
      const written = await window.skills.writeRawSkill({
        skillName: candidate,
        rawSkill: detail.rawSkill,
        ...(publicShare ? { publicShare } : {}),
      });
      const packaged = await installPackagedFiles(detail, written.skillName);
      await recordDefinitionOnlyOrigin(detail, written.skillName, packaged);
      return {
        skillId: written.skillId,
        skillName: written.skillName,
        reused: false,
        ...packaged,
      };
    } catch (err: unknown) {
      // The preload bridge propagates main-side errors via promise rejection.
      // The naming-collision path surfaces a specific message; on any other
      // error we re-throw so the caller can render it via
      // `resolveSharedResourceErrorMessage`.
      if (!isNameCollisionError(err)) {
        throw err;
      }
    }
  }

  throw new Error(
    `Could not import shared skill "${baseName}": exhausted ${MAX_SUFFIX_ATTEMPTS} name-suffix attempts.`,
  );
}

function isNameCollisionError(err: unknown): boolean {
  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    return (
      lower.includes('already exists') ||
      lower.includes('exists') ||
      lower.includes('eexist')
    );
  }
  return false;
}

async function findExistingByContent(
  detail: SharedSkillImportSource,
): Promise<{ skillId: string; skillName: string } | null> {
  const found = await findInstalledSkillByContentHash(detail.contentHash);
  return found ? { skillId: found.skillId, skillName: found.skillName } : null;
}

/**
 * Finds a local custom skill whose bytes hash to `contentHash`. Exported for
 * the deep-link landing's installed-state detection (CAN-2361 v2), which
 * needs the same comparison the import dedupe uses without importing. The
 * scan is deliberately limited to `custom:app` — bundled/plugin skills are
 * never install targets — and the matched `sourceId` is returned so callers
 * manage/uninstall exactly the source that matched instead of assuming one.
 */
export async function findInstalledSkillByContentHash(
  contentHash: string,
): Promise<{ skillId: string; sourceId: string; skillName: string } | null> {
  const skillsResult = await window.skills.loadSkills();
  if (!skillsResult.success || !skillsResult.data) return null;

  const customs = skillsResult.data.filter(
    (skill) => skill.sourceId === CUSTOM_SKILL_SOURCE_ID,
  );

  for (const skill of customs) {
    try {
      const raw = await window.skills.readRawSkill(
        `${skill.sourceId}/${skill.name}`,
      );
      if (await contentHashMatches(raw, contentHash)) {
        return {
          skillId: `${skill.sourceId}/${skill.name}`,
          sourceId: skill.sourceId,
          skillName: skill.name,
        };
      }
    } catch {
      // Any read failure simply means we can't compare; treat as not-matched
      // and continue.
    }
  }

  return null;
}

/**
 * The local name of a team or organization share's installed copy, or `null`
 * when Add would still have something to do. This follows the reuse rule of
 * the import itself, so a recipient page never claims an install that Add
 * would not reuse:
 *
 *   - with context enforcement on, only a copy whose install receipt names
 *     this share counts, and only while its bytes still match: main writes a
 *     new copy rather than adopting an unreceipted or edited one;
 *   - without enforcement, an identical copy counts, as the import reuses it;
 *   - a share with a supporting-file package counts only once that package
 *     installed, so a failed package install leaves Add to retry it.
 */
export async function findInstalledSharedSkill(
  detail: Pick<
    SharedSkillDetail,
    'id' | 'contentHash' | 'distributionMode' | 'package'
  >,
): Promise<string | null> {
  const contextEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
  if (!contextEnabled) {
    // No receipt records a package install here, so it cannot be confirmed.
    if (detail.distributionMode === 'package') return null;
    const found = await findInstalledSkillByContentHash(detail.contentHash);
    return found?.skillName ?? null;
  }
  const skillsResult = await window.skills.loadSkills();
  if (!skillsResult.success || !skillsResult.data) return null;
  // A share's receipt can name several local copies; main reuses any of them
  // whose bytes still match, so each one is checked.
  const receipted = skillsResult.data.filter(
    (skill) =>
      skill.sourceId === CUSTOM_SKILL_SOURCE_ID &&
      skill.installedFromShare?.remoteId === detail.id &&
      (detail.distributionMode !== 'package' ||
        (detail.package !== undefined &&
          skill.installedFromShare.packageDigest === detail.package.digest)),
  );
  for (const skill of receipted) {
    const raw = await window.skills.readRawSkill(
      `${skill.sourceId}/${skill.name}`,
    );
    if (await contentHashMatches(raw, detail.contentHash)) return skill.name;
  }
  return null;
}

async function contentHashMatches(
  raw: string,
  remoteHash: string,
): Promise<boolean> {
  try {
    const localHash = await sha256Hex(raw);
    return localHash === remoteHash.toLowerCase();
  } catch {
    return false;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const subtle =
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined'
      ? globalThis.crypto.subtle
      : undefined;
  if (!subtle) {
    // No crypto available — skip the deduplication optimization rather than
    // failing the import.
    return '';
  }
  const data = new TextEncoder().encode(input);
  const buffer = await subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Copy the share's packaged supporting files beside the SKILL.md just written.
 *
 * Never fatal. A definition-only share has nothing to install, and a share
 * whose package cannot be fetched still leaves the recipient with a working
 * skill — which is exactly what every skill import produced before packaging
 * existed. The failure is reported through the absent result rather than
 * unwinding a skill the user can already use.
 */
async function installPackagedFiles(
  detail: SharedSkillImportSource,
  skillName: string,
): Promise<{
  packageInstall?: InstallSkillCapabilityPackageResult;
  packageInstallError?: string;
}> {
  if (
    detail.distributionMode !== 'package' ||
    detail.package === undefined ||
    detail.id === undefined
  ) {
    return {};
  }
  try {
    return {
      packageInstall: await window.skills.installCapabilityPackage({
        remoteId: detail.id,
        skillName,
        primaryRootName: detail.name,
        packageRef: { version: 1, digest: detail.package.digest },
        ...(detail.fromPublicShare === true ? { publicShare: true } : {}),
      }),
    };
  } catch (error) {
    // Not fatal: the skill is already written and usable, and unwinding it
    // would be strictly worse than the definition-only import every skill got
    // before packaging existed. But swallowing this entirely would leave the
    // recipient believing they received the whole skill, so the reason is
    // returned for the caller to surface.
    //
    // EVERY caller must read `packageInstallError`. This is a partial success,
    // so it cannot be signalled by rejecting — which means a caller that only
    // awaits the promise reports plain success. Current readers: the deep-link
    // lander, the Skills tab, the plugin entry detail modal, the Collection
    // installer, and the App Advisor dispatcher's action result.
    // Unwrapped: the rejection crosses IPC, so its raw message carries the
    // channel name and the main-side error class.
    const message = extractIpcErrorMessage(error);
    return {
      packageInstallError:
        message === 'Unknown error'
          ? 'The supporting files could not be installed.'
          : message,
    };
  }
}

/**
 * Pin a definition-only import to the share it came from, so the install
 * ledger knows where the skill originated even though no package was fetched.
 * A successful packaged import records its own pin as part of the package
 * install. A package failure still leaves a definition-only skill and needs
 * this fallback. Reused content takes the same path; the main-process handler
 * writes only when that local skill has no prior ledger record, preserving an
 * existing package or source pin.
 *
 * The pin names the share this import came from and nothing further back: a
 * re-shared skill belongs to the re-sharer, so attribution does not chain.
 *
 * Never fatal: the skill is written and usable whether or not the pin lands.
 */
async function recordDefinitionOnlyOrigin(
  detail: SharedSkillImportSource,
  skillName: string,
  result: {
    packageInstall?: InstallSkillCapabilityPackageResult;
    packageInstallError?: string;
  },
): Promise<void> {
  if (result.packageInstall !== undefined || detail.id === undefined) return;
  try {
    await window.skills.recordShareOrigin({
      localId: skillName,
      originExternalId: detail.id,
      contentHash: detail.contentHash,
    });
  } catch {
    // The pin is provenance only; a missing row leaves the skill as it was
    // before origins were recorded.
  }
}

/** One wording for a failed supporting-file install, on every surface. */
export const SKILL_FILES_NOT_INSTALLED_LABEL =
  'Skill added, but its supporting files could not be installed.';

/**
 * What a caller must tell the recipient beyond "imported", or `null` when the
 * import was complete. Every case here is a partial success — the skill
 * landed — so every import path reports it through one notice rather than an
 * error or a plain success flash:
 *
 *   - the supporting files did not install at all;
 *   - some packaged files were not written because the recipient's own
 *     version was kept (a re-import never overwrites);
 *   - an invoked skill landed under a different name because the recipient
 *     already had a different skill by that name — the imported skill still
 *     calls the original name, which now runs the recipient's skill, so this
 *     one matters most;
 *   - packaged plugin skills, commands, or agents could not be added, because
 *     they belong to a plugin rather than to the skill library.
 */
export function describeSharedSkillImportNotice(result: {
  packageInstall?: InstallSkillCapabilityPackageResult;
  packageInstallError?: string;
}): string | null {
  if (result.packageInstallError !== undefined) {
    return `${SKILL_FILES_NOT_INSTALLED_LABEL} ${result.packageInstallError}`;
  }
  const install = result.packageInstall;
  if (!install) return null;
  const details: string[] = [];
  const kept = install.keptLocalFiles.length;
  if (kept === 1) {
    details.push('You already had one of its files, so your version was kept.');
  } else if (kept > 1) {
    details.push(
      `You already had ${kept} of its files, so your versions were kept.`,
    );
  }
  for (const dependency of install.installedDependencies) {
    if (dependency.localName === dependency.name) continue;
    details.push(
      `Its ${dependency.name} skill was added as ${dependency.localName}, because you already have a different ${dependency.name}.`,
    );
  }
  const plugin = install.uninstalledResourceLabels;
  if (plugin.length > 0) {
    details.push(
      `It also uses ${joinLabels(plugin)}, which come from a plugin and were not added.`,
    );
  }
  return details.length === 0 ? null : ['Skill added.', ...details].join(' ');
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
