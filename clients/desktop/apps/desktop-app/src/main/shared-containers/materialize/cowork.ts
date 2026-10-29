import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AnySharedContainerRevisionLayout } from '@canopy/protocol/shared-containers';
import {
  reserveMaterializedPath,
  resolveMaterializedPath,
} from './path-safety';

export interface MaterializeCoworkRevisionOptions {
  layout: AnySharedContainerRevisionLayout;
  artifactsDir: string;
  outputDir: string;
  artifactPathsById?: ReadonlyMap<string, string>;
}

async function makeReadOnly(root: string): Promise<void> {
  const info = await stat(root);
  if (!info.isDirectory()) {
    await chmod(root, 0o400);
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await makeReadOnly(join(root, entry.name));
  }
  await chmod(root, 0o500);
}

async function makeWritable(root: string): Promise<void> {
  let info;
  try {
    info = await stat(root);
  } catch {
    return;
  }
  if (!info.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await makeWritable(join(root, entry.name));
  }
}

export async function materializeCoworkRevision(
  options: MaterializeCoworkRevisionOptions,
): Promise<void> {
  // Chats, plans, notes, prompts, and attachments share one projection for
  // both container types. Code materialization layers repository checkouts on
  // top only after this verified content projection succeeds.
  const temporary = `${options.outputDir}.staging`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    const declaredPaths = new Set<string>();
    const verifiedArtifactPaths = new Set(
      options.artifactPathsById?.values() ?? [],
    );
    for (const artifactPath of Array.from(verifiedArtifactPaths)) {
      if (/^(?:chats|plans)\//.test(artifactPath)) {
        reserveMaterializedPath(declaredPaths, artifactPath);
      }
    }
    for (const [category, items] of [
      ['notes', options.layout.notes],
      ['prompts', options.layout.prompts],
    ] as const) {
      for (const item of items) {
        const declaredPath = reserveMaterializedPath(
          declaredPaths,
          `${category}/${item.itemId}.md`,
        );
        if (
          options.artifactPathsById &&
          !verifiedArtifactPaths.has(declaredPath)
        ) {
          throw new Error(
            `No verified shared-container artifact exists for ${declaredPath}`,
          );
        }
      }
    }
    for (const category of ['chats', 'plans', 'notes', 'prompts'] as const) {
      const source = join(options.artifactsDir, category);
      try {
        await cp(source, join(temporary, category), { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const seen = declaredPaths;
    const referencedAttachmentPaths = new Set<string>();
    for (const attachment of Object.values(options.layout.attachmentPaths)) {
      if (basename(attachment.displayName) !== attachment.displayName) {
        throw new Error('Attachment display name must be a filename');
      }
      const relative = reserveMaterializedPath(
        seen,
        `attachments/${attachment.displayName}`,
      );
      const artifactPath =
        options.artifactPathsById?.get(attachment.artifactId) ??
        attachment.artifactId;
      if (!/^attachments\/[a-f0-9]{64}$/.test(artifactPath)) {
        throw new Error(
          `Attachment metadata references a non-attachment artifact: ${artifactPath}`,
        );
      }
      referencedAttachmentPaths.add(artifactPath);
      const source = resolveMaterializedPath(
        options.artifactsDir,
        artifactPath,
      );
      const destination = resolveMaterializedPath(temporary, relative);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    for (const artifactPath of Array.from(verifiedArtifactPaths)) {
      if (
        artifactPath.startsWith('attachments/') &&
        !referencedAttachmentPaths.has(artifactPath)
      ) {
        throw new Error(
          `Shared-container attachment is missing its container.json remap: ${artifactPath}`,
        );
      }
    }
    const referencedFilePaths = new Set<string>();
    for (const file of options.layout.files) {
      if (file.status === 'deleted') {
        if (file.artifactId !== undefined) {
          throw new Error('Deleted Cowork file must not reference an artifact');
        }
        continue;
      }
      if (!file.artifactId) {
        throw new Error(`Cowork file is missing its artifact: ${file.path}`);
      }
      const artifactPath =
        options.artifactPathsById?.get(file.artifactId) ?? file.artifactId;
      if (!/^files\/[a-f0-9]{64}$/.test(artifactPath)) {
        throw new Error(
          `Cowork file metadata references a non-file artifact: ${artifactPath}`,
        );
      }
      referencedFilePaths.add(artifactPath);
      const relative = reserveMaterializedPath(seen, file.path);
      const source = resolveMaterializedPath(
        options.artifactsDir,
        artifactPath,
      );
      const destination = resolveMaterializedPath(temporary, relative);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    for (const artifactPath of Array.from(verifiedArtifactPaths)) {
      if (
        artifactPath.startsWith('files/') &&
        !referencedFilePaths.has(artifactPath)
      ) {
        throw new Error(
          `Shared-container Cowork file is missing its container.json entry: ${artifactPath}`,
        );
      }
    }
    await makeReadOnly(temporary);
    await makeWritable(options.outputDir);
    await rm(options.outputDir, { recursive: true, force: true });
    await mkdir(dirname(options.outputDir), { recursive: true });
    await cp(temporary, options.outputDir, { recursive: true });
    await makeReadOnly(options.outputDir);
  } finally {
    await makeWritable(temporary);
    await rm(temporary, { recursive: true, force: true });
  }
}
