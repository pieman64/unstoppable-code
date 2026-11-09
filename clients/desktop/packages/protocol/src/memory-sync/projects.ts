import { z } from 'zod';
import {
  MemoryAccountIdSchema,
  MemoryDeviceIdSchema,
  MemoryInstallationGenerationSchema,
  MemoryOrganizationIdSchema,
  MemoryProjectIdSchema,
  MemoryTimestampSchema,
  MemoryUuidSchema,
  isPortableFileName,
  portableFileNameIdentity,
} from './identifiers';

/** Minted on `/account` while the project identity rollout is on (CAN-5189). */
export const PROJECT_IDENTITY_CAPABILITY = 'project-identity-v1';

const PROJECTS_API_PREFIX = '/api/v1/projects';

export const CLOUD_PROJECT_ROUTES = {
  createPersonal: (): string => `${PROJECTS_API_PREFIX}/personal`,
  /** `GET`, with `deviceId` and `installationGeneration` (CAN-5192). */
  listPersonal: (): string => `${PROJECTS_API_PREFIX}/personal`,
  matchPersonal: (): string => `${PROJECTS_API_PREFIX}/personal/match`,
  manifest: (projectId: string): string =>
    `${PROJECTS_API_PREFIX}/${projectId}/manifest`,
  lifecycle: (projectId: string): string =>
    `${PROJECTS_API_PREFIX}/${projectId}/lifecycle`,
  events: (projectId: string): string =>
    `${PROJECTS_API_PREFIX}/${projectId}/events`,
  eventStream: (): string => `${PROJECTS_API_PREFIX}/events/stream`,
  claimInstance: (projectId: string): string =>
    `${PROJECTS_API_PREFIX}/${projectId}/instances/claim`,
  completeInstance: (instanceId: string): string =>
    `${PROJECTS_API_PREFIX}/instances/${instanceId}/complete`,
  detachInstance: (instanceId: string): string =>
    `${PROJECTS_API_PREFIX}/instances/${instanceId}/detach`,
  instanceRepositories: (instanceId: string): string =>
    `${PROJECTS_API_PREFIX}/instances/${instanceId}/repositories`,
} as const;

export const REPO_PROVIDERS = ['github', 'generic'] as const;
export type RepoProvider = (typeof REPO_PROVIDERS)[number];

export interface NormalizedRepoRemote {
  host: string;
  path: string;
  remoteKey: string;
  provider: RepoProvider;
}

const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set([
  'https:',
  'http:',
  'ssh:',
  'git:',
  'git+ssh:',
  'ssh+git:',
]);
const HOST_ALIASES: Readonly<Record<string, string>> = {
  'ssh.github.com': 'github.com',
};
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const SEGMENT_PATTERN = /^[a-z0-9._-]+$/;
const SCP_REMOTE_PATTERN = /^(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9.-]+):(.+)$/;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const MIN_PATH_SEGMENTS = 2;
const MAX_PATH_SEGMENTS = 8;

function hostAndPath(remote: string): { host: string; path: string } | null {
  if (SCHEME_PATTERN.test(remote)) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) return null;
    return { host: url.hostname, path: url.pathname };
  }
  const scp = SCP_REMOTE_PATTERN.exec(remote);
  const host = scp?.[1] ?? '';
  // Git reads `C:/path` as a Windows drive path, never as host `C`.
  if (scp === null || host.length < 2) return null;
  return { host, path: scp[2] ?? '' };
}

/**
 * The fingerprint key of a Git remote: lower-case host and path, without
 * scheme, credentials, port or a trailing `.git`, so the HTTPS and SSH remotes
 * of one repository produce the same key. Local paths, `file:` URLs and
 * bundles have no key. Case is folded for every host: GitHub and GitLab treat
 * owner and name case-insensitively, and a generic host whose paths differ
 * only in case is accepted as a collision risk.
 */
export function normalizeRepoRemote(
  remote: string,
): NormalizedRepoRemote | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return null;
  if (trimmed.includes('\\')) return null;
  const parts = hostAndPath(trimmed);
  if (parts === null) return null;
  let host = parts.host.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  host = HOST_ALIASES[host] ?? host;
  if (host.length === 0 || host.length > 253 || !HOST_PATTERN.test(host)) {
    return null;
  }
  const segments = parts.path
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0);
  const last = segments.pop();
  if (last === undefined) return null;
  const name = last.endsWith('.git') ? last.slice(0, -4) : last;
  segments.push(name);
  if (
    segments.length < MIN_PATH_SEGMENTS ||
    segments.length > MAX_PATH_SEGMENTS ||
    !segments.every(
      (segment) =>
        SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..',
    )
  ) {
    return null;
  }
  const path = segments.join('/');
  return {
    host,
    path,
    remoteKey: `${host}/${path}`,
    provider: host === 'github.com' ? 'github' : 'generic',
  };
}

export const RepoRemoteKeySchema = z
  .string()
  .max(1_024)
  .refine(
    (value: string): boolean =>
      normalizeRepoRemote(`https://${value}`)?.remoteKey === value,
    'Expected a normalized repository key',
  );

export const RepoFingerprintSchema = z.strictObject({
  remoteKey: RepoRemoteKeySchema,
  provider: z.enum(REPO_PROVIDERS),
  providerRepoId: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .nullable(),
});
export type RepoFingerprint = z.output<typeof RepoFingerprintSchema>;

/**
 * What a project's `fingerprintDigest` hashes (SHA-256, hex): its distinct
 * remote keys in code-unit order, joined with LF. Keys are ASCII, so code-unit
 * order is also Postgres `COLLATE "C"` order.
 */
export function cloudProjectFingerprintMaterial(
  remoteKeys: readonly string[],
): string | null {
  const keys = [...new Set(remoteKeys)].sort();
  return keys.length === 0 ? null : keys.join('\n');
}

/**
 * Whether two fingerprints name one repository: by the provider's immutable ID
 * when both carry one, otherwise by remote key. A renamed or transferred
 * repository keeps its ID; a fork has its own.
 */
export function isSameRepository(
  left: RepoFingerprint,
  right: RepoFingerprint,
): boolean {
  if (
    left.provider === right.provider &&
    left.providerRepoId !== null &&
    right.providerRepoId !== null
  ) {
    return left.providerRepoId === right.providerRepoId;
  }
  return left.remoteKey === right.remoteKey;
}

export const CloudProjectOwnerTypeSchema = z.enum(['user', 'organization']);
export const CloudProjectRepoListSourceSchema = z.enum([
  'canopy_json',
  'cloud_manifest',
]);
export type CloudProjectRepoListSource = z.output<
  typeof CloudProjectRepoListSourceSchema
>;

/** `workspace.json` `cloudBinding`; under any other account the project is unbound. */
export const CloudProjectBindingSchema = z
  .looseObject({
    version: z.literal(1),
    projectId: MemoryProjectIdSchema,
    accountId: MemoryAccountIdSchema,
    ownerType: CloudProjectOwnerTypeSchema,
    organizationId: MemoryOrganizationIdSchema.nullable(),
    instanceId: MemoryUuidSchema,
    bindingGeneration: z.int().min(0),
    boundAt: MemoryTimestampSchema,
    manifestRevision: z.int().min(0),
    repoListSource: CloudProjectRepoListSourceSchema,
  })
  .refine(
    (binding): boolean =>
      (binding.ownerType === 'organization') ===
      (binding.organizationId !== null),
    'An organization project names its organization',
  );
export type CloudProjectBinding = z.output<typeof CloudProjectBindingSchema>;

const DIRECTORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export const CloudProjectRepositorySchema = z.strictObject({
  repositoryId: MemoryUuidSchema,
  /** The `canopy.json` repo `id` when `canopy.json` owns the repo list. */
  sourceKey: z.string().min(1).max(128).nullable(),
  fingerprint: RepoFingerprintSchema,
  defaultBranch: z.string().min(1).max(255).nullable(),
  directoryName: z
    .string()
    .regex(DIRECTORY_NAME_PATTERN)
    .refine(isPortableFileName, 'Not a portable directory name'),
  ordinal: z.int().min(0),
});
export type CloudProjectRepository = z.output<
  typeof CloudProjectRepositorySchema
>;

function directoryCandidate(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 200);
  if (cleaned.length === 0) return 'repository';
  return isPortableFileName(cleaned) ? cleaned : `${cleaned}-repository`;
}

export interface CloudProjectDirectoryEntry {
  /** The repository's stored directory name, null for a new repository. */
  preferred: string | null;
  /** The repository name a new directory name is derived from. */
  fallback: string;
  /** The repository's identity (its remote key), which orders ties. */
  key?: string;
}

function usableDirectoryName(name: string | null): name is string {
  return (
    name !== null &&
    DIRECTORY_NAME_PATTERN.test(name) &&
    isPortableFileName(name)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A portable, distinct checkout directory for each repository, returned in
 * input order. Repositories with a usable stored name keep it first, so a new
 * repository never takes an existing one's directory; the rest get a name
 * derived from their fallback (the repository name), with a numeric suffix
 * when it is taken. Ties go by name and then `key`, never by input position,
 * so every device and the server derive the same names from the same
 * repositories in any order.
 */
export function cloudProjectDirectoryNames(
  entries: readonly CloudProjectDirectoryEntry[],
): string[] {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        compareText(a.entry.preferred ?? '', b.entry.preferred ?? '') ||
        compareText(a.entry.fallback, b.entry.fallback) ||
        compareText(a.entry.key ?? '', b.entry.key ?? '') ||
        a.index - b.index,
    );
  const names: string[] = new Array<string>(entries.length);
  const taken = new Set<string>();
  const unnamed: typeof ordered = [];
  for (const item of ordered) {
    const { preferred } = item.entry;
    if (
      usableDirectoryName(preferred) &&
      !taken.has(portableFileNameIdentity(preferred))
    ) {
      taken.add(portableFileNameIdentity(preferred));
      names[item.index] = preferred;
    } else unnamed.push(item);
  }
  unnamed.sort(
    (a, b) =>
      compareText(
        directoryCandidate(a.entry.fallback),
        directoryCandidate(b.entry.fallback),
      ) ||
      compareText(a.entry.key ?? '', b.entry.key ?? '') ||
      compareText(a.entry.preferred ?? '', b.entry.preferred ?? '') ||
      a.index - b.index,
  );
  for (const { entry, index } of unnamed) {
    const base = directoryCandidate(entry.fallback);
    let name = base;
    for (let suffix = 2; taken.has(portableFileNameIdentity(name)); suffix++) {
      name = `${base}-${suffix}`;
    }
    taken.add(portableFileNameIdentity(name));
    names[index] = name;
  }
  return names;
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'=:(])(?:~[\\/]|\/(?:Users|home|root|Volumes|private|var\/folders|mnt|media)\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/;

/**
 * Whether a portable config string names a path that exists only on one
 * computer: a home directory, a mounted volume, a drive or a network share.
 */
export function namesLocalPath(value: string): boolean {
  return LOCAL_PATH_PATTERN.test(value);
}

function stringLeaves(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value))
    for (const item of value) stringLeaves(item, into);
  else if (typeof value === 'object' && value !== null)
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      stringLeaves(item, into);
    }
}

export const CLOUD_PROJECT_PORTABLE_CONFIG_MAX_BYTES = 64 * 1024;

const PORTABLE_CONFIG_NAME = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (name: string): boolean =>
      [...name].every((character) => character.charCodeAt(0) >= 0x20),
    'Names have no control characters',
  );

const PortableScriptSchema = z.union([
  z
    .string()
    .min(1)
    .max(8 * 1024),
  z.looseObject({
    command: z
      .string()
      .min(1)
      .max(8 * 1024),
  }),
  z.null(),
]);

const PortableHookActionSchema = z.looseObject({
  type: z.enum(['command', 'chat', 'pipeline']),
});

/**
 * The project's scripts and hooks that travel with it to other computers, in
 * the `canopy.json` / `workspace.json` value shapes. Nothing in it may name a
 * local path; device-local pipelines and bindings stay on their device.
 */
export const CloudProjectPortableConfigSchema = z
  .strictObject({
    version: z.literal(1),
    scripts: z.record(PORTABLE_CONFIG_NAME, PortableScriptSchema).optional(),
    hooks: z
      .record(
        PORTABLE_CONFIG_NAME,
        z.array(PortableHookActionSchema).max(50).nullable(),
      )
      .optional(),
  })
  .superRefine((config, context): void => {
    if (
      new TextEncoder().encode(JSON.stringify(config)).byteLength >
      CLOUD_PROJECT_PORTABLE_CONFIG_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Portable config too large',
      });
    }
    const leaves: string[] = [];
    stringLeaves(config, leaves);
    if (leaves.some(namesLocalPath)) {
      context.addIssue({
        code: 'custom',
        message: 'Portable config names a local path',
      });
    }
  });
export type CloudProjectPortableConfig = z.output<
  typeof CloudProjectPortableConfigSchema
>;

export const CloudProjectManifestSchema = z
  .strictObject({
    projectId: MemoryProjectIdSchema,
    revision: z.int().min(1),
    name: z.string().min(1).max(256),
    kind: z.enum(['code', 'cowork']),
    topology: z.enum(['single_repo', 'multi_repo']),
    repoListSource: CloudProjectRepoListSourceSchema,
    rootRepositoryId: MemoryUuidSchema.nullable(),
    repositories: z.array(CloudProjectRepositorySchema).max(100),
    portableConfig: CloudProjectPortableConfigSchema.nullable(),
  })
  .superRefine((manifest, context): void => {
    const repositoryIds = manifest.repositories.map(
      (repository) => repository.repositoryId,
    );
    if (!isUnique(repositoryIds)) {
      context.addIssue({ code: 'custom', message: 'Repository IDs repeat' });
    }
    const directories = manifest.repositories.map((repository) =>
      portableFileNameIdentity(repository.directoryName),
    );
    if (!isUnique(directories)) {
      context.addIssue({ code: 'custom', message: 'Directory names repeat' });
    }
    const remoteKeys = manifest.repositories.map(
      (repository) => repository.fingerprint.remoteKey,
    );
    if (!isUnique(remoteKeys)) {
      context.addIssue({ code: 'custom', message: 'Repositories repeat' });
    }
    if (
      manifest.rootRepositoryId !== null &&
      !repositoryIds.includes(manifest.rootRepositoryId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The root repository is one of the repositories',
      });
    }
  });
export type CloudProjectManifest = z.output<typeof CloudProjectManifestSchema>;

export const CloudProjectInstanceSelectionSchema = z
  .strictObject({
    instanceId: MemoryUuidSchema,
    projectId: MemoryProjectIdSchema,
    deviceId: MemoryDeviceIdSchema,
    revision: z.int().min(1),
    selectedRepositoryIds: z.array(MemoryUuidSchema).max(100),
    dismissedRepositoryIds: z.array(MemoryUuidSchema).max(100),
  })
  .refine(
    (selection): boolean =>
      isUnique([
        ...selection.selectedRepositoryIds,
        ...selection.dismissedRepositoryIds,
      ]),
    'A repository is selected, dismissed, or neither',
  );
export type CloudProjectInstanceSelection = z.output<
  typeof CloudProjectInstanceSelectionSchema
>;

/** The instance claim's rule: an opaque ID, never a local path. */
function isOpaqueLocalWorkspaceId(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(value) &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
  );
}

/**
 * The local checkout a match or create is made for, named as its instance
 * claim names it. One cloud project holds one binding per device
 * installation, so another checkout of the same installation needs a project
 * of its own; without the checkout the server cannot tell them apart.
 */
export const CloudProjectCheckoutSchema = z.strictObject({
  deviceId: MemoryDeviceIdSchema,
  installationGeneration: MemoryInstallationGenerationSchema,
  localWorkspaceId: z
    .string()
    .min(1)
    .max(128)
    .refine(isOpaqueLocalWorkspaceId, 'An opaque ID, not a path'),
});
export type CloudProjectCheckout = z.output<typeof CloudProjectCheckoutSchema>;

export const CloudProjectMatchRequestSchema = z.strictObject({
  topology: z.enum(['single_repo', 'multi_repo']),
  rootFingerprint: RepoFingerprintSchema.nullable(),
  repositories: z.array(RepoFingerprintSchema).max(100),
  checkout: CloudProjectCheckoutSchema.optional(),
});
export type CloudProjectMatchRequest = z.output<
  typeof CloudProjectMatchRequestSchema
>;

/**
 * One repository a device proposes for a project. `repositoryId` names an
 * existing manifest entry, or is null for a new one; the list order is the
 * ordinal. `root` marks the repository at the project root.
 */
export const CloudProjectRepositoryDraftSchema = z.strictObject({
  repositoryId: MemoryUuidSchema.nullable(),
  sourceKey: z.string().min(1).max(128).nullable(),
  fingerprint: RepoFingerprintSchema,
  defaultBranch: z.string().min(1).max(255).nullable(),
  directoryName: z
    .string()
    .regex(DIRECTORY_NAME_PATTERN)
    .refine(isPortableFileName, 'Not a portable directory name'),
  root: z.boolean(),
});
export type CloudProjectRepositoryDraft = z.output<
  typeof CloudProjectRepositoryDraftSchema
>;

const CloudProjectTopologySchema = z.enum(['single_repo', 'multi_repo']);

function checkRepositoryDrafts(
  draft: {
    topology: z.output<typeof CloudProjectTopologySchema>;
    repoListSource: z.output<typeof CloudProjectRepoListSourceSchema>;
    repositories: readonly CloudProjectRepositoryDraft[];
  },
  context: z.RefinementCtx,
): void {
  const { repositories } = draft;
  const ids = repositories.flatMap((repository) =>
    repository.repositoryId === null ? [] : [repository.repositoryId],
  );
  if (!isUnique(ids)) {
    context.addIssue({ code: 'custom', message: 'Repository IDs repeat' });
  }
  if (
    !isUnique(
      repositories.map((repository) =>
        portableFileNameIdentity(repository.directoryName),
      ),
    )
  ) {
    context.addIssue({ code: 'custom', message: 'Directory names repeat' });
  }
  if (
    !isUnique(
      repositories.map((repository) => repository.fingerprint.remoteKey),
    )
  ) {
    context.addIssue({ code: 'custom', message: 'Repositories repeat' });
  }
  const roots = repositories.filter((repository) => repository.root);
  if (roots.length > 1) {
    context.addIssue({ code: 'custom', message: 'Only one root repository' });
  }
  if (draft.topology === 'single_repo' && repositories.length > 1) {
    context.addIssue({
      code: 'custom',
      message: 'A single-repository project has at most one repository',
    });
  }
  if (
    draft.repoListSource === 'canopy_json' &&
    (roots.length !== 1 ||
      repositories.some(
        (repository) => !repository.root && repository.sourceKey === null,
      ))
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'A canopy.json repository list needs a root remote and a source key for each repository',
    });
  }
}

/**
 * Create, or find again, the caller's Personal cloud project for one local
 * workspace. `creationKey` is the workspace's `personalCatalogId`, so a
 * retried create answers the project it made, and a workspace already in the
 * Personal catalog answers that project.
 */
export const CloudProjectCreateRequestSchema = z
  .strictObject({
    creationKey: MemoryUuidSchema,
    name: z.string().trim().min(1).max(256),
    kind: z.enum(['code', 'cowork']),
    topology: CloudProjectTopologySchema,
    repoListSource: CloudProjectRepoListSourceSchema,
    repositories: z.array(CloudProjectRepositoryDraftSchema).max(100),
    portableConfig: CloudProjectPortableConfigSchema.nullable(),
    checkout: CloudProjectCheckoutSchema.optional(),
  })
  .superRefine(checkRepositoryDrafts);
export type CloudProjectCreateRequest = z.output<
  typeof CloudProjectCreateRequestSchema
>;

/** Replace a Personal project's manifest; compare-and-set on `baseRevision`. */
export const CloudProjectManifestUpdateRequestSchema = z
  .strictObject({
    baseRevision: z.int().min(1),
    name: z.string().trim().min(1).max(256),
    topology: CloudProjectTopologySchema,
    repoListSource: CloudProjectRepoListSourceSchema,
    repositories: z.array(CloudProjectRepositoryDraftSchema).max(100),
    portableConfig: CloudProjectPortableConfigSchema.nullable(),
  })
  .superRefine(checkRepositoryDrafts);
export type CloudProjectManifestUpdateRequest = z.output<
  typeof CloudProjectManifestUpdateRequestSchema
>;

export const CloudProjectLifecycleRequestSchema = z.strictObject({
  action: z.enum(['archive', 'restore', 'delete']),
  revision: z.int().min(1),
});
export type CloudProjectLifecycleRequest = z.output<
  typeof CloudProjectLifecycleRequestSchema
>;

export const CloudProjectLifecycleResponseSchema = z.strictObject({
  projectId: MemoryProjectIdSchema,
  state: z.enum(['active', 'archived', 'deleted']),
  revision: z.int().min(1),
});
export type CloudProjectLifecycleResponse = z.output<
  typeof CloudProjectLifecycleResponseSchema
>;

/**
 * The 409 body for a project ID that now redirects: a merged duplicate, or a
 * Personal project that moved into an organization. Bind to `projectId`.
 */
export const CloudProjectRedirectSchema = z.strictObject({
  error: z.string(),
  code: z.literal('project_redirected'),
  projectId: MemoryProjectIdSchema,
});
export type CloudProjectRedirect = z.output<typeof CloudProjectRedirectSchema>;

export const CloudProjectMatchResponseSchema = z.discriminatedUnion(
  'decision',
  [
    z.strictObject({
      decision: z.literal('matched'),
      projectId: MemoryProjectIdSchema,
      manifestRevision: z.int().min(1),
    }),
    z.strictObject({
      decision: z.literal('candidates'),
      candidates: z
        .array(
          z.strictObject({
            projectId: MemoryProjectIdSchema,
            name: z.string().min(1).max(256),
            ownerType: CloudProjectOwnerTypeSchema,
            organizationId: MemoryOrganizationIdSchema.nullable(),
            matchedRepositories: z.int().min(0),
            totalRepositories: z.int().min(0),
          }),
        )
        .min(1)
        .max(20),
    }),
    z.strictObject({ decision: z.literal('none') }),
  ],
);
export type CloudProjectMatchResponse = z.output<
  typeof CloudProjectMatchResponseSchema
>;

export const CloudProjectLifecycleEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('renamed'),
    projectId: MemoryProjectIdSchema,
    name: z.string().min(1).max(256),
    manifestRevision: z.int().min(1),
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('repository_remote_changed'),
    projectId: MemoryProjectIdSchema,
    repositoryId: MemoryUuidSchema,
    previousRemoteKey: RepoRemoteKeySchema,
    remoteKey: RepoRemoteKeySchema,
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('moved_to_organization'),
    fromProjectId: MemoryProjectIdSchema,
    toProjectId: MemoryProjectIdSchema,
    organizationId: MemoryOrganizationIdSchema,
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('moved_to_personal'),
    fromProjectId: MemoryProjectIdSchema,
    toProjectId: MemoryProjectIdSchema,
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('merged_duplicate'),
    fromProjectId: MemoryProjectIdSchema,
    toProjectId: MemoryProjectIdSchema,
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('archived'),
    projectId: MemoryProjectIdSchema,
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('restored'),
    projectId: MemoryProjectIdSchema,
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('instance_detached'),
    projectId: MemoryProjectIdSchema,
    instanceId: MemoryUuidSchema,
    deviceId: MemoryDeviceIdSchema,
    /**
     * The `fencingGeneration` of the claim this detach ended. A device setup
     * claimed again keeps its instance ID under a higher generation, so a
     * detach for a lower one is about an earlier claim.
     */
    fencingGeneration: z.int().min(0).max(2_147_483_647),
    at: MemoryTimestampSchema,
  }),
  z.strictObject({
    type: z.literal('deleted'),
    projectId: MemoryProjectIdSchema,
    at: MemoryTimestampSchema,
  }),
]);
export type CloudProjectLifecycleEvent = z.output<
  typeof CloudProjectLifecycleEventSchema
>;

export const CLOUD_PROJECT_EVENTS_PAGE_MAX = 100;

const PROJECT_EVENT_CURSOR_PREFIX = 'pe1';
const PROJECT_EVENT_SEQ_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/;
const PROJECT_EVENT_SEQ_MAX = 2_147_483_647;

/**
 * A position in one project's lifecycle feed: the project and its gap-free
 * event sequence, which the server advances in commit order. Clients treat
 * the cursor string as opaque: they keep the one a page, a claim or a nudge
 * gave them and send it back as `after`.
 */
export interface CloudProjectEventCursor {
  projectId: string;
  seq: number;
}

export function formatCloudProjectEventCursor(
  cursor: CloudProjectEventCursor,
): string {
  return `${PROJECT_EVENT_CURSOR_PREFIX}.${cursor.projectId}.${cursor.seq}`;
}

export function parseCloudProjectEventCursor(
  value: string,
): CloudProjectEventCursor | null {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== PROJECT_EVENT_CURSOR_PREFIX)
    return null;
  const [, projectId = '', seqText = ''] = parts;
  if (
    !MemoryProjectIdSchema.safeParse(projectId).success ||
    !PROJECT_EVENT_SEQ_PATTERN.test(seqText)
  )
    return null;
  const seq = Number(seqText);
  return seq <= PROJECT_EVENT_SEQ_MAX ? { projectId, seq } : null;
}

export const CloudProjectEventCursorSchema = z
  .string()
  .refine(
    (value: string): boolean => parseCloudProjectEventCursor(value) !== null,
    'Expected a project event cursor',
  );

function checkEventsPage(
  page: {
    projectId: string;
    events: readonly { cursor: string }[];
    nextCursor: string;
  },
  context: z.RefinementCtx,
): void {
  const positions = [
    ...page.events.map((entry) => entry.cursor),
    page.nextCursor,
  ].map(parseCloudProjectEventCursor);
  let previous = -1;
  for (const [index, position] of positions.entries()) {
    const isNext = index === positions.length - 1;
    if (
      position === null ||
      position.projectId !== page.projectId ||
      (isNext ? position.seq < previous : position.seq <= previous)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Event cursors must name this project and only move forward',
      });
      return;
    }
    previous = position.seq;
  }
}

/**
 * `GET /api/v1/projects/{projectId}/events?after=`: events after the cursor,
 * oldest first; without `after`, from the first event. `eventId` identifies
 * an event. `nextCursor` is the last event's cursor, or `after` again when
 * nothing is newer.
 */
export const CloudProjectLifecycleEventsPageSchema = z
  .strictObject({
    projectId: MemoryProjectIdSchema,
    events: z
      .array(
        z.strictObject({
          eventId: MemoryUuidSchema,
          cursor: CloudProjectEventCursorSchema,
          event: CloudProjectLifecycleEventSchema,
        }),
      )
      .max(CLOUD_PROJECT_EVENTS_PAGE_MAX),
    nextCursor: CloudProjectEventCursorSchema,
    hasMore: z.boolean(),
  })
  .superRefine(checkEventsPage);
export type CloudProjectLifecycleEventsPage = z.output<
  typeof CloudProjectLifecycleEventsPageSchema
>;

export const CLOUD_PROJECT_LIST_MAX = 200;

/**
 * One of the caller's Personal cloud projects, as a new device lists them to
 * set one up (CAN-5192). `instance` is this device installation's setup of
 * it, when there is one that is not detached.
 */
export const CloudProjectListEntrySchema = z.strictObject({
  projectId: MemoryProjectIdSchema,
  name: z.string().min(1).max(256),
  kind: z.enum(['code', 'cowork']),
  topology: CloudProjectTopologySchema,
  repositoryCount: z.int().min(0).max(100),
  updatedAt: MemoryTimestampSchema,
  instance: z
    .strictObject({
      instanceId: MemoryUuidSchema,
      state: z.enum(['CLAIMED', 'READY']),
      selectedRepositoryIds: z.array(MemoryUuidSchema).max(100),
      dismissedRepositoryIds: z.array(MemoryUuidSchema).max(100),
    })
    .nullable(),
});
export type CloudProjectListEntry = z.output<
  typeof CloudProjectListEntrySchema
>;

/**
 * `GET /api/v1/projects/personal?deviceId=&installationGeneration=`: the
 * caller's live Personal cloud projects, most recently updated first.
 */
export const CloudProjectListSchema = z.strictObject({
  projects: z.array(CloudProjectListEntrySchema).max(CLOUD_PROJECT_LIST_MAX),
});
export type CloudProjectList = z.output<typeof CloudProjectListSchema>;
