import {
  MARKETPLACE_PUBLIC_PATH,
  MARKETPLACE_PUBLIC_SHARE_PREFIXES,
  LEGACY_PUBLIC_SKILL_SHARE_PATH_PREFIX,
  LEGACY_PUBLIC_PLUGIN_SHARE_PATH_PREFIX,
  LEGACY_PUBLIC_PIPELINE_SHARE_PATH_PREFIX,
  LEGACY_PUBLIC_COLLECTION_SHARE_PATH_PREFIX,
  LEGACY_PUBLIC_AGENT_SHARE_PATH_PREFIX,
  LEGACY_PUBLIC_AUTOMATION_SHARE_PATH_PREFIX,
  LEGACY_PUBLIC_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX,
} from '../index';
it('exports canonical destinations and stable legacy prefixes before share producers switch', () => {
  expect(MARKETPLACE_PUBLIC_PATH).toBe('/portal/plugins/marketplace');
  expect(MARKETPLACE_PUBLIC_SHARE_PREFIXES).toEqual({
    skill: '/portal/plugins/skills/shared',
    plugin: '/portal/plugins/plugins/shared',
    pipeline: '/portal/plugins/pipelines/shared',
    collection: '/portal/plugins/collections/shared',
    agent: '/portal/plugins/agents',
    automation: '/portal/plugins/automations',
    blueprint: '/portal/plugins/project-templates',
  });
  expect([
    LEGACY_PUBLIC_SKILL_SHARE_PATH_PREFIX,
    LEGACY_PUBLIC_PLUGIN_SHARE_PATH_PREFIX,
    LEGACY_PUBLIC_PIPELINE_SHARE_PATH_PREFIX,
    LEGACY_PUBLIC_COLLECTION_SHARE_PATH_PREFIX,
    LEGACY_PUBLIC_AGENT_SHARE_PATH_PREFIX,
    LEGACY_PUBLIC_AUTOMATION_SHARE_PATH_PREFIX,
    LEGACY_PUBLIC_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX,
  ]).toEqual([
    '/share/skills',
    '/share/plugins',
    '/share/pipelines',
    '/share/collections',
    '/share/agents',
    '/share/automations',
    '/share/project-templates',
  ]);
});
