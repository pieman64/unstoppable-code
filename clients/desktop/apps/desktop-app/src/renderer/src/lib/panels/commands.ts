/**
 * Desktop compatibility shim for the shared panel command layer.
 *
 * `satisfies` proves every shared panel command id remains part of the
 * desktop command catalog without widening or casting the shared exports.
 */
import { PANEL_COMMANDS as SHARED_PANEL_COMMANDS } from '@canopy/ui-app/panel-commands';
import type { CommandId } from '@/lib/keyboardShortcuts';

const PANEL_COMMANDS = SHARED_PANEL_COMMANDS satisfies readonly {
  readonly id: CommandId;
}[];

export {
  getPanelCommand,
  isPanelCommandAvailable,
  PANEL_SHORTCUT_BINDINGS,
  runPanelCommand,
  type PanelCommand,
  type PanelCommandId,
  type PanelShortcutBinding,
} from '@canopy/ui-app/panel-commands';
export { PANEL_COMMANDS };
