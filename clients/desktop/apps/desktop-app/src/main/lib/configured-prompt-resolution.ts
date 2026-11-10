import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  AgentProviderType,
  ChatTabPluginSelections,
  ConfiguredPromptReference,
  FileReference,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import { validateConfiguredPromptReferences } from '@canopy/protocol/configured-prompt-references';
import { getShareablePluginRefKey } from '@canopy/execution-engine/plugin-refs';
import {
  buildPluginMentionAbsolutePath,
  PLUGIN_MENTION_KIND,
} from '@canopy/desktop-shared/lib/plugin-mention';
import type { FileTreeRoot } from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';

type ConfiguredPromptFilesystemDispatcher = Pick<
  DesktopCanopyDispatcher,
  'queryFileTreeRootsForLegacyIpc'
>;

let filesystemDispatcher: ConfiguredPromptFilesystemDispatcher | null = null;

/** The host supplies the already-running canonical filesystem dispatcher. */
export function bindConfiguredPromptFilesystemDispatcher(
  dispatcher: ConfiguredPromptFilesystemDispatcher | null,
): void {
  filesystemDispatcher = dispatcher;
}

async function readExecutionRoots(
  projectId: string,
  worktreeId: string,
): Promise<FileTreeRoot[]> {
  if (!filesystemDispatcher)
    throw new Error('Filesystem runtime is unavailable.');
  const { legacyResult } =
    await filesystemDispatcher.queryFileTreeRootsForLegacyIpc(
      { scope: { workspaceId: projectId, worktreeId } },
      {
        caller: {
          principalId: 'desktop-configured-prompt',
          clientInstanceId: 'desktop-main',
          authorityId: 'desktop-local',
          interfaceKind: 'daemon',
          grants: ['worker.filesystem.read'],
        },
      },
    );
  return legacyResult.roots;
}

/** Bind durable prompt occurrences to the live target immediately before dispatch. */
export async function resolveConfiguredPrompt(args: {
  projectId: string;
  worktreeId: string;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  selectedRepoId?: string;
  prompt: string;
  promptReferences?: readonly ConfiguredPromptReference[];
  interpolateText?: (text: string) => string;
}): Promise<{
  prompt: string;
  fileReferences?: FileReference[];
  referencedPluginSelections?: ChatTabPluginSelections;
}> {
  const { promptReferences: references } = args;
  const error = validateConfiguredPromptReferences(args.prompt, references);
  if (error) throw new Error(error);
  if (!references?.length) {
    return { prompt: args.interpolateText?.(args.prompt) ?? args.prompt };
  }

  const roots = await readExecutionRoots(args.projectId, args.worktreeId);
  const cwd = resolveWorktreeCwd(
    args.projectId,
    args.worktreeId,
    args.selectedRepoId,
  );
  const fileReferences: FileReference[] = [];
  const referencedPluginSelections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  const pieces: string[] = [];
  let cursor = 0;
  let textLength = 0;
  const portableRefs = references.flatMap((ref) =>
    ref.kind === 'plugin' && ref.plugin.kind === 'portable'
      ? [ref.plugin.ref]
      : [],
  );
  const hasPluginRefs = references.some((ref) => ref.kind === 'plugin');
  const catalog = hasPluginRefs
    ? await loadShareablePluginCatalog()
    : undefined;
  // Keep the plugin resolver out of file-only sends. Electron bundles this
  // dynamic import as a main-process chunk; production builds must retain it.
  const pluginAvailability = hasPluginRefs
    ? await import('../plugins/plugin-resolver')
    : undefined;
  const portableMatches =
    portableRefs.length && catalog
      ? resolveShareablePluginRefs(portableRefs, catalog)
      : [];
  const portableMatchesByKey = new Map(
    portableMatches.map((match) => [
      getShareablePluginRefKey(match.ref),
      match,
    ]),
  );

  for (const ref of references) {
    const plainText =
      args.interpolateText?.(args.prompt.slice(cursor, ref.textStart)) ??
      args.prompt.slice(cursor, ref.textStart);
    pieces.push(plainText);
    textLength += plainText.length;
    let displayPath = ref.displayText;
    let absolutePath: string;
    let kind: string | undefined;
    let repoName: string | undefined;
    if (ref.kind === 'file') {
      const repoId = ref.root.kind === 'repo' ? ref.root.repoId : undefined;
      const root = repoId
        ? roots.find(
            (candidate) =>
              candidate.repoId === repoId && candidate.rootKind === 'git-repo',
          )
        : (roots.find((candidate) => candidate.rootKind === 'workspace-root') ??
          roots.find((candidate) => candidate.rootKind === 'git-repo') ??
          roots.find((candidate) => candidate.absolutePath === cwd));
      if (!root)
        throw new Error(
          'A referenced repository is unavailable at the execution target.',
        );
      const rootReal = await realpath(root.absolutePath);
      absolutePath = join(root.absolutePath, ref.relativePath);
      const targetReal = await realpath(absolutePath).catch(() => {
        throw new Error(`Referenced file is missing: ${ref.relativePath}`);
      });
      if (
        targetReal !== rootReal &&
        !targetReal.startsWith(`${rootReal}${sep}`)
      ) {
        throw new Error(
          `Referenced file escapes its root: ${ref.relativePath}`,
        );
      }
      const targetStat = await stat(targetReal);
      if (!targetStat.isFile())
        throw new Error(`Referenced path is not a file: ${ref.relativePath}`);
      const relativeToCwd = relative(cwd, absolutePath);
      displayPath =
        relativeToCwd &&
        !relativeToCwd.startsWith(`..${sep}`) &&
        relativeToCwd !== '..' &&
        !isAbsolute(relativeToCwd)
          ? relativeToCwd.split(sep).join('/')
          : absolutePath;
      repoName = ref.root.kind === 'repo' ? root.repoName : undefined;
    } else {
      const pluginRef = ref.plugin;
      let selected: { marketplaceId: string; pluginName: string };
      if (pluginRef.kind === 'installed') {
        const marketplace = catalog?.marketplaces.find(
          (candidate) => candidate.id === pluginRef.marketplaceId,
        );
        const plugin = marketplace?.plugins.find(
          (candidate) => candidate.name === pluginRef.pluginName,
        );
        if (!marketplace || !plugin)
          throw new Error(
            `Referenced plugin is unavailable: ${ref.displayText}`,
          );
        selected = { marketplaceId: marketplace.id, pluginName: plugin.name };
      } else {
        const match = portableMatchesByKey.get(
          getShareablePluginRefKey(pluginRef.ref),
        );
        if (
          !match ||
          match.matchState !== 'matched' ||
          match.selection.kind !== 'plugin'
        ) {
          throw new Error(
            `Referenced plugin is unavailable: ${ref.displayText}`,
          );
        }
        selected = match.selection;
      }
      // Ollama is a model source, not an execution harness. Without the
      // resolved harness, accepting a Claude facet could silently omit it
      // from a Codex-backed Ollama turn.
      const pluginProvider =
        args.executionHarness ??
        (args.providerType === 'ollama' ? undefined : args.providerType);
      if (
        !catalog ||
        !pluginProvider ||
        !pluginAvailability ||
        !(await pluginAvailability.isConfiguredPromptPluginUsable(
          selected,
          catalog.marketplaces,
          pluginProvider,
        ))
      ) {
        throw new Error(`Referenced plugin is unavailable: ${ref.displayText}`);
      }
      absolutePath = buildPluginMentionAbsolutePath(selected);
      kind = PLUGIN_MENTION_KIND;
      referencedPluginSelections.pluginRefs.push(selected);
    }
    pieces.push(displayPath);
    fileReferences.push({
      displayPath,
      absolutePath,
      textStart: textLength,
      ...(kind ? { kind } : {}),
      ...(repoName ? { repoName } : {}),
    });
    textLength += displayPath.length;
    cursor = ref.textStart + ref.displayText.length;
  }
  pieces.push(
    args.interpolateText?.(args.prompt.slice(cursor)) ??
      args.prompt.slice(cursor),
  );
  return {
    prompt: pieces.join(''),
    fileReferences,
    ...(referencedPluginSelections.pluginRefs.length
      ? { referencedPluginSelections }
      : {}),
  };
}
