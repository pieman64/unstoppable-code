import type {
  BrowserConsoleLevel,
  BrowserDragDestination,
  BrowserElementTarget,
  BrowserFileInputTarget,
  BrowserJavaScriptDialogResponse,
  BrowserKeyModifier,
  BrowserLoadState,
  BrowserMouseButton,
  BrowserNoElementTarget,
  BrowserOptionChoice,
  BrowserProfileSwitchRequest,
  BrowserSavePdfRequest,
  BrowserScrollMode,
  BrowserTransferStatus,
  BrowserUploadSource,
  BrowserWaitForState,
} from '@canopy/protocol/browser';
import type {
  BrowserMaintenanceOperation,
  BrowserProfileSelection,
} from '@canopy/protocol/browser-profiles';

/**
 * One browser agent action payload. App Advisor addresses a browser in a
 * workspace by projectId and worktreeId; chat surfaces supply them
 * server-side.
 */
export type AgentBrowserAction = {
  /**
   * Omit both fields to target App Advisor's own Work Entry browser. Supply
   * both to target a browser owned by a workspace/worktree in the main window.
   */
  expectedRuntimeGeneration?: number;
  projectId?: string;
  worktreeId?: string;
} & (
  | {
      type: 'browser.profile.preview_clear';
      profileId: string;
      storageGeneration: number;
      metadataRevision: number;
      operation: BrowserMaintenanceOperation;
    }
  | { type: 'browser.profile.clear'; operationId: string; token: string }
  | { type: 'browser.profile.job_get'; jobId: string }
  | { type: 'browser.profile.job_cancel'; jobId: string }
  | { type: 'browser.profile.list'; offset?: number }
  | { type: 'browser.profile.get'; profileId: string }
  | ({
      type: 'browser.profile.switch';
    } & BrowserProfileSwitchRequest)
  | { type: 'browser.list' }
  | {
      type: 'browser.open';
      handoff?: boolean;
      browserId?: string;
      url?: string;
      selection?: BrowserProfileSelection;
    }
  | { type: 'browser.navigate'; browserId?: string; url: string }
  | { type: 'browser.back'; browserId?: string }
  | { type: 'browser.forward'; browserId?: string }
  | { type: 'browser.reload'; browserId?: string }
  | { type: 'browser.stop'; browserId?: string }
  | { type: 'browser.get_dialog'; browserId?: string }
  | {
      type: 'browser.handle_dialog';
      browserId?: string;
      dialogId: string;
      accept: boolean;
      promptText?: string;
    }
  | {
      type: 'browser.click';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      ref?: string;
      locator?: string;
      frame?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      clickCount?: number;
      modifiers?: BrowserKeyModifier[];
      position?: { x: number; y: number };
      force?: boolean;
      dialogResponse?: BrowserJavaScriptDialogResponse;
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.fill';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      ref?: string;
      locator?: string;
      frame?: string;
      text: string;
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.press';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      key: string;
      ref?: string;
      locator?: string;
      frame?: string;
      dialogResponse?: BrowserJavaScriptDialogResponse;
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.focus';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      ref?: string;
      locator?: string;
      frame?: string;
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.wait_for';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      locator?: string;
      frame?: string;
      text?: string;
      state?: BrowserWaitForState;
      url?: string;
      loadState?: BrowserLoadState;
      /**
       * A download to finish. Without `downloadId`, the next download this
       * browser starts after the wait begins.
       */
      download?: { downloadId?: string };
      /** An upload to be attached, or to end without attaching. */
      upload?: { uploadId: string };
      actionId?: string;
      timeoutMs?: number;
    }
  | ({
      type: 'browser.hover';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      timeoutMs?: number;
    } & (
      | (BrowserElementTarget & { x?: never; y?: never })
      | (BrowserNoElementTarget & { x: number; y: number })
    ))
  | ({
      type: 'browser.scroll';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      timeoutMs?: number;
    } & BrowserScrollMode)
  | {
      type: 'browser.drag';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      from: BrowserElementTarget;
      to: BrowserDragDestination;
      steps?: number;
      modifiers?: BrowserKeyModifier[];
      actionId?: string;
      timeoutMs?: number;
    }
  | ({
      type: 'browser.set_checked';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      timeoutMs?: number;
    } & BrowserElementTarget & { checked: boolean })
  | ({
      type: 'browser.select_option';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      timeoutMs?: number;
    } & BrowserElementTarget &
      BrowserOptionChoice & { searchText?: string })
  | ({
      type: 'browser.type';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      timeoutMs?: number;
    } & (BrowserElementTarget | BrowserNoElementTarget) & {
        text: string;
        delayMs?: number;
      })
  | {
      type: 'browser.screenshot';
      browserId?: string;
      saveToAttachments?: boolean;
    }
  | {
      type: 'browser.input_snapshot';
      browserId?: string;
      frame?: string;
      inputType?: string;
      role?: string;
      name?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: 'browser.inspect';
      browserId?: string;
      ref?: string;
      locator?: string;
      frame?: string;
      x?: number;
      y?: number;
    }
  | {
      type: 'browser.get_console';
      browserId?: string;
      level?: BrowserConsoleLevel;
      limit?: number;
    }
  | {
      type: 'browser.get_network';
      browserId?: string;
      failed?: boolean;
      status?: number;
      urlContains?: string;
      limit?: number;
    }
  | {
      type: 'browser.list_transfers';
      browserId?: string;
      kind?: 'download' | 'copy' | 'upload';
      status?: BrowserTransferStatus;
      offset?: number;
      limit?: number;
    }
  | {
      type: 'browser.cancel_transfer';
      browserId?: string;
      transferId: string;
    }
  | {
      type: 'browser.save_download';
      browserId?: string;
      downloadId: string;
      /** Relative to the workspace root. */
      path: string;
      overwrite?: boolean;
      actionId?: string;
      timeoutMs?: number;
    }
  | ({
      type: 'browser.upload_files';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      timeoutMs?: number;
    } & BrowserFileInputTarget & {
        files: BrowserUploadSource[];
      })
  | ({
      type: 'browser.drop_files';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      timeoutMs?: number;
    } & BrowserElementTarget & {
        files: BrowserUploadSource[];
      })
  | ({
      type: 'browser.save_pdf';
      browserId?: string;
      expectedRuntimeGeneration?: number;
    } & Omit<BrowserSavePdfRequest, 'browserId' | 'expectedRuntimeGeneration'>)
  | ({
      type: 'browser.request_files';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      actionId?: string;
      /** Why the agent asks, shown to the user as the agent's words. */
      purpose?: string;
    } & BrowserFileInputTarget)
  | { type: 'browser.start_recording'; browserId?: string }
  | {
      type: 'browser.stop_recording';
      browserId?: string;
      saveToAttachments?: boolean;
    }
  | {
      type: 'browser.open_external';
      browserId?: string;
      url?: string;
    }
);
