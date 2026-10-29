/** Public web destinations. Activated by share helpers after route integration. */
export const MARKETPLACE_PUBLIC_PATH = '/portal/plugins/marketplace';
export const MARKETPLACE_PUBLIC_SHARE_PREFIXES = {
  skill: '/portal/plugins/skills/shared',
  plugin: '/portal/plugins/plugins/shared',
  pipeline: '/portal/plugins/pipelines/shared',
  collection: '/portal/plugins/collections/shared',
  agent: '/portal/plugins/agents',
  automation: '/portal/plugins/automations',
  blueprint: '/portal/plugins/project-templates',
} as const;

/** Stable old paths for redirects and attribution after canonical links switch. */
export const LEGACY_PUBLIC_SKILL_SHARE_PATH_PREFIX = '/share/skills';
export const LEGACY_PUBLIC_PLUGIN_SHARE_PATH_PREFIX = '/share/plugins';
export const LEGACY_PUBLIC_PIPELINE_SHARE_PATH_PREFIX = '/share/pipelines';
export const LEGACY_PUBLIC_COLLECTION_SHARE_PATH_PREFIX = '/share/collections';
export const LEGACY_PUBLIC_AGENT_SHARE_PATH_PREFIX = '/share/agents';
export const LEGACY_PUBLIC_AUTOMATION_SHARE_PATH_PREFIX = '/share/automations';
export const LEGACY_PUBLIC_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX =
  '/share/project-templates';
