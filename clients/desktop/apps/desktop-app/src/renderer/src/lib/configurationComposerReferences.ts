import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import type {
  HomeDiscoveryTarget,
  RepoFileIndex,
} from '@canopy/desktop-shared/types';
import type {
  FileMentionOption,
  SerializedFileReference,
} from '@canopy/ui-rich/types';
import { buildEditorValueFromMessage } from '@canopy/ui-rich/editor';
import {
  parsePluginMentionAbsolutePath,
  PLUGIN_MENTION_KIND,
} from '@canopy/desktop-shared/lib/plugin-mention';
import { buildFileReferenceDisplayPath } from './fileMentionSearch';

const CONFIGURED_LOCATOR_PREFIX = 'configured://reference/';

let nextReferenceNamespace = 0;

/** Each editor owns its synthetic pill locators, including across windows. */
export function createConfiguredReferenceNamespace(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${random}-${nextReferenceNamespace++}`;
}

function configuredLocator(namespace: string, index: number): string {
  return `${CONFIGURED_LOCATOR_PREFIX}${namespace}/${index}`;
}

/** Stable editor identities outlive array compaction after a pill is deleted. */
export function configuredReferenceLocatorMap(
  references: readonly ConfiguredPromptReference[],
  namespace: string,
): Map<string, ConfiguredPromptReference> {
  return new Map(
    references.map((reference, index) => [
      configuredLocator(namespace, index),
      reference,
    ]),
  );
}

export function buildConfiguredEditorValue(
  prompt: string,
  references: readonly ConfiguredPromptReference[],
  namespace: string,
): ReturnType<typeof buildEditorValueFromMessage> {
  return buildEditorValueFromMessage(
    prompt,
    references.map((ref, index) => ({
      displayPath: ref.displayText,
      absolutePath: configuredLocator(namespace, index),
      textStart: ref.textStart,
      ...(ref.kind === 'plugin' ? { kind: PLUGIN_MENTION_KIND } : {}),
    })),
  );
}

function fileRoot(
  file: FileMentionOption,
  repos: readonly RepoFileIndex[],
  target: HomeDiscoveryTarget | undefined,
): Extract<ConfiguredPromptReference, { kind: 'file' }>['root'] {
  const repo = repos.find((entry) => entry.repoId === file.repoId);
  if (target?.kind !== 'cowork' && target?.repoId === file.repoId) {
    return { kind: 'repo', repoId: file.repoId };
  }
  return repos.filter((entry) => entry.rootKind !== 'attachments').length <=
    1 ||
    repo?.rootKind === 'workspace-root' ||
    repo?.rootKind === 'standalone'
    ? { kind: 'workspace' }
    : { kind: 'repo', repoId: file.repoId };
}

export function configuredFileReference(
  file: FileMentionOption,
  repos: readonly RepoFileIndex[],
  target: HomeDiscoveryTarget | undefined,
): Extract<ConfiguredPromptReference, { kind: 'file' }> | null {
  if (
    file.isAttachment ||
    file.kind ||
    !repos.some(
      (repo) =>
        repo.rootKind !== 'attachments' &&
        repo.repoId === file.repoId &&
        repo.files.some(
          (entry) =>
            entry.absolutePath === file.absolutePath &&
            entry.relativePath === file.relativePath,
        ),
    )
  )
    return null;
  return {
    kind: 'file',
    textStart: 0,
    displayText: buildFileReferenceDisplayPath(file, repos.length),
    root: fileRoot(file, repos, target),
    relativePath: file.relativePath,
  };
}

export function resolveConfiguredEditorReferences(args: {
  fileReferences: readonly SerializedFileReference[];
  repos: readonly RepoFileIndex[];
  target?: HomeDiscoveryTarget;
  /** Editor-local stable identity, retained across deletes, undo, and target changes. */
  referenceByLocator?: Map<string, ConfiguredPromptReference>;
  portablePluginRef?: (
    marketplaceId: string,
    pluginName: string,
  ) => Extract<ConfiguredPromptReference, { kind: 'plugin' }>['plugin'] | null;
}): ConfiguredPromptReference[] {
  return args.fileReferences.map((ref) => {
    const textStart = ref.textStart ?? 0;
    const remembered = args.referenceByLocator?.get(ref.absolutePath);
    if (remembered) {
      const next = { ...remembered, textStart, displayText: ref.displayPath };
      args.referenceByLocator?.set(ref.absolutePath, next);
      return next;
    }
    if (ref.absolutePath.startsWith(CONFIGURED_LOCATOR_PREFIX)) {
      throw new Error(
        'This reference came from another composer. Remove it and insert the file here.',
      );
    }
    if (ref.kind === PLUGIN_MENTION_KIND) {
      const plugin = parsePluginMentionAbsolutePath(ref.absolutePath);
      if (!plugin) throw new Error('The plugin reference is invalid.');
      const next: ConfiguredPromptReference = {
        kind: 'plugin' as const,
        textStart,
        displayText: ref.displayPath,
        plugin: args.portablePluginRef?.(
          plugin.marketplaceId,
          plugin.pluginName,
        ) ?? {
          kind: 'installed' as const,
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
        },
      };
      args.referenceByLocator?.set(ref.absolutePath, next);
      return next;
    }
    for (const repo of args.repos) {
      const file = repo.files.find(
        (entry) => entry.absolutePath === ref.absolutePath,
      );
      if (!file) continue;
      const option: FileMentionOption = {
        repoId: repo.repoId,
        repoName: repo.repoName,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        filename: file.filename,
      };
      const configured = configuredFileReference(
        option,
        args.repos,
        args.target,
      );
      if (configured) {
        const next = { ...configured, textStart, displayText: ref.displayPath };
        args.referenceByLocator?.set(ref.absolutePath, next);
        return next;
      }
    }
    throw new Error(`The file reference ${ref.displayPath} is unavailable.`);
  });
}

export function unresolvedConfiguredFiles(
  references: readonly ConfiguredPromptReference[],
  repos: readonly RepoFileIndex[],
): ConfiguredPromptReference[] {
  return references.filter((ref) => {
    if (ref.kind !== 'file') return false;
    return !repos.some(
      (repo) =>
        (ref.root.kind === 'workspace'
          ? repo.rootKind === 'workspace-root' ||
            repo.rootKind === 'standalone' ||
            repos.filter((entry) => entry.rootKind !== 'attachments').length ===
              1
          : repo.repoId === ref.root.repoId) &&
        repo.files.some((file) => file.relativePath === ref.relativePath),
    );
  });
}
