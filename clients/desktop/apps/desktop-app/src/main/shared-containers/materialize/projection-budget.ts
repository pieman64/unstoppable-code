import {
  MAX_SHARED_CONTAINER_MATERIALIZED_BYTES,
  MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
  type SharedContainerArtifactDetail,
  type AnySharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';

export interface SharedContainerProjectionUsage {
  files: number;
  bytes: bigint;
}

export function validateSharedContainerProjectionBudget(
  layout: AnySharedContainerRevisionLayout,
  artifacts: readonly SharedContainerArtifactDetail[],
): SharedContainerProjectionUsage {
  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  let projectedFiles = 0;
  let projectedBytes = BigInt(0);
  const accountFile = (): void => {
    projectedFiles += 1;
    if (projectedFiles > MAX_SHARED_CONTAINER_MATERIALIZED_FILES) {
      throw new Error('Shared-container projection file limit exceeded');
    }
  };
  const accountArtifact = (artifactId: string): void => {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      throw new Error(
        `Shared-container projection references missing artifact: ${artifactId}`,
      );
    }
    accountFile();
    projectedBytes += BigInt(artifact.objectSizeBytes);
    if (projectedBytes > BigInt(MAX_SHARED_CONTAINER_MATERIALIZED_BYTES)) {
      throw new Error('Shared-container projection byte limit exceeded');
    }
  };

  for (const artifact of artifacts) {
    if (/^(?:chats|plans|notes|prompts)\//.test(artifact.path)) {
      accountArtifact(artifact.artifactId);
    }
  }
  for (const attachment of Object.values(layout.attachmentPaths)) {
    accountArtifact(attachment.artifactId);
  }
  for (const repository of layout.repositories) {
    if ('source' in repository && repository.source === 'snapshot') {
      const overlayFileDelta = repository.files.reduce(
        (delta, file) =>
          delta +
          (file.status === 'added' ? 1 : file.status === 'deleted' ? -1 : 0),
        0,
      );
      const repositoryFileCount =
        repository.snapshot.treeFileCount + overlayFileDelta;
      if (repositoryFileCount < 0) {
        throw new Error('Shared-container snapshot projection is invalid');
      }
      projectedFiles += repositoryFileCount;
      projectedBytes += BigInt(repository.snapshot.treeBytes);
      if (
        projectedFiles > MAX_SHARED_CONTAINER_MATERIALIZED_FILES ||
        projectedBytes > BigInt(MAX_SHARED_CONTAINER_MATERIALIZED_BYTES)
      ) {
        throw new Error('Shared-container snapshot projection limit exceeded');
      }
      for (const artifactId of repository.snapshot.bundleArtifactIds) {
        if (!artifactsById.has(artifactId)) {
          throw new Error(
            `Shared-container projection references missing artifact: ${artifactId}`,
          );
        }
      }
      for (const file of repository.files) {
        if (
          file.status !== 'deleted' &&
          (!file.artifactId || !artifactsById.has(file.artifactId))
        ) {
          throw new Error(
            `Shared-container projection references missing artifact: ${file.artifactId ?? file.path}`,
          );
        }
      }
      // Snapshot overlay entries replace or remove paths in the authenticated
      // base tree as often as they add them. The wire shape does not carry the
      // replaced blob sizes, so counting every declaration here rejects valid
      // revisions at the limit. The code materializer measures the final tree
      // after applying the overlay and enforces the exact aggregate budget.
      continue;
    }
    for (const file of repository.files) {
      if (file.status === 'deleted') accountFile();
      else if (file.artifactId) accountArtifact(file.artifactId);
    }
  }
  for (const file of layout.files) {
    if (file.status === 'deleted') accountFile();
    else if (file.artifactId) accountArtifact(file.artifactId);
  }
  return { files: projectedFiles, bytes: projectedBytes };
}
