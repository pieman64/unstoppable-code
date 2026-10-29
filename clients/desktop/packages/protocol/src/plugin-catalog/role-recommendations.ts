import type { ProfileRoleId } from './index';

/** Default used by Getting Started when the user has not saved a role. */
export const DEFAULT_PLUGIN_RECOMMENDATION_ROLE: ProfileRoleId =
  'software-engineer';

/**
 * Outcome-oriented plugin shortlists shared by Getting Started and plugin
 * discovery. Names are stable curated-catalog names, not display labels.
 */
export const ROLE_PLUGIN_RECOMMENDATIONS: Readonly<
  Record<ProfileRoleId, readonly string[]>
> = {
  'software-engineer': ['bigquery', 'snowflake', 'vercel'],
  'engineering-leader': ['pagerduty', 'incident-io', 'sentry'],
  'product-manager': ['posthog', 'figma', 'amplitude'],
  designer: ['figma', 'miro', 'canva'],
  founder: ['hubspot', 'stripe', 'ramp'],
  'data-analytics': ['bigquery', 'clickhouse', 'mixpanel'],
  'marketing-sales': ['hubspot', 'klaviyo', 'ahrefs', 'salesforce', 'airtable'],
  marketing: ['hubspot', 'klaviyo', 'ahrefs', 'salesforce', 'airtable'],
  sales: ['hubspot', 'klaviyo', 'ahrefs', 'salesforce', 'airtable'],
  operations: ['asana', 'zapier', 'airtable'],
  support: ['intercom', 'zendesk', 'salesforce'],
  'operations-support': ['intercom', 'asana', 'zapier'],
  student: ['exa', 'todoist', 'canva'],
  other: ['exa', 'airtable', 'zapier'],
};
