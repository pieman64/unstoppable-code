import { createHash } from 'node:crypto';
import type { InheritedPluginBinding } from '../../plugins/plugin-resolver';
import {
  parseFrontmatter,
  projectClaudePluginForCodex,
} from '@canopy/plugin-interop';
import type {
  MaterializedCapabilityOverlay,
  RetainedHomeCapability,
  AgentMcpSelection,
  AgentMcpHttpAuthPin,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type {
  CursorCapabilityProjection,
  CursorInvocationSource,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import type { NativeDelegationFiles } from '@canopy/desktop-shared/node/delegation/file-access';
import {
  readDelegationCapabilityTree,
  validateSkillInstructions,
  memberName,
} from './agent-projection';
import { openDelegationFiles } from './file-process';

function member(
  source: CursorInvocationSource | undefined,
  inherited: readonly InheritedPluginBinding[],
): Omit<RetainedHomeCapability, 'root'> | undefined {
  if (
    (source?.kind === 'plugin_skill' || source?.kind === 'plugin_command') &&
    inherited.some(
      (ref) =>
        ref.marketplaceId === source.marketplaceId &&
        ref.pluginName === source.pluginName,
    )
  )
    return {
      kind: 'plugin',
      name: source.pluginName,
      origin: 'claude',
      pluginRef: {
        marketplaceId: source.marketplaceId,
        pluginName: source.pluginName,
      },
    };
  if (
    source?.kind !== 'inherited_skill' &&
    source?.kind !== 'inherited_command'
  )
    return undefined;
  return {
    kind: source.kind === 'inherited_skill' ? 'skill' : 'command',
    name: source.name,
    origin: source.origin,
  };
}

/** Freeze only successfully materialized private copies, before a parent tool call. */
export async function captureHomeCapabilities(input: {
  root: string;
  projection: CursorCapabilityProjection;
  inheritedPluginBindings?: readonly InheritedPluginBinding[];
  prepared: { skillIds: readonly string[]; commandIds: readonly string[] };
  signal: AbortSignal;
  open?: (
    root: string,
    signal: AbortSignal,
  ) => Promise<Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>>;
}): Promise<{
  overlay: MaterializedCapabilityOverlay | undefined;
  skipped: readonly string[];
}> {
  input.signal.throwIfAborted();
  const candidates = [
    ...input.projection.skills
      .filter((item) => input.prepared.skillIds.includes(item.id))
      .map((item) => ({
        id: item.id,
        skill: true,
        entry: member(item.source, input.inheritedPluginBindings ?? []),
      })),
    ...input.projection.commands
      .filter((item) => input.prepared.commandIds.includes(item.id))
      .map((item) => ({
        id: item.id,
        skill: false,
        entry: member(item.source, input.inheritedPluginBindings ?? []),
      })),
  ].filter((item) => item.entry !== undefined);
  if (
    !candidates.length &&
    !input.inheritedPluginBindings?.some((item) => item.mcpServers.length)
  )
    return { overlay: undefined, skipped: [] };
  const files: Record<string, string> = {};
  const entries: RetainedHomeCapability[] = [];
  const skipped: string[] = [];
  const skillNames: string[] = [];
  const roots: string[] = [];
  let reader:
    | Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>
    | undefined;
  const open =
    input.open ??
    ((
      root,
      signal,
    ): Promise<Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>> =>
      openDelegationFiles(root, signal, {
        fileBytes: 1_048_576,
        totalBytes: 1_048_576,
      }));
  try {
    if (candidates.length) reader = await open(input.root, input.signal);
    input.signal.throwIfAborted();
    for (const candidate of candidates) {
      const entry = candidate.entry;
      if (!entry) continue;
      input.signal.throwIfAborted();
      try {
        if (
          entries.length >= 64 ||
          !/^[a-zA-Z0-9_-]+$/.test(candidate.id) ||
          entry.name.length === 0 ||
          entry.name.length > 200 ||
          /[\\/\0\r\n:]/.test(entry.name) ||
          entry.name === '.' ||
          entry.name === '..'
        )
          throw new Error('Home capability cannot be retained');
        const retainedRoot = `home/${candidate.id}`;
        const content = new Map<string, string>();
        let invocationName = candidate.id;
        if (candidate.skill) {
          const prefix = `skills/${candidate.id}/`;
          const activeReader = reader;
          if (!activeReader) throw new Error('Capability reader unavailable');
          const members = await readDelegationCapabilityTree(
            input.root,
            (): Promise<
              Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>
            > =>
              Promise.resolve({
                list: async (
                  directory,
                ): Promise<
                  Awaited<ReturnType<NativeDelegationFiles['list']>>
                > =>
                  (
                    await activeReader.list(
                      `skills/${candidate.id}${directory ? `/${directory}` : ''}`,
                    )
                  ).map((item) => {
                    if (!item.path.startsWith(prefix))
                      throw new Error('Unexpected capability member');
                    return { ...item, path: item.path.slice(prefix.length) };
                  }),
                read: (file): ReturnType<NativeDelegationFiles['read']> =>
                  activeReader.read(prefix + file),
                close: (): Promise<void> => Promise.resolve(),
              }),
          );
          const declared = parseFrontmatter(
            members.get('SKILL.md') ?? '',
          )?.name;
          if (typeof declared === 'string')
            invocationName = memberName(declared);
          for (const [file, text] of Array.from(members))
            content.set(`skills/${candidate.id}/${file}`, text);
        } else {
          if (!reader) throw new Error('Capability reader unavailable');
          content.set(
            `commands/${candidate.id}.md`,
            await reader.read(`commands/${candidate.id}.md`),
          );
        }
        input.signal.throwIfAborted();
        // Both host adapters receive the same retained text. Native ambient
        // settings and executable plugin hooks are never part of this copy.
        const declaration = candidate.skill
          ? { skills: './skills' }
          : { commands: './commands' };
        validateSkillInstructions(content, declaration);
        const manifest = JSON.stringify({ name: candidate.id, ...declaration });
        content.set('.claude-plugin/plugin.json', manifest);
        const codex = projectClaudePluginForCodex({
          pluginName: candidate.id,
          category: 'local',
          manifest: { name: candidate.id, ...declaration },
          rawManifest: { name: candidate.id, ...declaration },
          files: content,
          includeMcpServers: false,
        });
        if (codex.warnings.length)
          throw new Error('Home capability cannot be projected');
        for (const [file, text] of Array.from(codex.files)) {
          if (typeof text !== 'string')
            throw new Error('Home capability contains binary content');
          content.set(file, text);
        }
        content.set('.claude-plugin/plugin.json', manifest);
        const addition = Object.fromEntries(
          Array.from(content).map(([file, text]) => [
            `${retainedRoot}/${file}`,
            text,
          ]),
        );
        if (
          Object.keys(addition).some((file) =>
            Object.prototype.hasOwnProperty.call(files, file),
          ) ||
          Object.keys(files).length + Object.keys(addition).length > 256 ||
          Buffer.byteLength(JSON.stringify({ ...files, ...addition }), 'utf8') >
            900_000
        )
          throw new Error('Home capability exceeds retained limits');
        Object.assign(files, addition);
        entries.push({ ...entry, root: retainedRoot });
        roots.push(retainedRoot);
        skillNames.push(`${candidate.id}:${invocationName}`);
      } catch {
        input.signal.throwIfAborted();
        skipped.push(entry.name);
      }
    }
  } catch {
    input.signal.throwIfAborted();
    return {
      overlay: undefined,
      skipped: candidates.flatMap((item) =>
        item.entry ? [item.entry.name] : [],
      ),
    };
  } finally {
    await reader?.close().catch(() => undefined);
  }
  const mcpSelections: AgentMcpSelection[] = [];
  const mcpHttpAuthPreferences: AgentMcpHttpAuthPin[] = [];
  for (const binding of input.inheritedPluginBindings ?? []) {
    input.signal.throwIfAborted();
    if (!binding.mcpServers.length) continue;
    if (mcpSelections.length + binding.mcpServers.length > 128) {
      skipped.push(binding.pluginName);
      continue;
    }
    const match = entries.find(
      (entry) =>
        entry.pluginRef?.marketplaceId === binding.marketplaceId &&
        entry.pluginRef.pluginName === binding.pluginName,
    );
    let root = match?.root;
    if (!root) {
      if (entries.length >= 64 || Object.keys(files).length >= 254) {
        skipped.push(binding.pluginName);
        continue;
      }
      const id = `inherited-${createHash('sha256')
        .update(JSON.stringify([binding.marketplaceId, binding.pluginName]))
        .digest('hex')
        .slice(0, 24)}`;
      root = `home/${id}`;
      const manifest = { name: id };
      const projected = projectClaudePluginForCodex({
        pluginName: id,
        category: 'local',
        manifest,
        rawManifest: manifest,
        files: new Map([
          ['.claude-plugin/plugin.json', JSON.stringify(manifest)],
        ]),
        includeMcpServers: false,
      });
      if (projected.warnings.length) {
        skipped.push(binding.pluginName);
        continue;
      }
      const addition: Record<string, string> = {};
      for (const [file, text] of Array.from(projected.files)) {
        if (typeof text !== 'string')
          throw new Error('Unexpected plugin projection');
        addition[`${root}/${file}`] = text;
      }
      addition[`${root}/.claude-plugin/plugin.json`] = JSON.stringify(manifest);
      if (
        Object.keys(addition).some((file) =>
          Object.prototype.hasOwnProperty.call(files, file),
        ) ||
        Object.keys(files).length + Object.keys(addition).length > 256 ||
        Buffer.byteLength(JSON.stringify({ ...files, ...addition }), 'utf8') >
          900_000
      ) {
        skipped.push(binding.pluginName);
        continue;
      }
      Object.assign(files, addition);
      entries.push({
        root,
        kind: 'plugin',
        name: binding.pluginName,
        origin: 'claude',
        pluginRef: {
          marketplaceId: binding.marketplaceId,
          pluginName: binding.pluginName,
        },
      });
      roots.push(root);
    }
    const retainedRoot = root;
    mcpSelections.push(
      ...binding.mcpServers.map(
        (server): AgentMcpSelection => ({
          source: 'inherited-plugin',
          root: retainedRoot,
          installationDigest: binding.installationDigest,
          marketplaceId: binding.marketplaceId,
          pluginName: binding.pluginName,
          ...server,
        }),
      ),
    );
    mcpHttpAuthPreferences.push(...binding.mcpHttpAuthPreferences);
  }
  return {
    overlay: entries.length
      ? {
          version: 3,
          pluginFiles: files,
          capabilities: {
            claudePluginRoots: roots,
            codexCapabilityRoots: roots,
            claudeSkillNames: skillNames,
            mcpSelections,
            mcpHttpAuthPreferences,
            hookDeclarations: [],
          },
          provenance: {
            roots: Object.fromEntries(roots.map((root) => [root, 'inherited'])),
            mcpSelections: mcpSelections.map(() => 'inherited'),
          },
          items: [],
          homeEntries: entries,
        }
      : undefined,
    skipped,
  };
}
