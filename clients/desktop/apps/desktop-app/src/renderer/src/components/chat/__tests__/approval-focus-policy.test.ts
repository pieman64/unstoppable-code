/**
 * @jest-environment jsdom
 */
import {
  canApprovalTakeFocus,
  type ApprovalFocusContext,
} from '../approval-focus-policy';

describe('canApprovalTakeFocus', () => {
  let composerRoot: HTMLDivElement;
  let editable: HTMLDivElement;

  beforeEach(() => {
    composerRoot = document.createElement('div');
    editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    composerRoot.appendChild(editable);
    document.body.appendChild(composerRoot);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  function context(
    overrides: Partial<ApprovalFocusContext>,
  ): ApprovalFocusContext {
    return {
      activeElement: document.body,
      body: document.body,
      composerRoot,
      composerDraftText: '',
      composing: false,
      modalOpen: false,
      ...overrides,
    };
  }

  it('takes focus from the body', () => {
    expect(canApprovalTakeFocus(context({}))).toBe(true);
  });

  it('takes focus from an empty or whitespace-only composer', () => {
    expect(canApprovalTakeFocus(context({ activeElement: editable }))).toBe(
      true,
    );
    expect(
      canApprovalTakeFocus(
        context({ activeElement: editable, composerDraftText: ' \n\t ' }),
      ),
    ).toBe(true);
  });

  it('keeps focus in a composer with a draft', () => {
    expect(
      canApprovalTakeFocus(
        context({ activeElement: editable, composerDraftText: 'wip' }),
      ),
    ).toBe(false);
  });

  it('declines during IME composition, even before text commits', () => {
    expect(
      canApprovalTakeFocus(
        context({ activeElement: editable, composing: true }),
      ),
    ).toBe(false);
    expect(canApprovalTakeFocus(context({ composing: true }))).toBe(false);
  });

  it('declines while a modal dialog is open', () => {
    expect(canApprovalTakeFocus(context({ modalOpen: true }))).toBe(false);
  });

  it('declines without focus evidence or a composer', () => {
    expect(canApprovalTakeFocus(context({ activeElement: null }))).toBe(false);
    expect(canApprovalTakeFocus(context({ composerRoot: null }))).toBe(false);
    expect(canApprovalTakeFocus(context({ body: null }))).toBe(false);
  });

  it('keeps focus on other editable surfaces and buttons', () => {
    const textarea = document.createElement('textarea');
    const button = document.createElement('button');
    document.body.append(textarea, button);
    expect(canApprovalTakeFocus(context({ activeElement: textarea }))).toBe(
      false,
    );
    expect(canApprovalTakeFocus(context({ activeElement: button }))).toBe(
      false,
    );
  });
});
