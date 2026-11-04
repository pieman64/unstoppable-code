import { z } from 'zod';
import {
  MemoryAccountIdSchema,
  MemoryDeviceIdSchema,
  MemoryOrganizationIdSchema,
  MemoryProjectIdSchema,
  MemoryTimestampSchema,
  MemoryUuidSchema,
  isPortableFileName,
  portableFileNameIdentity,
} from './identifiers';

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

export const CloudProjectOwnerTypeSchema = z.enum(['user', 'organization']);
export const CloudProjectRepoListSourceSchema = z.enum([
  'canopy_json',
  'cloud_manifest',
]);

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

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

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
    portableConfig: z.record(z.string(), z.unknown()).nullable(),
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

export const CloudProjectMatchRequestSchema = z.strictObject({
  topology: z.enum(['single_repo', 'multi_repo']),
  rootFingerprint: RepoFingerprintSchema.nullable(),
  repositories: z.array(RepoFingerprintSchema).max(100),
});

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
