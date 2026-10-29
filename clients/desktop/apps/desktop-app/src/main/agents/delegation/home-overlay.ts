import type {
  CapabilityOverlayInput,
  MaterializedCapabilityOverlay,
  RetainedHomeCapability,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import { DelegationAgentCapabilityError } from './agent-capability-error';

/** Keep only the direct parent's frozen home roots, excluding its other layers. */
export function selectHomeCapabilityOverlay(
  overlay: MaterializedCapabilityOverlay | undefined,
): MaterializedCapabilityOverlay | undefined {
  if (!overlay?.homeEntries?.length) return undefined;
  const entries = overlay.homeEntries;
  const roots = new Set(entries.map((entry) => entry.root));
  if (
    entries.some(
      (entry) => overlay.provenance.roots[entry.root] !== 'inherited',
    )
  )
    throw new DelegationAgentCapabilityError('invalid_projection');
  const names = new Set(
    entries.map((entry) => entry.root.slice(entry.root.lastIndexOf('/') + 1)),
  );
  const inheritedMcp = overlay.capabilities.mcpSelections.filter(
    (selection, index) =>
      selection.source === 'inherited-plugin' &&
      roots.has(selection.root) &&
      overlay.provenance.mcpSelections[index] === 'inherited',
  );
  const inheritedAuth = overlay.capabilities.mcpHttpAuthPreferences.filter(
    ({ target }) =>
      target.kind === 'plugin' &&
      inheritedMcp.some(
        (selection) =>
          selection.source === 'inherited-plugin' &&
          selection.marketplaceId === target.marketplaceId &&
          selection.pluginName === target.pluginName &&
          selection.serverName === target.serverName,
      ),
  );
  return {
    version: 3,
    pluginFiles: Object.fromEntries(
      Object.entries(overlay.pluginFiles).filter(([file]) =>
        entries.some((entry) => file.startsWith(`${entry.root}/`)),
      ),
    ),
    capabilities: {
      claudePluginRoots: overlay.capabilities.claudePluginRoots.filter((root) =>
        roots.has(root),
      ),
      codexCapabilityRoots: overlay.capabilities.codexCapabilityRoots.filter(
        (root) => roots.has(root),
      ),
      claudeSkillNames: overlay.capabilities.claudeSkillNames.filter((name) =>
        names.has(name.split(':')[0]),
      ),
      mcpSelections: inheritedMcp,
      mcpHttpAuthPreferences: inheritedAuth,
      hookDeclarations: [],
    },
    provenance: {
      roots: Object.fromEntries(
        entries.map((entry) => [entry.root, 'inherited']),
      ),
      mcpSelections: inheritedMcp.map(() => 'inherited'),
    },
    items: [],
    homeEntries: entries,
  };
}

/** Add frozen content without overwriting an Agent or explicit selection. */
function combineHomeCapabilityOverlay(
  selected: CapabilityOverlayInput | undefined,
  home: MaterializedCapabilityOverlay | undefined,
): CapabilityOverlayInput | undefined {
  const inheritedHome =
    home && selected
      ? selectHomeCapabilityOverlay({
          ...home,
          homeEntries: home.homeEntries?.filter(
            (entry) =>
              !entry.pluginRef ||
              !selected.items.some(
                (item) =>
                  item.ref.kind === 'plugin' &&
                  item.ref.marketplaceId === entry.pluginRef?.marketplaceId &&
                  item.ref.pluginName === entry.pluginRef.pluginName,
              ),
          ),
        })
      : home;
  if (!inheritedHome?.homeEntries?.length) return selected;
  if (!selected) return inheritedHome;
  if (
    Object.keys(inheritedHome.pluginFiles).some((file) =>
      Object.prototype.hasOwnProperty.call(selected.pluginFiles, file),
    ) ||
    Object.keys(inheritedHome.provenance.roots).some((root) =>
      Object.keys(selected.provenance.roots).some(
        (other) =>
          root === other ||
          root.startsWith(`${other}/`) ||
          other.startsWith(`${root}/`),
      ),
    )
  )
    throw new DelegationAgentCapabilityError('invalid_projection');
  const result: CapabilityOverlayInput = {
    pluginFiles: { ...selected.pluginFiles, ...inheritedHome.pluginFiles },
    capabilities: {
      claudePluginRoots: [
        ...selected.capabilities.claudePluginRoots,
        ...inheritedHome.capabilities.claudePluginRoots,
      ],
      codexCapabilityRoots: [
        ...selected.capabilities.codexCapabilityRoots,
        ...inheritedHome.capabilities.codexCapabilityRoots,
      ],
      claudeSkillNames: [
        ...selected.capabilities.claudeSkillNames,
        ...inheritedHome.capabilities.claudeSkillNames,
      ],
      mcpSelections: [
        ...selected.capabilities.mcpSelections,
        ...inheritedHome.capabilities.mcpSelections,
      ],
      mcpHttpAuthPreferences: [
        ...selected.capabilities.mcpHttpAuthPreferences,
        ...inheritedHome.capabilities.mcpHttpAuthPreferences,
      ],
      hookDeclarations: selected.capabilities.hookDeclarations,
    },
    provenance: {
      roots: {
        ...selected.provenance.roots,
        ...inheritedHome.provenance.roots,
      },
      mcpSelections: [
        ...selected.provenance.mcpSelections,
        ...inheritedHome.provenance.mcpSelections,
      ],
    },
    items: selected.items,
    homeEntries: inheritedHome.homeEntries,
  };
  return result;
}

/** Preserve explicit choices and admit optional home entries within the same artifact limits. */
export function mergeHomeCapabilityOverlay(
  selected: CapabilityOverlayInput | undefined,
  home: MaterializedCapabilityOverlay | undefined,
  onSkipped?: (entry: RetainedHomeCapability) => void,
): CapabilityOverlayInput | undefined {
  if (!home?.homeEntries?.length)
    return combineHomeCapabilityOverlay(selected, home);
  let result: CapabilityOverlayInput | undefined = selected;
  for (const entry of home.homeEntries) {
    const candidate = combineHomeCapabilityOverlay(
      result,
      selectHomeCapabilityOverlay({ ...home, homeEntries: [entry] }),
    );
    if (!candidate || candidate === result) continue;
    // Keep roots already admitted on earlier iterations, along with this entry.
    const combined = {
      ...candidate,
      homeEntries: [
        ...(result?.homeEntries ?? []),
        ...(candidate.homeEntries ?? []),
      ],
    };
    if (
      Object.keys(combined.pluginFiles).length > 256 ||
      Buffer.byteLength(JSON.stringify({ ...combined, version: 3 }), 'utf8') >
        1_048_576 ||
      combined.capabilities.claudePluginRoots.length > 64 ||
      combined.capabilities.codexCapabilityRoots.length > 64 ||
      combined.capabilities.claudeSkillNames.length > 128 ||
      combined.capabilities.mcpSelections.length > 128 ||
      combined.capabilities.mcpHttpAuthPreferences.length > 128 ||
      combined.homeEntries.length > 64
    ) {
      onSkipped?.(entry);
      continue;
    }
    result = combined;
  }
  return result;
}

/** Legacy/unclassified files cannot gain reload authority from one home marker. */
export function isHomeOnlyCapabilityOverlay(
  current: MaterializedCapabilityOverlay,
  home: MaterializedCapabilityOverlay | undefined,
): boolean {
  return (
    home !== undefined &&
    current.items.length === 0 &&
    Object.keys(current.pluginFiles).length ===
      Object.keys(home.pluginFiles).length &&
    current.capabilities.claudePluginRoots.length ===
      home.capabilities.claudePluginRoots.length &&
    current.capabilities.codexCapabilityRoots.length ===
      home.capabilities.codexCapabilityRoots.length &&
    current.capabilities.claudeSkillNames.length ===
      home.capabilities.claudeSkillNames.length &&
    current.capabilities.mcpSelections.length ===
      home.capabilities.mcpSelections.length &&
    current.capabilities.hookDeclarations.length === 0
  );
}
