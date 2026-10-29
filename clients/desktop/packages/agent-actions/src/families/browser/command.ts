import type { RawAdvisorBrowserAction } from './schemas';
import type {
  BrowserAutomationCommand,
  BrowserElementTarget,
  BrowserFileInputTarget,
  BrowserUploadSource,
} from '@canopy/protocol/browser';
import type { AgentBrowserAction } from './types';

export function buildBrowserAutomationCommand(
  action:
    | Extract<
        AgentBrowserAction,
        {
          type:
            | 'browser.click'
            | 'browser.fill'
            | 'browser.press'
            | 'browser.focus'
            | 'browser.wait_for'
            | 'browser.hover'
            | 'browser.scroll'
            | 'browser.drag'
            | 'browser.set_checked'
            | 'browser.select_option'
            | 'browser.type'
            | 'browser.upload_files'
            | 'browser.request_files'
            | 'browser.drop_files';
        }
      >
    | Extract<
        RawAdvisorBrowserAction,
        {
          type:
            | 'browser.hover'
            | 'browser.scroll'
            | 'browser.drag'
            | 'browser.set_checked'
            | 'browser.select_option'
            | 'browser.type'
            | 'browser.upload_files'
            | 'browser.request_files'
            | 'browser.drop_files';
        }
      >,
): BrowserAutomationCommand {
  switch (action.type) {
    case 'browser.hover': {
      const common = commonFields(action);
      if (action.ref !== undefined || action.locator !== undefined)
        return { kind: 'hover', ...elementTarget(action), ...common };
      if (action.x === undefined || action.y === undefined)
        throw new Error('browser.hover requires x and y.');
      return { kind: 'hover', x: action.x, y: action.y, ...common };
    }
    case 'browser.scroll': {
      const common = commonFields(action);
      if (action.toText !== undefined)
        return {
          kind: 'scroll',
          toText: action.toText,
          ...(action.frame === undefined ? {} : { frame: action.frame }),
          ...common,
        };
      if (action.intoView === true)
        return {
          kind: 'scroll',
          intoView: true,
          ...elementTarget(action),
          ...common,
        };
      if (action.direction === undefined)
        throw new Error('browser.scroll requires direction.');
      const target =
        action.ref !== undefined || action.locator !== undefined
          ? elementTarget(action)
          : {};
      if (action.pixels !== undefined)
        return {
          kind: 'scroll',
          direction: action.direction,
          pixels: action.pixels,
          ...target,
          ...common,
        };
      return {
        kind: 'scroll',
        direction: action.direction,
        ...(action.pages === undefined ? {} : { pages: action.pages }),
        ...target,
        ...common,
      };
    }
    case 'browser.drag':
      return {
        kind: 'drag',
        from: action.from,
        to: action.to,
        ...(action.steps === undefined ? {} : { steps: action.steps }),
        ...(action.modifiers === undefined
          ? {}
          : { modifiers: action.modifiers }),
        ...commonFields(action),
      };
    case 'browser.set_checked':
      return {
        kind: 'set_checked',
        ...elementTarget(action),
        checked: action.checked,
        ...commonFields(action),
      };
    case 'browser.select_option': {
      const target = elementTarget(action);
      const common = commonFields(action);
      if (action.values !== undefined)
        return {
          kind: 'select_option',
          ...target,
          values: action.values,
          ...(action.searchText === undefined
            ? {}
            : { searchText: action.searchText }),
          ...common,
        };
      if (action.labels !== undefined)
        return {
          kind: 'select_option',
          ...target,
          labels: action.labels,
          ...(action.searchText === undefined
            ? {}
            : { searchText: action.searchText }),
          ...common,
        };
      if (action.indexes !== undefined)
        return {
          kind: 'select_option',
          ...target,
          indexes: action.indexes,
          ...(action.searchText === undefined
            ? {}
            : { searchText: action.searchText }),
          ...common,
        };
      throw new Error(
        'browser.select_option requires exactly one of values, labels, or indexes.',
      );
    }
    case 'browser.type':
      return {
        kind: 'type',
        ...(action.ref !== undefined || action.locator !== undefined
          ? elementTarget(action)
          : {}),
        text: action.text,
        ...(action.delayMs === undefined ? {} : { delayMs: action.delayMs }),
        ...commonFields(action),
      };
    case 'browser.upload_files':
      return {
        kind: 'upload_files',
        ...fileInputTarget(action),
        files: uploadSources(action.files),
        ...commonFields(action),
      };
    case 'browser.drop_files':
      return {
        kind: 'drop_files',
        ...elementTarget(action),
        files: uploadSources(action.files),
        ...commonFields(action),
      };
    case 'browser.request_files':
      return {
        kind: 'request_files',
        ...fileInputTarget(action),
        ...(action.purpose === undefined ? {} : { purpose: action.purpose }),
        ...(action.actionId === undefined ? {} : { actionId: action.actionId }),
      };
    case 'browser.click':
      return {
        kind: 'click',
        ...(action.ref === undefined ? {} : { ref: action.ref }),
        ...(action.locator === undefined ? {} : { locator: action.locator }),
        ...(action.frame === undefined ? {} : { frame: action.frame }),
        ...(action.x === undefined ? {} : { x: action.x }),
        ...(action.y === undefined ? {} : { y: action.y }),
        ...(action.button === undefined ? {} : { button: action.button }),
        ...(action.clickCount === undefined
          ? {}
          : { clickCount: action.clickCount }),
        ...(action.modifiers === undefined
          ? {}
          : { modifiers: action.modifiers }),
        ...(action.position === undefined ? {} : { position: action.position }),
        ...(action.force === undefined ? {} : { force: action.force }),
        ...(action.dialogResponse === undefined
          ? {}
          : { dialogResponse: action.dialogResponse }),
        ...(action.actionId === undefined ? {} : { actionId: action.actionId }),
        ...(action.timeoutMs === undefined
          ? {}
          : { timeoutMs: action.timeoutMs }),
      };
    case 'browser.fill':
      return {
        kind: 'fill',
        ...(action.ref === undefined ? {} : { ref: action.ref }),
        ...(action.locator === undefined ? {} : { locator: action.locator }),
        ...(action.frame === undefined ? {} : { frame: action.frame }),
        text: action.text,
        ...(action.actionId === undefined ? {} : { actionId: action.actionId }),
        ...(action.timeoutMs === undefined
          ? {}
          : { timeoutMs: action.timeoutMs }),
      };
    case 'browser.press':
      return {
        kind: 'press',
        key: action.key,
        ...(action.ref === undefined ? {} : { ref: action.ref }),
        ...(action.locator === undefined ? {} : { locator: action.locator }),
        ...(action.frame === undefined ? {} : { frame: action.frame }),
        ...(action.dialogResponse === undefined
          ? {}
          : { dialogResponse: action.dialogResponse }),
        ...(action.actionId === undefined ? {} : { actionId: action.actionId }),
        ...(action.timeoutMs === undefined
          ? {}
          : { timeoutMs: action.timeoutMs }),
      };
    case 'browser.focus':
      return {
        kind: 'focus',
        ...(action.ref === undefined ? {} : { ref: action.ref }),
        ...(action.locator === undefined ? {} : { locator: action.locator }),
        ...(action.frame === undefined ? {} : { frame: action.frame }),
        ...(action.actionId === undefined ? {} : { actionId: action.actionId }),
        ...(action.timeoutMs === undefined
          ? {}
          : { timeoutMs: action.timeoutMs }),
      };
    case 'browser.wait_for':
      return {
        kind: 'wait_for',
        ...(action.locator === undefined ? {} : { locator: action.locator }),
        ...(action.frame === undefined ? {} : { frame: action.frame }),
        ...(action.text === undefined ? {} : { text: action.text }),
        ...(action.state === undefined ? {} : { state: action.state }),
        ...(action.url === undefined ? {} : { url: action.url }),
        ...(action.loadState === undefined
          ? {}
          : { loadState: action.loadState }),
        ...(action.download === undefined ? {} : { download: action.download }),
        ...(action.upload === undefined ? {} : { upload: action.upload }),
        ...(action.actionId === undefined ? {} : { actionId: action.actionId }),
        ...(action.timeoutMs === undefined
          ? {}
          : { timeoutMs: action.timeoutMs }),
      };
    default:
      return assertNever(action);
  }
}

function assertNever(action: never): never {
  void action;
  throw new Error('Unsupported browser automation action');
}

function commonFields(action: { actionId?: string; timeoutMs?: number }): {
  actionId?: string;
  timeoutMs?: number;
} {
  return {
    ...(action.actionId === undefined ? {} : { actionId: action.actionId }),
    ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
  };
}
function elementTarget(action: {
  ref?: string;
  locator?: string;
  frame?: string;
}): BrowserElementTarget {
  if (action.ref !== undefined) return { ref: action.ref };
  if (action.locator !== undefined)
    return {
      locator: action.locator,
      ...(action.frame === undefined ? {} : { frame: action.frame }),
    };
  throw new Error('Provide ref or locator.');
}

function fileInputTarget(action: {
  ref?: string;
  locator?: string;
  frame?: string;
  chooserId?: string;
}): BrowserFileInputTarget {
  return action.chooserId !== undefined
    ? { chooserId: action.chooserId }
    : elementTarget(action);
}

/** Project validated cross-field shapes into the exclusive command contract. */
export function projectBrowserPointerViewportAction(
  action: Extract<
    RawAdvisorBrowserAction,
    { type: 'browser.hover' | 'browser.scroll' | 'browser.drag' }
  >,
): Extract<
  AgentBrowserAction,
  { type: 'browser.hover' | 'browser.scroll' | 'browser.drag' }
> {
  const command = buildBrowserAutomationCommand(action);
  const scope = {
    ...(action.browserId === undefined ? {} : { browserId: action.browserId }),
    ...(action.expectedRuntimeGeneration === undefined
      ? {}
      : { expectedRuntimeGeneration: action.expectedRuntimeGeneration }),
    ...(action.projectId === undefined ? {} : { projectId: action.projectId }),
    ...(action.worktreeId === undefined
      ? {}
      : { worktreeId: action.worktreeId }),
  };
  switch (command.kind) {
    case 'hover': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.hover', ...scope, ...fields };
    }
    case 'scroll': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.scroll', ...scope, ...fields };
    }
    case 'drag': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.drag', ...scope, ...fields };
    }
    default:
      throw new Error('Expected a pointer or viewport command.');
  }
}

/** Each upload source as exactly one of a path, a download id, or an attachment id. */
function uploadSources(
  files: ReadonlyArray<{
    path?: string;
    downloadId?: string;
    attachmentId?: string;
  }>,
): BrowserUploadSource[] {
  return files.map((file) =>
    file.downloadId !== undefined
      ? { downloadId: file.downloadId }
      : file.attachmentId !== undefined
        ? { attachmentId: file.attachmentId }
        : { path: file.path ?? '' },
  );
}

/** Project validated control actions into the exclusive command contract. */
export function projectBrowserControlAction(
  action: Extract<
    RawAdvisorBrowserAction,
    {
      type:
        | 'browser.set_checked'
        | 'browser.select_option'
        | 'browser.type'
        | 'browser.upload_files'
        | 'browser.request_files'
        | 'browser.drop_files';
    }
  >,
): Extract<
  AgentBrowserAction,
  {
    type:
      | 'browser.set_checked'
      | 'browser.select_option'
      | 'browser.type'
      | 'browser.upload_files'
      | 'browser.request_files'
      | 'browser.drop_files';
  }
> {
  const command = buildBrowserAutomationCommand(action);
  const scope = {
    ...(action.browserId === undefined ? {} : { browserId: action.browserId }),
    ...(action.expectedRuntimeGeneration === undefined
      ? {}
      : { expectedRuntimeGeneration: action.expectedRuntimeGeneration }),
    ...(action.projectId === undefined ? {} : { projectId: action.projectId }),
    ...(action.worktreeId === undefined
      ? {}
      : { worktreeId: action.worktreeId }),
  };
  switch (command.kind) {
    case 'set_checked': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.set_checked', ...scope, ...fields };
    }
    case 'select_option': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.select_option', ...scope, ...fields };
    }
    case 'type': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.type', ...scope, ...fields };
    }
    case 'upload_files': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.upload_files', ...scope, ...fields };
    }
    case 'request_files': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.request_files', ...scope, ...fields };
    }
    case 'drop_files': {
      const { kind, ...fields } = command;
      void kind;
      return { type: 'browser.drop_files', ...scope, ...fields };
    }
    default:
      throw new Error('Expected a browser control command.');
  }
}
