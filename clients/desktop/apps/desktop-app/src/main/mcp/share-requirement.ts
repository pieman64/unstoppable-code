import { readFile } from 'node:fs/promises';
import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';
import {
  isMcpServersIndexFile,
  type McpServerRef,
} from '@canopy/execution-engine/types/mcp-servers';
import { getMcpServersIndexFilePath } from '../lib/paths';

interface PortableMcpMetadata {
  name: string;
  curatedKey?: string;
}

type PortableMcpMetadataLookup = (
  serverId: string,
) => Promise<PortableMcpMetadata | undefined>;

async function readPortableMcpMetadata(
  serverId: string,
): Promise<PortableMcpMetadata | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(getMcpServersIndexFilePath(), 'utf8'),
    );
    if (!isMcpServersIndexFile(value)) return undefined;
    const entry = value.servers.find((candidate) => candidate.id === serverId);
    return entry
      ? {
          name: entry.name,
          ...(entry.curatedKey ? { curatedKey: entry.curatedKey } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project one machine-local MCP selection into public package metadata. Only
 * the curated key or display name crosses the share boundary; config ids,
 * commands, URLs, and credentials never do.
 */
export async function mcpSelectionToEnvironmentRequirement(
  selection: McpServerRef,
  lookup: PortableMcpMetadataLookup = readPortableMcpMetadata,
): Promise<PipelinePackageEnvironmentRequirement> {
  const metadata = await lookup(selection.serverId);
  const displayName =
    metadata?.curatedKey ?? metadata?.name ?? selection.serverId;
  const setupName = metadata?.name ?? displayName;
  return {
    id: `mcp:${metadata?.curatedKey ?? selection.serverId}`,
    kind: 'mcp',
    displayName,
    required: true,
    affectedSteps: [],
    setupHint: `Connect ${setupName} in Settings.`,
  };
}

export async function mcpSelectionToPortableIdentity(
  selection: McpServerRef,
  lookup: PortableMcpMetadataLookup = readPortableMcpMetadata,
): Promise<{ name: string; catalogId?: string }> {
  const metadata = await lookup(selection.serverId);
  return {
    name: metadata?.name ?? selection.serverId,
    ...(metadata?.curatedKey ? { catalogId: metadata.curatedKey } : {}),
  };
}
