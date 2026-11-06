import { z } from 'zod';
import { settingsRouteSchema } from '@canopy/protocol/settings';

export const SETTINGS_ACTION_TYPES = [
  'settings.open',
  'settings.ai_gateway.get',
  'settings.ai_gateway.connect',
  'settings.ai_gateway.update',
] as const;

/**
 * `settings.open` names its destination with the shared `SettingsRoute`
 * contract, never a URL, so an agent can only open a page the route schema
 * accepts. The route sits under `destination` because generic actions reject
 * top-level UI-state fields such as `route` and `page`.
 */
export const settingsActionSchema = z.strictObject({
  type: z.literal('settings.open'),
  destination: settingsRouteSchema,
});

export type SettingsAction = z.output<typeof settingsActionSchema>;

export const SCRIPT_PREFERENCES_ACTION_TYPES = [
  'script_actions.list',
  'script_actions.open_review',
  'script_actions.rescan',
  'script_actions.set_pin',
  'script_actions.set_shortcut',
] as const;
