import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { McpHttpAuthPreference } from '@canopy/protocol/mcp-servers';
import {
  DELEGATION_CAPABILITY_SOURCES,
  type DelegationCapabilitySource,
} from '@canopy/protocol/delegation';
import { isMcpHttpAuthHandler } from '../../lib/mcp-http-auth';
import { isDelegationCapabilityId } from './capability-grant';
import type {
  ResolvedAgentOverlaySnapshot,
  ResolvedCapabilityOverlaySnapshot,
} from './types';
import { windowsNameAlias } from './file-access';
import { assertPrivateDirectoryAcl, renameWithRetry } from './private-storage';

export type AgentProjectionToolName = 'read' | 'search';

export type AgentMcpSelection =
  | {
      readonly source: 'standalone';
      readonly serverId: string;
      readonly configId: string;
      readonly configDigest: string;
    }
  | {
      /** An account connection, selected by server key and config. */
      readonly source: 'account';
      readonly serverId: string;
      readonly configId: string;
      readonly configDigest: string;
    }
  | (PluginMcpIdentity & { readonly source: 'plugin' })
  | (PluginMcpIdentity & {
      readonly source: 'inherited-plugin';
      readonly installationDigest: string;
    });

interface PluginMcpIdentity {
  readonly marketplaceId: string;
  readonly pluginName: string;
  readonly serverName: string;
  readonly root: string;
  readonly configDigest: string;
}

/**
 * A pinned HTTP auth handler for one MCP target in a delegated child. The
 * parent pins every effective handler so the child resolves each server as
 * the parent did; `source` records whether the user chose it (`override`) or
 * it was the inherited default (`default`), so a curated plugin member pinned
 * to a default can still bind to its connection (REG-3033). Absent on pins
 * written before provenance existed, which read as overrides.
 */
export type AgentMcpHttpAuthPin = McpHttpAuthPreference & {
  readonly source?: 'override' | 'default';
};

export interface AgentCapabilitySnapshot {
  readonly claudePluginRoots: readonly string[];
  readonly claudeSkillNames: readonly string[];
  readonly codexCapabilityRoots: readonly string[];
  readonly mcpSelections: readonly AgentMcpSelection[];
  readonly mcpHttpAuthPreferences: readonly AgentMcpHttpAuthPin[];
  readonly hookDeclarations: readonly { root: string; path: string }[];
}

/** The normalized empty capability snapshot used by legacy Agent artifacts. */
export const EMPTY_AGENT_CAPABILITIES: AgentCapabilitySnapshot = Object.freeze({
  claudePluginRoots: Object.freeze([]),
  claudeSkillNames: Object.freeze([]),
  codexCapabilityRoots: Object.freeze([]),
  mcpSelections: Object.freeze([]),
  mcpHttpAuthPreferences: Object.freeze([]),
  hookDeclarations: Object.freeze([]),
});

export interface MaterializedAgentProjection {
  readonly version: 1 | 2;
  readonly agentDefinitionId: string;
  readonly agentDefinitionRevision: string;
  readonly agentDefinitionHash: string;
  readonly systemPromptAppend: string;
  readonly pluginFiles: Readonly<Record<string, string>>;
  readonly toolNames: readonly AgentProjectionToolName[];
  /** Absent only on verified version-one artifacts. */
  readonly capabilities?: AgentCapabilitySnapshot;
}

export type AgentProjectionInput = Omit<MaterializedAgentProjection, 'version'>;

/** Host-private source identity of one capability item. */
export type CapabilityItemRef =
  | {
      readonly kind: 'skill';
      readonly sourceId: string;
      readonly skillName: string;
    }
  | {
      readonly kind: 'plugin';
      readonly marketplaceId: string;
      readonly pluginName: string;
    }
  | {
      readonly kind: 'mcp';
      readonly serverId: string;
      readonly configId: string;
    };

/** One included item of a capability overlay. */
export interface CapabilityOverlayItem {
  /** Deferred-tools catalog ref, `deferred:v1:<base64url sha256>`. */
  readonly id: string;
  /** Display name (no path). */
  readonly name: string;
  readonly source: DelegationCapabilitySource;
  readonly ref: CapabilityItemRef;
}

/** Which layer contributed each root and MCP selection. */
export interface CapabilityOverlayProvenance {
  /** Layer of each root in `claudePluginRoots` / `codexCapabilityRoots`. */
  readonly roots: Readonly<Record<string, DelegationCapabilitySource>>;
  /** Layer of each `capabilities.mcpSelections` entry, index-aligned. */
  readonly mcpSelections: readonly DelegationCapabilitySource[];
}

/** Home members captured from a parent's effective private capability copy. */
export interface RetainedHomeCapability {
  readonly pluginRef?: {
    readonly marketplaceId: string;
    readonly pluginName: string;
  };
  readonly root: string;
  readonly kind: 'skill' | 'command' | 'plugin';
  readonly name: string;
  readonly origin:
    | 'cursor'
    | 'claude'
    | 'codex'
    | 'grok'
    | 'agents'
    | 'cursor-plugin';
}

/** Version 3: content-addressed capabilities, independent of Agent identity. */
export interface MaterializedCapabilityOverlay {
  readonly version: 3;
  readonly pluginFiles: Readonly<Record<string, string>>;
  readonly capabilities: AgentCapabilitySnapshot;
  readonly provenance: CapabilityOverlayProvenance;
  /** Included items with source refs; empty on mapped legacy artifacts. */
  readonly items: readonly CapabilityOverlayItem[];
  /** No live catalog ref: these bytes came from the direct parent's turn. */
  readonly homeEntries?: readonly RetainedHomeCapability[];
}

export type CapabilityOverlayInput = Omit<
  MaterializedCapabilityOverlay,
  'version'
>;

const MAX_ARTIFACT_BYTES = 1_048_576;
const MAX_MEMBERS = 256;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function invalidProjection(): never {
  throw new Error('Invalid Agent projection');
}

function invalidCapabilityOverlay(): never {
  throw new Error('Invalid capability overlay');
}

function verificationFailed(): never {
  throw new Error('Agent artifact verification failed');
}

function capabilityOverlayVerificationFailed(): never {
  throw new Error('Capability overlay verification failed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\0\r\n]/.test(value)
  );
}

function isCapabilitySource(
  value: unknown,
): value is DelegationCapabilitySource {
  return (
    typeof value === 'string' &&
    DELEGATION_CAPABILITY_SOURCES.some((source) => source === value)
  );
}

/** A projection member name: POSIX-relative, never private, and on Windows
 * never a name alias. Exported for its platform-specific tests. */
export function validAgentProjectionMember(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!name || name.length > 512 || /[\\\0\r\n:]/.test(name)) return false;
  return name.split('/').every((part) => {
    const lower = part.toLowerCase();
    return (
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      !(platform === 'win32' && windowsNameAlias(part)) &&
      !lower.startsWith('.env') &&
      ![
        '.git',
        '.codex',
        '.claude',
        '.ssh',
        '.aws',
        '.kube',
        '.config',
        '.canopy',
        '.npmrc',
        '.netrc',
        'auth.json',
        'credentials',
      ].includes(lower) &&
      !lower.endsWith('.pem') &&
      !lower.endsWith('.key')
    );
  });
}

function validIdentity(value: unknown): value is string {
  return (
    isLabel(value) && !/[\\/:]/.test(value) && value !== '.' && value !== '..'
  );
}

function validAccountServerKey(value: unknown): value is string {
  return (
    validIdentity(value) ||
    (typeof value === 'string' &&
      value.startsWith('custom:') &&
      validIdentity(value.slice('custom:'.length)))
  );
}

function validMarketplaceId(value: unknown): value is string {
  return (
    isLabel(value) &&
    !value.startsWith('/') &&
    !/[\\]/.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

function normalizeCapabilities(
  value: unknown,
  files: Readonly<Record<string, string>>,
): AgentCapabilitySnapshot {
  if (
    !isRecord(value) ||
    !Array.isArray(value.claudePluginRoots) ||
    !Array.isArray(value.claudeSkillNames) ||
    !Array.isArray(value.codexCapabilityRoots) ||
    !Array.isArray(value.mcpSelections) ||
    !Array.isArray(value.mcpHttpAuthPreferences) ||
    !Array.isArray(value.hookDeclarations)
  )
    return invalidProjection();
  const hasRoot = (root: unknown): root is string =>
    typeof root === 'string' &&
    validAgentProjectionMember(root) &&
    Object.keys(files).some((member) => member.startsWith(`${root}/`));
  const roots = [value.claudePluginRoots, value.codexCapabilityRoots];
  if (
    roots.some(
      (entries) =>
        entries.length > 64 || entries.some((root: unknown) => !hasRoot(root)),
    ) ||
    value.mcpSelections.length > 128 ||
    value.claudeSkillNames.length > 128 ||
    value.mcpHttpAuthPreferences.length > 128 ||
    value.hookDeclarations.length > 128
  )
    return invalidProjection();
  if (
    value.claudeSkillNames.some(
      (name: unknown) =>
        typeof name !== 'string' ||
        !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(name),
    )
  )
    return invalidProjection();
  const mcpSelections: AgentMcpSelection[] = [];
  for (const selection of value.mcpSelections) {
    if (
      !isRecord(selection) ||
      typeof selection.configDigest !== 'string' ||
      !HASH_PATTERN.test(selection.configDigest)
    )
      return invalidProjection();
    if (selection.source === 'standalone') {
      if (
        !validIdentity(selection.serverId) ||
        !validIdentity(selection.configId)
      )
        return invalidProjection();
      mcpSelections.push({
        source: 'standalone',
        serverId: selection.serverId,
        configId: selection.configId,
        configDigest: selection.configDigest,
      });
    } else if (selection.source === 'account') {
      if (
        !validAccountServerKey(selection.serverId) ||
        !validIdentity(selection.configId)
      )
        return invalidProjection();
      mcpSelections.push({
        source: 'account',
        serverId: selection.serverId,
        configId: selection.configId,
        configDigest: selection.configDigest,
      });
    } else if (
      selection.source === 'plugin' ||
      selection.source === 'inherited-plugin'
    ) {
      if (
        !validMarketplaceId(selection.marketplaceId) ||
        !validIdentity(selection.pluginName) ||
        !validIdentity(selection.serverName) ||
        !hasRoot(selection.root)
      )
        return invalidProjection();
      const identity = {
        marketplaceId: selection.marketplaceId,
        pluginName: selection.pluginName,
        serverName: selection.serverName,
        root: selection.root,
        configDigest: selection.configDigest,
      };
      if (selection.source === 'plugin')
        mcpSelections.push({ ...identity, source: 'plugin' });
      else {
        if (
          typeof selection.installationDigest !== 'string' ||
          !HASH_PATTERN.test(selection.installationDigest)
        )
          return invalidProjection();
        mcpSelections.push({
          ...identity,
          source: 'inherited-plugin',
          installationDigest: selection.installationDigest,
        });
      }
    } else return invalidProjection();
  }
  const auth: AgentMcpHttpAuthPin[] = [];
  for (const preference of value.mcpHttpAuthPreferences) {
    if (!isRecord(preference) || !isRecord(preference.target))
      return invalidProjection();
    const target = preference.target;
    if (!isMcpHttpAuthHandler(preference.handler)) return invalidProjection();
    // Artifacts written before pin provenance existed carry no `source`;
    // every pin was then treated as the user's choice, so a missing value
    // keeps that meaning rather than becoming a bindable default.
    const source: AgentMcpHttpAuthPin['source'] =
      preference.source === 'default' ? 'default' : 'override';
    if (target.kind === 'standalone') {
      if (!validIdentity(target.serverId) || !validIdentity(target.configId))
        return invalidProjection();
      auth.push({
        handler: preference.handler,
        source,
        target: {
          kind: 'standalone',
          serverId: target.serverId,
          configId: target.configId,
        },
      });
    } else if (target.kind === 'plugin') {
      if (
        !validMarketplaceId(target.marketplaceId) ||
        !validIdentity(target.pluginName) ||
        !validIdentity(target.serverName)
      )
        return invalidProjection();
      auth.push({
        handler: preference.handler,
        source,
        target: {
          kind: 'plugin',
          marketplaceId: target.marketplaceId,
          pluginName: target.pluginName,
          serverName: target.serverName,
        },
      });
    } else return invalidProjection();
  }
  const hooks: { root: string; path: string }[] = [];
  for (const hook of value.hookDeclarations) {
    if (
      !isRecord(hook) ||
      !hasRoot(hook.root) ||
      typeof hook.path !== 'string' ||
      !validAgentProjectionMember(hook.path)
    )
      return invalidProjection();
    hooks.push({ root: hook.root, path: hook.path });
  }
  return Object.freeze({
    claudePluginRoots: Object.freeze(value.claudePluginRoots.filter(hasRoot)),
    claudeSkillNames: Object.freeze(
      value.claudeSkillNames.filter(
        (name): name is string => typeof name === 'string',
      ),
    ),
    codexCapabilityRoots: Object.freeze(
      value.codexCapabilityRoots.filter(hasRoot),
    ),
    mcpSelections: Object.freeze(
      mcpSelections.map((entry) => Object.freeze(entry)),
    ),
    mcpHttpAuthPreferences: Object.freeze(
      auth.map((entry) =>
        Object.freeze({ ...entry, target: Object.freeze(entry.target) }),
      ),
    ),
    hookDeclarations: Object.freeze(hooks.map((entry) => Object.freeze(entry))),
  });
}

function normalizeCapabilityOverlay(
  value: unknown,
): MaterializedCapabilityOverlay {
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    !isRecord(value.pluginFiles) ||
    !isRecord(value.provenance) ||
    !isRecord(value.provenance.roots) ||
    !Array.isArray(value.provenance.mcpSelections) ||
    !Array.isArray(value.items)
  )
    return invalidCapabilityOverlay();

  const members = Object.entries(value.pluginFiles);
  if (members.length > MAX_MEMBERS) return invalidCapabilityOverlay();
  let contentBytes = 0;
  const names = new Set<string>();
  const files: Array<[string, string]> = [];
  for (const [name, content] of members) {
    if (
      !validAgentProjectionMember(name) ||
      names.has(name.toLowerCase()) ||
      typeof content !== 'string' ||
      content.length > MAX_ARTIFACT_BYTES
    )
      return invalidCapabilityOverlay();
    contentBytes +=
      Buffer.byteLength(name, 'utf8') + Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_ARTIFACT_BYTES) return invalidCapabilityOverlay();
    names.add(name.toLowerCase());
    files.push([name, content]);
  }
  const pluginFiles: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(
      files.sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
  const capabilities = normalizeCapabilities(value.capabilities, pluginFiles);
  const roots = new Set<string>([
    ...capabilities.claudePluginRoots,
    ...capabilities.codexCapabilityRoots,
  ]);
  const provenanceRootEntries = Object.entries(value.provenance.roots);
  if (
    provenanceRootEntries.length !== roots.size ||
    provenanceRootEntries.some(
      ([root, source]) => !roots.has(root) || !isCapabilitySource(source),
    ) ||
    value.provenance.mcpSelections.length !==
      capabilities.mcpSelections.length ||
    value.provenance.mcpSelections.some(
      (source: unknown) => !isCapabilitySource(source),
    ) ||
    value.items.length > MAX_MEMBERS
  )
    return invalidCapabilityOverlay();

  const sortedRootEntries = provenanceRootEntries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const normalizedRootEntries: Array<[string, DelegationCapabilitySource]> = [];
  for (const [root, source] of sortedRootEntries) {
    if (!isCapabilitySource(source)) return invalidCapabilityOverlay();
    normalizedRootEntries.push([root, source]);
  }
  const normalizedRoots = Object.freeze(
    Object.fromEntries(normalizedRootEntries),
  );
  const mcpProvenance: DelegationCapabilitySource[] = [];
  for (const source of value.provenance.mcpSelections) {
    if (!isCapabilitySource(source)) return invalidCapabilityOverlay();
    mcpProvenance.push(source);
  }

  const itemIds = new Set<string>();
  const items: CapabilityOverlayItem[] = [];
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      !isDelegationCapabilityId(item.id) ||
      itemIds.has(item.id) ||
      typeof item.name !== 'string' ||
      item.name.length === 0 ||
      item.name.length > 200 ||
      /[\0\r\n]/.test(item.name) ||
      !isCapabilitySource(item.source) ||
      !isRecord(item.ref)
    )
      return invalidCapabilityOverlay();

    let ref: CapabilityItemRef;
    if (item.ref.kind === 'skill') {
      if (!isLabel(item.ref.sourceId) || !validIdentity(item.ref.skillName))
        return invalidCapabilityOverlay();
      ref = Object.freeze({
        kind: 'skill',
        sourceId: item.ref.sourceId,
        skillName: item.ref.skillName,
      });
    } else if (item.ref.kind === 'plugin') {
      if (
        !validMarketplaceId(item.ref.marketplaceId) ||
        !validIdentity(item.ref.pluginName)
      )
        return invalidCapabilityOverlay();
      ref = Object.freeze({
        kind: 'plugin',
        marketplaceId: item.ref.marketplaceId,
        pluginName: item.ref.pluginName,
      });
    } else if (item.ref.kind === 'mcp') {
      if (!isLabel(item.ref.serverId) || !validIdentity(item.ref.configId))
        return invalidCapabilityOverlay();
      ref = Object.freeze({
        kind: 'mcp',
        serverId: item.ref.serverId,
        configId: item.ref.configId,
      });
    } else return invalidCapabilityOverlay();

    itemIds.add(item.id);
    items.push(
      Object.freeze({
        id: item.id,
        name: item.name,
        source: item.source,
        ref,
      }),
    );
  }

  const homeEntries: RetainedHomeCapability[] = [];
  if (value.homeEntries !== undefined) {
    if (!Array.isArray(value.homeEntries) || value.homeEntries.length > 64)
      return invalidCapabilityOverlay();
    const homeRoots = new Set<string>();
    for (const entry of value.homeEntries) {
      if (
        !isRecord(entry) ||
        typeof entry.root !== 'string' ||
        !roots.has(entry.root) ||
        normalizedRoots[entry.root] !== 'inherited' ||
        homeRoots.has(entry.root) ||
        !validIdentity(entry.name) ||
        entry.name.length > 200 ||
        (entry.kind !== 'skill' &&
          entry.kind !== 'command' &&
          entry.kind !== 'plugin') ||
        (entry.origin !== 'cursor' &&
          entry.origin !== 'claude' &&
          entry.origin !== 'codex' &&
          entry.origin !== 'grok' &&
          entry.origin !== 'agents' &&
          entry.origin !== 'cursor-plugin')
      )
        return invalidCapabilityOverlay();
      let pluginRef: RetainedHomeCapability['pluginRef'];
      if (entry.kind === 'plugin') {
        if (
          !isRecord(entry.pluginRef) ||
          !validMarketplaceId(entry.pluginRef.marketplaceId) ||
          !validIdentity(entry.pluginRef.pluginName)
        )
          return invalidCapabilityOverlay();
        pluginRef = Object.freeze({
          marketplaceId: entry.pluginRef.marketplaceId,
          pluginName: entry.pluginRef.pluginName,
        });
      }
      const root = entry.root;
      // A home root may not sweep a different layer's nested capability into
      // the next generation's inherited snapshot.
      if (
        Array.from(roots).some(
          (other) =>
            other !== root &&
            (other.startsWith(`${root}/`) || root.startsWith(`${other}/`)),
        )
      )
        return invalidCapabilityOverlay();
      homeRoots.add(root);
      homeEntries.push(
        Object.freeze({
          root,
          kind: entry.kind,
          ...(pluginRef ? { pluginRef } : {}),
          name: entry.name,
          origin: entry.origin,
        }),
      );
    }
  }

  if (
    capabilities.mcpSelections.some(
      (selection, index) =>
        selection.source === 'inherited-plugin' &&
        (mcpProvenance[index] !== 'inherited' ||
          !homeEntries.some(
            (entry) =>
              entry.root === selection.root &&
              entry.pluginRef?.marketplaceId === selection.marketplaceId &&
              entry.pluginRef.pluginName === selection.pluginName,
          )),
    )
  )
    return invalidCapabilityOverlay();
  const overlay: MaterializedCapabilityOverlay = Object.freeze({
    version: 3,
    pluginFiles,
    capabilities,
    provenance: Object.freeze({
      roots: normalizedRoots,
      mcpSelections: Object.freeze(mcpProvenance),
    }),
    items: Object.freeze(items),
    ...(value.homeEntries !== undefined
      ? { homeEntries: Object.freeze(homeEntries) }
      : {}),
  });
  if (Buffer.byteLength(JSON.stringify(overlay), 'utf8') > MAX_ARTIFACT_BYTES)
    return invalidCapabilityOverlay();
  return overlay;
}

function normalizeProjection(value: unknown): MaterializedAgentProjection {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !isLabel(value.agentDefinitionId) ||
    !isLabel(value.agentDefinitionRevision) ||
    typeof value.agentDefinitionHash !== 'string' ||
    !HASH_PATTERN.test(value.agentDefinitionHash) ||
    typeof value.systemPromptAppend !== 'string' ||
    !isRecord(value.pluginFiles) ||
    !Array.isArray(value.toolNames)
  )
    return invalidProjection();
  const members = Object.entries(value.pluginFiles);
  if (members.length > MAX_MEMBERS || value.toolNames.length > 2)
    return invalidProjection();
  if (value.systemPromptAppend.length > MAX_ARTIFACT_BYTES)
    return invalidProjection();
  let contentBytes = Buffer.byteLength(value.systemPromptAppend, 'utf8');
  const names = new Set<string>();
  const files: Array<[string, string]> = [];
  for (const [name, content] of members) {
    if (
      !validAgentProjectionMember(name) ||
      names.has(name.toLowerCase()) ||
      typeof content !== 'string' ||
      content.length > MAX_ARTIFACT_BYTES
    )
      return invalidProjection();
    contentBytes +=
      Buffer.byteLength(name, 'utf8') + Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_ARTIFACT_BYTES) return invalidProjection();
    names.add(name.toLowerCase());
    files.push([name, content]);
  }
  const tools: AgentProjectionToolName[] = [];
  const toolNames: readonly unknown[] = value.toolNames;
  for (const name of toolNames) {
    if (name !== 'read' && name !== 'search') return invalidProjection();
    tools.push(name);
  }
  const projection: MaterializedAgentProjection = Object.freeze({
    version: value.version,
    agentDefinitionId: value.agentDefinitionId,
    agentDefinitionRevision: value.agentDefinitionRevision,
    agentDefinitionHash: value.agentDefinitionHash,
    systemPromptAppend: value.systemPromptAppend,
    pluginFiles: Object.freeze(
      Object.fromEntries(
        files.sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    ),
    toolNames: Object.freeze(Array.from(new Set(tools)).sort()),
    ...(value.version === 2
      ? {
          capabilities: normalizeCapabilities(
            value.capabilities,
            Object.fromEntries(files),
          ),
        }
      : {}),
  });
  if (
    Buffer.byteLength(JSON.stringify(projection), 'utf8') > MAX_ARTIFACT_BYTES
  )
    return invalidProjection();
  return projection;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function capabilityProjectionHash(
  overlay: MaterializedCapabilityOverlay,
): string {
  return digest(
    JSON.stringify({
      files: overlay.pluginFiles,
      capabilities: overlay.capabilities,
      provenance: overlay.provenance,
      items: overlay.items,
      ...(overlay.homeEntries !== undefined
        ? { homeEntries: overlay.homeEntries }
        : {}),
    }),
  );
}

function overlaySnapshot(
  projection: MaterializedAgentProjection,
): ResolvedAgentOverlaySnapshot {
  const manifestHash = digest(JSON.stringify(projection));
  return Object.freeze({
    agentDefinitionId: projection.agentDefinitionId,
    agentDefinitionRevision: projection.agentDefinitionRevision,
    agentDefinitionHash: projection.agentDefinitionHash,
    pluginProjectionHash: digest(
      JSON.stringify({
        files: projection.pluginFiles,
        tools: projection.toolNames,
        ...(projection.version === 2
          ? { capabilities: projection.capabilities }
          : {}),
      }),
    ),
    systemPromptAppend: projection.systemPromptAppend,
    artifact: Object.freeze({
      artifactId: manifestHash,
      formatVersion: projection.version,
      manifestHash,
    }),
  });
}

function capabilityOverlaySnapshot(
  overlay: MaterializedCapabilityOverlay,
): ResolvedCapabilityOverlaySnapshot {
  const manifestHash = digest(JSON.stringify(overlay));
  return Object.freeze({
    capabilityProjectionHash: capabilityProjectionHash(overlay),
    artifact: Object.freeze({
      artifactId: manifestHash,
      formatVersion: 3,
      manifestHash,
    }),
  });
}

/** Whether a proposed overlay contains no capability material or references. */
export function isEmptyCapabilityOverlayInput(
  input: CapabilityOverlayInput,
): boolean {
  return (
    Object.keys(input.pluginFiles).length === 0 &&
    input.capabilities.claudePluginRoots.length === 0 &&
    input.capabilities.claudeSkillNames.length === 0 &&
    input.capabilities.codexCapabilityRoots.length === 0 &&
    input.capabilities.mcpSelections.length === 0 &&
    input.items.length === 0
  );
}

/** Maps retained Agent projections to the capability-only artifact shape. */
export function capabilityOverlayFromAgentProjection(
  projection: MaterializedAgentProjection,
): MaterializedCapabilityOverlay | undefined {
  const capabilities = projection.capabilities ?? EMPTY_AGENT_CAPABILITIES;
  if (
    Object.keys(projection.pluginFiles).length === 0 &&
    capabilities.claudePluginRoots.length === 0 &&
    capabilities.claudeSkillNames.length === 0 &&
    capabilities.codexCapabilityRoots.length === 0 &&
    capabilities.mcpSelections.length === 0 &&
    capabilities.mcpHttpAuthPreferences.length === 0 &&
    capabilities.hookDeclarations.length === 0
  )
    return undefined;

  const rootNames = new Set<string>();
  const rootEntries: Array<[string, DelegationCapabilitySource]> = [];
  for (const root of [
    ...capabilities.claudePluginRoots,
    ...capabilities.codexCapabilityRoots,
  ]) {
    if (!rootNames.has(root)) {
      rootNames.add(root);
      rootEntries.push([root, 'agent']);
    }
  }
  return normalizeCapabilityOverlay({
    version: 3,
    pluginFiles: projection.pluginFiles,
    capabilities,
    provenance: {
      roots: Object.fromEntries(rootEntries),
      mcpSelections: capabilities.mcpSelections.map(() => 'agent'),
    },
    items: [],
  });
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Private, content-addressed blobs. Record owners retain references until deletion. */
export class AgentArtifactStore {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory))
      throw new Error('Agent artifact directory must be absolute');
  }

  async retain(
    input: AgentProjectionInput,
  ): Promise<ResolvedAgentOverlaySnapshot> {
    const projection = normalizeProjection({
      ...input,
      version: 2,
      capabilities: input.capabilities ?? {
        claudePluginRoots: [],
        claudeSkillNames: [],
        codexCapabilityRoots: [],
        mcpSelections: [],
        mcpHttpAuthPreferences: [],
        hookDeclarations: [],
      },
    });
    const snapshot = overlaySnapshot(projection);
    const id = snapshot.artifact.artifactId;
    await this.retainArtifact(id, projection, () => this.load(snapshot));
    return snapshot;
  }

  async retainCapabilityOverlay(
    input: CapabilityOverlayInput,
  ): Promise<ResolvedCapabilityOverlaySnapshot> {
    const overlay = normalizeCapabilityOverlay({ ...input, version: 3 });
    const snapshot = capabilityOverlaySnapshot(overlay);
    await this.retainArtifact(snapshot.artifact.artifactId, overlay, () =>
      this.loadCapabilityOverlay(snapshot),
    );
    return snapshot;
  }

  async load(
    snapshot: ResolvedAgentOverlaySnapshot,
  ): Promise<MaterializedAgentProjection> {
    try {
      const { artifact } = snapshot;
      if (
        (artifact.formatVersion !== 1 && artifact.formatVersion !== 2) ||
        !HASH_PATTERN.test(artifact.artifactId) ||
        artifact.manifestHash !== artifact.artifactId
      )
        return verificationFailed();
      const text = await this.readArtifactText(
        artifact.artifactId,
        artifact.manifestHash,
      );
      const parsed: unknown = JSON.parse(text);
      const projection = normalizeProjection(parsed);
      if (projection.version !== artifact.formatVersion)
        return verificationFailed();
      const verified = overlaySnapshot(projection);
      if (
        verified.artifact.manifestHash !== artifact.manifestHash ||
        verified.agentDefinitionId !== snapshot.agentDefinitionId ||
        verified.agentDefinitionRevision !== snapshot.agentDefinitionRevision ||
        verified.agentDefinitionHash !== snapshot.agentDefinitionHash ||
        verified.pluginProjectionHash !== snapshot.pluginProjectionHash ||
        (snapshot.systemPromptAppend !== undefined &&
          snapshot.systemPromptAppend !== projection.systemPromptAppend)
      )
        return verificationFailed();
      return projection;
    } catch {
      return verificationFailed();
    }
  }

  async loadCapabilityOverlay(
    snapshot: ResolvedCapabilityOverlaySnapshot,
  ): Promise<MaterializedCapabilityOverlay> {
    try {
      const { artifact } = snapshot;
      if (
        artifact.formatVersion !== 3 ||
        !HASH_PATTERN.test(artifact.artifactId) ||
        artifact.manifestHash !== artifact.artifactId ||
        !HASH_PATTERN.test(snapshot.capabilityProjectionHash)
      )
        return capabilityOverlayVerificationFailed();
      const text = await this.readArtifactText(
        artifact.artifactId,
        artifact.manifestHash,
      );
      const parsed: unknown = JSON.parse(text);
      const overlay = normalizeCapabilityOverlay(parsed);
      const manifestHash = digest(JSON.stringify(overlay));
      if (
        manifestHash !== artifact.manifestHash ||
        capabilityProjectionHash(overlay) !== snapshot.capabilityProjectionHash
      )
        return capabilityOverlayVerificationFailed();
      return overlay;
    } catch {
      return capabilityOverlayVerificationFailed();
    }
  }

  private async retainArtifact(
    artifactId: string,
    value: unknown,
    load: () => Promise<unknown>,
  ): Promise<void> {
    const prior = this.pending.get(artifactId);
    if (prior) {
      await prior;
      return;
    }
    const task = this.persistArtifact(artifactId, value, load);
    this.pending.set(artifactId, task);
    try {
      await task;
    } finally {
      if (this.pending.get(artifactId) === task)
        this.pending.delete(artifactId);
    }
  }

  private async readArtifactText(
    artifactId: string,
    manifestHash: string,
  ): Promise<string> {
    // Resume reads artifacts in a fresh process, before any persist has
    // verified the directory, so the read path checks it too.
    await assertPrivateDirectoryAcl(this.directory);
    const file = path.join(this.directory, `${artifactId}.json`);
    const before = await fs.lstat(file);
    if (!before.isFile() || before.nlink !== 1)
      throw new Error('Invalid artifact');
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let text: string;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size > MAX_ARTIFACT_BYTES
      )
        throw new Error('Invalid artifact');
      const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
      let used = 0;
      while (used < bytes.length) {
        const read = await handle.read(bytes, used, bytes.length - used, used);
        if (read.bytesRead === 0) break;
        used += read.bytesRead;
      }
      if (used > MAX_ARTIFACT_BYTES) throw new Error('Invalid artifact');
      text = bytes.subarray(0, used).toString('utf8');
    } finally {
      await handle.close();
    }
    if (digest(text) !== manifestHash) throw new Error('Invalid artifact');
    return text;
  }

  private async persistArtifact(
    artifactId: string,
    value: unknown,
    load: () => Promise<unknown>,
  ): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectoryAcl(this.directory);
    const target = path.join(this.directory, `${artifactId}.json`);
    let exists = true;
    try {
      await fs.lstat(target);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      exists = false;
    }
    if (exists) {
      await load();
      return;
    }
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        const text = JSON.stringify(value);
        if (text === undefined) throw new Error('Unable to serialize artifact');
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, target);
      try {
        const directory = await fs.open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        // Windows does not support directory fsync; the file was synced above.
        if (
          process.platform !== 'win32' ||
          (!hasCode(error, 'EPERM') &&
            !hasCode(error, 'EINVAL') &&
            !hasCode(error, 'EISDIR'))
        )
          throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
    await load();
  }
}
