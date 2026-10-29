import { z } from 'zod/v4';
import type { AgentBrowserPort } from '../../port/browser-port';
import {
  defineAgentActionFamily,
  type AgentActionFamily,
} from '../../surface/family';
import { findUiOnlyActionField } from '../../tools/dispatch-action';
import { BROWSER_ACTION_TYPES } from './actions';
import { browserActionCatalog } from './catalog';
import {
  projectBrowserControlAction,
  projectBrowserPointerViewportAction,
} from './command';
import { browserDispatchJsonSchema } from './dispatch-json';
import { addMcpBrowserTargetIssues, mcpBrowserActionSchemas } from './schemas';

export { BROWSER_ACTION_TYPES, type BrowserActionType } from './actions';
export { browserActionCatalog } from './catalog';
export {
  BROWSER_DISPATCH_JSON_PROPERTIES,
  browserDispatchJsonSchema,
} from './dispatch-json';
export type { AgentBrowserAction } from './types';

/** A chat agent's browser action payload, with the shared rules checked. */
export const browserActionInputSchema = z
  .discriminatedUnion('type', mcpBrowserActionSchemas)
  .superRefine((action, context) => {
    addMcpBrowserTargetIssues(action, context);
  });

/**
 * A validated browser action payload, with pointer and form actions
 * projected into their exclusive command shapes.
 */
export const browserActionSchema = browserActionInputSchema.transform(
  (action) => {
    if (
      action.type === 'browser.hover' ||
      action.type === 'browser.scroll' ||
      action.type === 'browser.drag'
    )
      return projectBrowserPointerViewportAction(action);
    if (
      action.type === 'browser.set_checked' ||
      action.type === 'browser.select_option' ||
      action.type === 'browser.type' ||
      action.type === 'browser.upload_files' ||
      action.type === 'browser.request_files' ||
      action.type === 'browser.drop_files'
    )
      return projectBrowserControlAction(action);
    return action;
  },
);

export type BrowserDispatchAction = z.output<typeof browserActionSchema>;

/** The first UI-only field of a browser action, or null. */
export function findBrowserUiOnlyField(action: unknown): string | null {
  if (typeof action !== 'object' || action === null || Array.isArray(action))
    return null;
  const fields: Record<string, unknown> = { ...action };
  // A validated browser profile selection is account authority, not UI state.
  return findUiOnlyActionField(
    fields,
    '',
    (field) =>
      field === 'selection' &&
      (fields.type === 'browser.open' ||
        fields.type === 'browser.profile.switch'),
  );
}

/**
 * The in-app browser actions. Validation, catalog rows and the advertised
 * schema are shared; the host port runs each action on its browser. Browser
 * actions retry through their own actionId receipts, so the family adds no
 * idempotency or limits wrapping.
 */
export function createBrowserActionFamily<H>(options: {
  port: AgentBrowserPort<H>;
}): AgentActionFamily<H> {
  return defineAgentActionFamily<H, BrowserDispatchAction>({
    id: 'browser',
    types: BROWSER_ACTION_TYPES,
    actionSchema: browserActionSchema,
    supportedTypes: () => BROWSER_ACTION_TYPES,
    catalog: browserActionCatalog,
    dispatchJsonSchema: browserDispatchJsonSchema,
    findUiOnlyField: findBrowserUiOnlyField,
    hiddenFields: ['projectId', 'worktreeId'],
    dispatch: (action, call) => options.port.dispatch(action, call),
  });
}
