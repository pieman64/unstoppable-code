import {
  isScriptActionsListRequest,
  isScriptActionsContext,
  isScriptActionsReviewRequest,
  isScriptActionsShortcutRequest,
  isScriptActionsPinRequest,
  isScriptActionsReceiptRequest,
  isScriptActionsSnapshot,
  isScriptActionsAddReceipt,
  type ScriptActionsSnapshot,
  type ScriptActionsAddReceipt,
  type ScriptActionsResult,
} from '@canopy/protocol/script-actions';
import {
  ScriptActionsError,
  type ScriptActionsService,
} from './script-actions-service';
export type ScriptActionsOperation =
  | 'list'
  | 'rescan'
  | 'review'
  | 'setShortcut'
  | 'setPinned'
  | 'enableShellAliasScan'
  | 'receipt';
export function validScriptActionsRequest(
  operation: ScriptActionsOperation,
  input: unknown,
): boolean {
  switch (operation) {
    case 'list':
      return isScriptActionsListRequest(input);
    case 'rescan':
    case 'enableShellAliasScan':
      return isScriptActionsContext(input);
    case 'review':
      return isScriptActionsReviewRequest(input);
    case 'setShortcut':
      return isScriptActionsShortcutRequest(input);
    case 'setPinned':
      return isScriptActionsPinRequest(input);
    case 'receipt':
      return isScriptActionsReceiptRequest(input);
  }
}
export async function dispatchScriptActionsOperation(
  service: ScriptActionsService,
  operation: ScriptActionsOperation,
  input: unknown,
): Promise<
  ScriptActionsResult<ScriptActionsSnapshot | ScriptActionsAddReceipt | null>
> {
  try {
    let result: ScriptActionsSnapshot | ScriptActionsAddReceipt | null;
    if (operation === 'list' && isScriptActionsListRequest(input))
      result = await service.list(input);
    else if (operation === 'rescan' && isScriptActionsContext(input))
      result = await service.rescan(input);
    else if (operation === 'review' && isScriptActionsReviewRequest(input))
      result = await service.review(input);
    else if (
      operation === 'setShortcut' &&
      isScriptActionsShortcutRequest(input)
    )
      result = await service.setShortcut(input);
    else if (operation === 'setPinned' && isScriptActionsPinRequest(input))
      result = await service.setPinned(input);
    else if (
      operation === 'enableShellAliasScan' &&
      isScriptActionsContext(input)
    )
      result = await service.enableShellAliasScan(input);
    else if (operation === 'receipt' && isScriptActionsReceiptRequest(input))
      result = await service.receipt(input);
    else
      throw new ScriptActionsError(
        'invalid_payload',
        'Invalid script action request.',
      );
    if (
      operation === 'receipt'
        ? result !== null && !isScriptActionsAddReceipt(result)
        : !isScriptActionsSnapshot(result)
    )
      throw new ScriptActionsError(
        'invalid_payload',
        'Invalid script action response.',
      );
    return { ok: true, value: result };
  } catch (error) {
    if (error instanceof ScriptActionsError)
      return { ok: false, error: { code: error.code, message: error.message } };
    return {
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'Script action target is unavailable.',
      },
    };
  }
}
