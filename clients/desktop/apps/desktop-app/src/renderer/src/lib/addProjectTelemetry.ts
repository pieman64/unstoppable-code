import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';

/**
 * Add project funnel: `workspace:add_project_dialog_open` when the dialog
 * opens, `workspace:add_project_method_click` when the user picks another way
 * to add, and `workspace:add_project_dialog_cancel` when they close it without
 * adding. Added Code projects emit `workspace:project_update`; Cowork projects
 * emit `cowork:project_update`. Only the fixed method is sent: no names,
 * paths, URLs or organization data.
 */

/** The way to add a project the dialog is showing. */
export type AddProjectMethod =
  | 'catalog'
  | 'cloud'
  | 'remote'
  | 'existing'
  | 'create';

const DIALOG_OPERATION = 'canopy.add_project_dialog';
const METHOD_OPERATION = 'canopy.add_project_method';
const CANCEL_OPERATION = 'canopy.add_project_dialog_cancel';

function emit(
  name:
    | typeof DIALOG_OPERATION
    | typeof METHOD_OPERATION
    | typeof CANCEL_OPERATION,
  context: { project_method: AddProjectMethod } | Record<string, never>,
): void {
  startClientOperation(name, { context });
  succeedClientOperation(name, { context });
}

export function trackAddProjectDialogOpen(): void {
  emit(DIALOG_OPERATION, {});
}

export function trackAddProjectMethodClick(method: AddProjectMethod): void {
  emit(METHOD_OPERATION, { project_method: method });
}

export function trackAddProjectDialogCancel(method: AddProjectMethod): void {
  emit(CANCEL_OPERATION, { project_method: method });
}
