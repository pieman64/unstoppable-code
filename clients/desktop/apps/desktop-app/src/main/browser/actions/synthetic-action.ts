import type {
  BrowserJavaScriptDialogResponse,
  BrowserKeyModifier,
  BrowserMouseButton,
} from '@canopy/desktop-shared/types/browser';

/** What the direct (synthetic) action does on the retained target. */
export interface SyntheticAction {
  kind: 'click' | 'press';
  key?: string;
  button?: BrowserMouseButton;
  clickCount?: number;
  modifiers?: BrowserKeyModifier[];
  dialogResponse?: BrowserJavaScriptDialogResponse;
}

/**
 * The main-world function the forced, covered and no-focus fallbacks call
 * on the retained target with a user gesture. With a dialog response, the
 * dialog wrappers and the action run in this one evaluation, so unrelated
 * page activity cannot consume the response in between; only the first
 * dialog is answered.
 */
export function syntheticActionDeclaration(
  action: SyntheticAction,
  promptLimit: number,
): string {
  const actionConfig = JSON.stringify({
    kind: action.kind,
    key: action.key ?? '',
    button: action.button ?? 'left',
    clickCount: action.clickCount ?? 1,
    modifiers: action.modifiers ?? [],
    ...(action.dialogResponse
      ? {
          dialogResponse: {
            accept: action.dialogResponse.accept,
            promptText: action.dialogResponse.promptText?.slice(0, promptLimit),
          },
        }
      : {}),
  });
  return `function () {
                  const action = ${actionConfig};
                  const invoke = () => {
                    if (action.kind === 'press') {
                      this.dispatchEvent(new KeyboardEvent('keydown', {
                        bubbles: true,
                        cancelable: true,
                        key: action.key,
                      }));
                      return;
                    }
                    const modifiers = action.modifiers;
                    const eventOptions = (button, detail) => ({
                      bubbles: true,
                      cancelable: true,
                      button,
                      detail,
                      altKey: modifiers.includes('Alt'),
                      ctrlKey: modifiers.includes('Control'),
                      metaKey: modifiers.includes('Meta'),
                      shiftKey: modifiers.includes('Shift'),
                    });
                    if (action.button === 'right') {
                      this.dispatchEvent(new MouseEvent(
                        'contextmenu',
                        eventOptions(2, 1),
                      ));
                      return;
                    }
                    if (action.button === 'middle') {
                      this.dispatchEvent(new MouseEvent(
                        'auxclick',
                        eventOptions(1, 1),
                      ));
                      return;
                    }
                    if (
                      action.clickCount === 1 &&
                      modifiers.length === 0 &&
                      this instanceof HTMLElement
                    ) {
                      this.click();
                      return;
                    }
                    for (let detail = 1; detail <= action.clickCount; detail += 1) {
                      this.dispatchEvent(new MouseEvent(
                        'click',
                        eventOptions(0, detail),
                      ));
                      if (detail === 2) {
                        this.dispatchEvent(new MouseEvent(
                          'dblclick',
                          eventOptions(0, 2),
                        ));
                      }
                    }
                  };
                  if (!action.dialogResponse) {
                    invoke();
                    return { capture: null };
                  }
                  const root = this.ownerDocument?.defaultView;
                  if (!root) throw new Error('Browser action window was unavailable.');
                  const originals = {
                    alert: root.alert,
                    confirm: root.confirm,
                    prompt: root.prompt,
                  };
                  let capture = null;
                  let restored = false;
                  const restore = () => {
                    if (restored) return;
                    restored = true;
                    root.alert = originals.alert;
                    root.confirm = originals.confirm;
                    root.prompt = originals.prompt;
                  };
                  const intercept = (type, message, defaultPrompt) => {
                    if (capture) {
                      return originals[type].call(root, message, defaultPrompt);
                    }
                    capture = {
                      type,
                      message: String(message ?? ''),
                      ...(type === 'prompt'
                        ? { defaultPrompt: String(defaultPrompt ?? '') }
                        : {}),
                      url: String(root.location?.href ?? ''),
                      openedAt: Date.now(),
                    };
                    restore();
                    if (type === 'alert') return undefined;
                    if (type === 'confirm') return action.dialogResponse.accept;
                    return action.dialogResponse.accept
                      ? String(action.dialogResponse.promptText ?? defaultPrompt ?? '')
                      : null;
                  };
                  root.alert = (message) => intercept('alert', message);
                  root.confirm = (message) => intercept('confirm', message);
                  root.prompt = (message, defaultPrompt) =>
                    intercept('prompt', message, defaultPrompt);
                  try {
                    invoke();
                    return { capture };
                  } finally {
                    restore();
                  }
              }`;
}
