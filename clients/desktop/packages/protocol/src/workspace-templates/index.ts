import { MARKETPLACE_PUBLIC_SHARE_PREFIXES } from '../marketplace';
import {
  isShareablePluginRef,
  normalizeShareablePluginRef,
  type ShareablePluginRef,
} from '../plugins';
import { isProjectStartPage, type ProjectStartPage } from '../start-page';
import type { ResourceOwner } from '../resource-owner';

export const WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX =
  MARKETPLACE_PUBLIC_SHARE_PREFIXES.blueprint;
export const LEGACY_BLUEPRINT_SHARE_PATH_PREFIX = '/share/blueprints';
export const LEGACY_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX = '/share/workspaces';

/**
 * User-facing name for a shared workspace template. Internal wire, persisted,
 * and API vocabulary intentionally remains `blueprint` / `workspace template`.
 */
export const WORKSPACE_TEMPLATE_SHARE_LABEL = 'Project template';
export const WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL = 'Project templates';
export const WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER = 'project template';
export const WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL_LOWER = 'project templates';

export const WORKSPACE_TEMPLATE_SHARE_AUDIENCES = [
  'PUBLIC',
  'TEAM',
  'ORGANIZATION',
] as const;
export type WorkspaceTemplateShareAudience =
  (typeof WORKSPACE_TEMPLATE_SHARE_AUDIENCES)[number];

export interface WorkspaceTemplateShareSummary {
  externalId: string;
  sharePath: string;
  pinnedContentHash: string;
  name: string;
  description: string;
  audience: WorkspaceTemplateShareAudience;
  owner: ResourceOwner;
  createdBy: { id: string; name: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface ListWorkspaceTemplateSharesRequest {
  createdBy?: 'me' | 'anyone';
  query?: string;
}

export interface ListWorkspaceTemplateSharesResponse {
  shares: WorkspaceTemplateShareSummary[];
}

export function workspaceTemplateSharePath(externalId: string): string {
  return `${WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX}/${externalId}`;
}

export const SHARED_WORKSPACE_TEMPLATE_API_VERSION = 2;
export const MAX_SHARED_WORKSPACE_TEMPLATE_BYTES = 512 * 1024;
export const MAX_WORKSPACE_TEMPLATE_CUSTOM_SKILLS = 25;
export const MAX_WORKSPACE_TEMPLATE_PLUGIN_REFS = 50;
export const MAX_WORKSPACE_TEMPLATE_GITHUB_REPOSITORIES = 10;
export const MAX_WORKSPACE_TEMPLATE_MCP_SERVER_REFS = 50;
const MAX_WORKSPACE_TEMPLATE_MCP_SERVER_ID_LENGTH = 256;
const MAX_WORKSPACE_TEMPLATE_MCP_CONFIG_ID_LENGTH = 128;
export const MAX_DEFAULT_AGENT_INSTRUCTIONS_LENGTH = 16_000;
export const MAX_SHARED_WORKSPACE_TEMPLATE_NAME_LENGTH = 256;
export const MAX_WORKSPACE_DESCRIPTION_LENGTH = 2_000;
export const MAX_WORKSPACE_TEMPLATE_STARTER_PROMPTS = 15;
export const MAX_WORKSPACE_TEMPLATE_STARTER_PROMPT_ID_LENGTH = 128;
export const MAX_WORKSPACE_TEMPLATE_STARTER_PROMPT_TEXT_LENGTH = 2_000;

const WORKSPACE_TEMPLATE_CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const WORKSPACE_TEMPLATE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isWorkspaceTemplateContentHash(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    WORKSPACE_TEMPLATE_CONTENT_HASH_PATTERN.test(value)
  );
}

export interface SharedWorkspaceTemplateCustomSkill {
  clientKey: string;
  name: string;
  rawSkill: string;
}

/**
 * An account MCP server by server key (curated catalog key or
 * `custom:<uuid>`) plus config, the ref shape desktop and cloud sessions
 * share. Device-only servers never travel in a template.
 */
export interface WorkspaceTemplateMcpServerRef {
  serverId: string;
  configId: string;
}

export interface WorkspaceTemplateStarterPrompt {
  id: string;
  text: string;
}

export interface CuratedBlueprintCatalogItem {
  externalId: string;
  contentHash: string;
  name: string;
  description: string;
  color?: string;
}

export interface CuratedBlueprintCatalogResponse {
  blueprints: CuratedBlueprintCatalogItem[];
}

export interface SharedWorkspaceTemplateDocumentV1 {
  version: 1;
  name: string;
  description: string;
  color?: string;
  instructions: string;
  plugins: ShareablePluginRef[];
  customSkills: SharedWorkspaceTemplateCustomSkill[];
}

export interface SharedWorkspaceTemplateDocument extends Omit<
  SharedWorkspaceTemplateDocumentV1,
  'version'
> {
  version: 2;
  starterPrompts: WorkspaceTemplateStarterPrompt[];
  /** Omitted when empty so documents without MCP servers keep their hash. */
  mcpServerRefs?: WorkspaceTemplateMcpServerRef[];
  /** Omitted when absent so existing documents keep their content hash. */
  startPage?: ProjectStartPage;
}

/** Canonical bytes used by Blueprint share pins and capability packages. */
export function serializeSharedWorkspaceTemplateForHash(
  document: SharedWorkspaceTemplateDocument,
): string {
  return JSON.stringify(document);
}

export type WorkspaceTemplateStarterPromptsValidationResult =
  | { ok: true; starterPrompts: WorkspaceTemplateStarterPrompt[] }
  | { ok: false; error: string };

export type SharedWorkspaceTemplateValidationResult =
  | { ok: true; document: SharedWorkspaceTemplateDocument }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? null
      : new TextEncoder().encode(serialized).length;
  } catch {
    return null;
  }
}

export function validateWorkspaceTemplateStarterPrompts(
  value: unknown,
): WorkspaceTemplateStarterPromptsValidationResult {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: 'Workspace template starterPrompts must be an array.',
    };
  }
  if (value.length > MAX_WORKSPACE_TEMPLATE_STARTER_PROMPTS) {
    return {
      ok: false,
      error: `Workspace templates support at most ${MAX_WORKSPACE_TEMPLATE_STARTER_PROMPTS} starter prompts.`,
    };
  }
  const starterPrompts: WorkspaceTemplateStarterPrompt[] = [];
  const starterPromptIds = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      item.id.trim().length === 0 ||
      item.id.length > MAX_WORKSPACE_TEMPLATE_STARTER_PROMPT_ID_LENGTH ||
      typeof item.text !== 'string' ||
      item.text.trim().length === 0 ||
      item.text.length > MAX_WORKSPACE_TEMPLATE_STARTER_PROMPT_TEXT_LENGTH
    ) {
      return {
        ok: false,
        error:
          'Workspace template starter prompts require a bounded, non-empty id and text.',
      };
    }
    if (starterPromptIds.has(item.id)) {
      return {
        ok: false,
        error: 'Workspace template starter prompt ids must be unique.',
      };
    }
    starterPromptIds.add(item.id);
    starterPrompts.push({ id: item.id, text: item.text });
  }
  return { ok: true, starterPrompts };
}

function validateWorkspaceTemplateMcpServerRefs(
  value: unknown,
):
  | { ok: true; mcpServerRefs: WorkspaceTemplateMcpServerRef[] }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, mcpServerRefs: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: 'Workspace template mcpServerRefs must be an array.',
    };
  }
  if (value.length > MAX_WORKSPACE_TEMPLATE_MCP_SERVER_REFS) {
    return {
      ok: false,
      error: `Workspace templates support at most ${MAX_WORKSPACE_TEMPLATE_MCP_SERVER_REFS} MCP servers.`,
    };
  }
  const seen = new Set<string>();
  const mcpServerRefs: WorkspaceTemplateMcpServerRef[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.serverId !== 'string' ||
      typeof item.configId !== 'string' ||
      item.serverId.trim().length === 0 ||
      item.configId.trim().length === 0 ||
      item.serverId.length > MAX_WORKSPACE_TEMPLATE_MCP_SERVER_ID_LENGTH ||
      item.configId.length > MAX_WORKSPACE_TEMPLATE_MCP_CONFIG_ID_LENGTH ||
      item.serverId.startsWith('account:')
    ) {
      return {
        ok: false,
        error:
          'Workspace template MCP servers need an account server key and config.',
      };
    }
    const key = JSON.stringify([item.serverId, item.configId]);
    if (seen.has(key)) continue;
    seen.add(key);
    mcpServerRefs.push({ serverId: item.serverId, configId: item.configId });
  }
  return { ok: true, mcpServerRefs };
}

export function validateSharedWorkspaceTemplateDocument(
  value: unknown,
): SharedWorkspaceTemplateValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: 'Workspace template document must be an object.',
    };
  }
  if (
    value.version !== 1 &&
    value.version !== SHARED_WORKSPACE_TEMPLATE_API_VERSION
  ) {
    return {
      ok: false,
      error: `Unsupported workspace template version; expected ${SHARED_WORKSPACE_TEMPLATE_API_VERSION}.`,
    };
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return { ok: false, error: 'Workspace template name is required.' };
  }
  if (value.name.length > MAX_SHARED_WORKSPACE_TEMPLATE_NAME_LENGTH) {
    return {
      ok: false,
      error: `Workspace template name exceeds ${MAX_SHARED_WORKSPACE_TEMPLATE_NAME_LENGTH} characters.`,
    };
  }
  if (typeof value.description !== 'string') {
    return {
      ok: false,
      error: 'Workspace template description must be a string.',
    };
  }
  if (value.description.trim().length > MAX_WORKSPACE_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Workspace template description exceeds ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters.`,
    };
  }
  if (
    value.color !== undefined &&
    (typeof value.color !== 'string' ||
      !WORKSPACE_TEMPLATE_COLOR_PATTERN.test(value.color))
  ) {
    return {
      ok: false,
      error: 'Workspace template color must be a #RRGGBB hex string.',
    };
  }
  if (typeof value.instructions !== 'string') {
    return {
      ok: false,
      error: 'Workspace template instructions must be a string.',
    };
  }
  if (value.instructions.length > MAX_DEFAULT_AGENT_INSTRUCTIONS_LENGTH) {
    return {
      ok: false,
      error: `Workspace template instructions exceed ${MAX_DEFAULT_AGENT_INSTRUCTIONS_LENGTH} characters.`,
    };
  }
  if (
    !Array.isArray(value.plugins) ||
    !value.plugins.every((ref) => isShareablePluginRef(ref))
  ) {
    return {
      ok: false,
      error: 'Workspace template plugins must all be shareable plugin refs.',
    };
  }
  if (value.plugins.length > MAX_WORKSPACE_TEMPLATE_PLUGIN_REFS) {
    return {
      ok: false,
      error: `Workspace templates support at most ${MAX_WORKSPACE_TEMPLATE_PLUGIN_REFS} plugin refs.`,
    };
  }
  const plugins = value.plugins.map((ref) => normalizeShareablePluginRef(ref));
  const githubRepositories = new Set<string>();
  for (const ref of plugins) {
    if (ref.type === 'codex_plugin') continue;
    const source = ref.type === 'skill' ? ref.source : ref.marketplace;
    if (source.type === 'github') githubRepositories.add(source.repo);
  }
  if (githubRepositories.size > MAX_WORKSPACE_TEMPLATE_GITHUB_REPOSITORIES) {
    return {
      ok: false,
      error: `Workspace templates support refs from at most ${MAX_WORKSPACE_TEMPLATE_GITHUB_REPOSITORIES} GitHub repositories.`,
    };
  }
  if (!Array.isArray(value.customSkills)) {
    return {
      ok: false,
      error: 'Workspace template customSkills must be an array.',
    };
  }
  if (value.customSkills.length > MAX_WORKSPACE_TEMPLATE_CUSTOM_SKILLS) {
    return {
      ok: false,
      error: `Workspace templates support at most ${MAX_WORKSPACE_TEMPLATE_CUSTOM_SKILLS} custom skills.`,
    };
  }

  const customSkills: SharedWorkspaceTemplateCustomSkill[] = [];
  const clientKeys = new Set<string>();
  for (const item of value.customSkills) {
    if (
      !isRecord(item) ||
      typeof item.clientKey !== 'string' ||
      item.clientKey.trim().length === 0 ||
      typeof item.name !== 'string' ||
      item.name.trim().length === 0 ||
      typeof item.rawSkill !== 'string'
    ) {
      return {
        ok: false,
        error:
          'Workspace template custom skills require a clientKey, name, and rawSkill.',
      };
    }
    if (clientKeys.has(item.clientKey)) {
      return {
        ok: false,
        error: 'Workspace template custom skill clientKeys must be unique.',
      };
    }
    clientKeys.add(item.clientKey);
    customSkills.push({
      clientKey: item.clientKey,
      name: item.name,
      rawSkill: item.rawSkill,
    });
  }

  const rawStarterPrompts = value.version === 1 ? [] : value.starterPrompts;
  const starterPromptsResult =
    validateWorkspaceTemplateStarterPrompts(rawStarterPrompts);
  if (!starterPromptsResult.ok) return starterPromptsResult;
  const mcpServerRefsResult = validateWorkspaceTemplateMcpServerRefs(
    value.version === 1 ? undefined : value.mcpServerRefs,
  );
  if (!mcpServerRefsResult.ok) return mcpServerRefsResult;
  let startPage: ProjectStartPage | undefined;
  if (value.version !== 1 && value.startPage !== undefined) {
    if (!isProjectStartPage(value.startPage)) {
      return {
        ok: false,
        error:
          'Workspace template startPage must be a valid project start page.',
      };
    }
    startPage = value.startPage;
  }

  const document: SharedWorkspaceTemplateDocument = {
    version: SHARED_WORKSPACE_TEMPLATE_API_VERSION,
    name: value.name,
    description: value.description.trim(),
    ...(value.color === undefined ? {} : { color: value.color }),
    instructions: value.instructions,
    plugins,
    customSkills,
    starterPrompts: starterPromptsResult.starterPrompts,
    ...(mcpServerRefsResult.mcpServerRefs.length > 0
      ? { mcpServerRefs: mcpServerRefsResult.mcpServerRefs }
      : {}),
    ...(startPage ? { startPage } : {}),
  };
  const byteLength = serializedByteLength(
    value.version === 1
      ? {
          version: 1,
          name: document.name,
          description: document.description,
          ...(document.color === undefined ? {} : { color: document.color }),
          instructions: document.instructions,
          plugins: document.plugins,
          customSkills: document.customSkills,
        }
      : document,
  );
  if (byteLength === null || byteLength > MAX_SHARED_WORKSPACE_TEMPLATE_BYTES) {
    return {
      ok: false,
      error: `Shared workspace template document exceeds ${MAX_SHARED_WORKSPACE_TEMPLATE_BYTES} bytes.`,
    };
  }
  return { ok: true, document };
}
