import type {
  BrowserActionError,
  BrowserActionReceipt,
  BrowserActionTargetState,
  BrowserInputMode,
  BrowserJavaScriptDialog,
} from '@canopy/execution-engine/types/browser';
import type { ResolvedActionTarget } from '../frames/action-targets';
import type { ActionLaneContext } from './action-lane';
import type { BrowserCdpSend } from './actionability';
import type {
  ClickDispatchResult,
  FocusDispatchResult,
  InputAttribution,
} from './input-dispatch';

/** Dependencies for form algorithms; page calls use the isolated host object. */
export interface FormActionOptions {
  /** Tracks each command on the lane once input has been sent. */
  send: BrowserCdpSend;
  cleanupSend?: BrowserCdpSend;
  lane: ActionLaneContext;
  target: ResolvedActionTarget;
  secret: boolean;
  /**
   * Asks the page model again whether the target is secret, after input
   * changed the page. Once it is secret, it stays secret.
   */
  refreshSecret?: () => Promise<boolean>;
  /**
   * Called with the node the input goes to when it is not the target, such
   * as an editing host reached through a child, before that node is focused
   * or cleared. True when it is secret; the receipt and the recording then
   * treat the action as secret.
   */
  classifyInputTarget?: (target: ResolvedActionTarget) => Promise<boolean>;
  /**
   * Called when the action's own check of the page finds the target secret,
   * such as a select that gains a secret token on focus. The page can drop
   * the marker again before the action ends, so the service is told at once:
   * the receipt and the recording then treat the action as secret.
   */
  markSecret?: () => void;
  /** Marks editor input so the main-owned fill step replaces page reports. */
  onEditor?: () => void;
  /**
   * The user is picking an element. Only a fill that needs no pointer input
   * runs: clearing an editor can take a real click, which would be the pick.
   */
  pickMode?: boolean;
  timeoutMs?: number;
  beforeInput?: (event: InputAttribution) => void;
  click(
    target: { objectId: string; backendNodeId: number },
    clickCount?: number,
  ): Promise<ClickDispatchResult>;
  focus(target?: {
    objectId: string;
    backendNodeId: number;
  }): Promise<FocusDispatchResult>;
  getPendingDialog?: () => BrowserJavaScriptDialog | undefined;
}

/** State discrepancies are successful executions with readback, not errors. */
export interface FormActionResult {
  inputMode?: BrowserInputMode;
  warnings?: string[];
  readback?: BrowserActionReceipt['readback'];
  target?: Partial<BrowserActionTargetState>;
  editor?: boolean;
  /** The normalized editing host, retained in the original object group. */
  recordingTarget?: ResolvedActionTarget;
  completed?: boolean;
  dialog?: BrowserJavaScriptDialog;
  settleMs?: number;
}

/** A refusal established by reads, before any input is sent. */
export class FormActionError extends Error {
  constructor(readonly error: BrowserActionError) {
    super(error.message);
    this.name = 'FormActionError';
  }
}

/** Post-settle state supersedes the algorithm's earlier observations. */
export function mergeFormActionTargetState(
  described: BrowserActionTargetState,
  observed?: Partial<BrowserActionTargetState>,
): BrowserActionTargetState {
  const target = { ...observed, ...described };
  if (target.valueRedacted || target.optionsRedacted) {
    delete target.value;
    delete target.validationMessage;
  }
  if (target.optionsRedacted) {
    delete target.options;
    delete target.selectedOptions;
    delete target.name;
  }
  return target;
}
