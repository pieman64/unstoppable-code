import type {
  CanopyJsonValue,
  CatalogSkillCustomSaveParams,
  CatalogSkillDiscoverResult,
  CatalogSkillRef,
  CatalogSkillRow,
} from '@canopy/protocol/canopy-core';

export type { CatalogSkillRef } from '@canopy/protocol/canopy-core';

/** The desktop's `CUSTOM_SOURCE_ID`: the source of every custom skill (CAN-4124). */
export const CATALOG_CUSTOM_SKILL_SOURCE_ID = 'custom:app';

export type CatalogSkillCustomSaveRequest = Omit<
  CatalogSkillCustomSaveParams,
  '_meta'
>;

/** The ports a host implements; each wraps one existing service function (CAN-4124 D5). */
export interface CoreSkillCatalogHost {
  list(): Promise<CatalogSkillRow[]>;
  read(ref: CatalogSkillRef): Promise<{
    frontmatter: Record<string, CanopyJsonValue>;
    body: string;
    truncated: boolean;
  }>;
  listFiles(
    ref: CatalogSkillRef,
  ): Promise<{ files: string[]; truncated: boolean }>;
  readFile(
    ref: CatalogSkillRef,
    filePath: string,
  ): Promise<{ content: string; truncated: boolean; binary: boolean }>;
  discover(source: string): Promise<CatalogSkillDiscoverResult>;
  install(request: {
    source: string;
    skillNames: readonly string[];
  }): Promise<{ sourceId: string; skillNames: string[] }>;
  update(ref: CatalogSkillRef): Promise<void>;
  remove(ref: CatalogSkillRef): Promise<void>;
  saveCustom(
    request: CatalogSkillCustomSaveRequest,
  ): Promise<{ skillName: string }>;
  checkUpdates(): Promise<
    { sourceId: string; skillName: string; updateAvailable: boolean }[]
  >;
}

export const CATALOG_SKILL_REFUSALS = [
  'skill-not-found',
  'skill-read-only',
  'skill-path-invalid',
  'skill-context-refused',
  'skill-invalid',
  'skill-name-taken',
  'skill-source-invalid',
  'skills-unavailable',
  'skill-discovery-failed',
  'skill-install-failed',
  'skill-update-failed',
  'skill-remove-failed',
  'skill-save-failed',
  'skill-update-check-failed',
] as const;
export type CatalogSkillRefusal = (typeof CATALOG_SKILL_REFUSALS)[number];

/** A host refusal; `cause` is what a local projection surfaces (CAN-4124 D12). */
export class CatalogSkillRefusedError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
  constructor(
    readonly refusal: CatalogSkillRefusal,
    cause?: unknown,
  ) {
    super(`Skill catalog refusal: ${refusal}.`);
    this.name = 'CatalogSkillRefusedError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
  }
}
