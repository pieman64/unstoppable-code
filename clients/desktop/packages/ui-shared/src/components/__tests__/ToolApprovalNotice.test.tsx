/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TOOL_APPROVAL_PREVIEW_CHARS,
  ToolApprovalNotice,
  type ToolApprovalNoticeProps,
} from '../ToolApprovalNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ToolApprovalNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(props: Partial<ToolApprovalNoticeProps> = {}): void {
    act(() =>
      root.render(
        <ToolApprovalNotice toolName="Bash" input="ls -la" {...props} />,
      ),
    );
  }

  const byTestId = (id: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${id}"]`);

  function click(id: string): void {
    const element = byTestId(id);
    if (!element) throw new Error(`missing ${id}`);
    act(() => element.click());
  }

  it('renders tool input as plain text, never as markup', () => {
    render({ input: '<img src=x onerror="alert(1)"><script>x</script>' });

    expect(container.querySelector('img, script')).toBeNull();
    expect(byTestId('tool-approval-input')?.textContent).toBe(
      '<img src=x onerror="alert(1)"><script>x</script>',
    );
  });

  it('truncates a long input until the person expands it', () => {
    const input = 'a'.repeat(TOOL_APPROVAL_PREVIEW_CHARS + 50);
    render({ input });

    expect(byTestId('tool-approval-input')?.textContent).toHaveLength(
      TOOL_APPROVAL_PREVIEW_CHARS + 1,
    );
    expect(
      byTestId('tool-approval-expand')?.getAttribute('aria-expanded'),
    ).toBe('false');

    click('tool-approval-expand');

    expect(byTestId('tool-approval-input')?.textContent).toBe(input);
    expect(byTestId('tool-approval-expand')?.textContent).toBe('Show less');
  });

  it('offers Deny beside Allow and reports each decision', () => {
    const onDecide = jest.fn();
    render({ onDecide });

    const buttons = [
      ...container.querySelectorAll('[data-testid^="tool-approval-"]'),
    ].filter((element) => element.tagName === 'BUTTON');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Deny',
      'Allow',
    ]);

    click('tool-approval-deny');
    click('tool-approval-allow');
    expect(onDecide.mock.calls).toEqual([[false], [true]]);
  });

  it('disables both buttons while a decision is sending', () => {
    render({ onDecide: jest.fn(), sending: 'deny' });

    expect(byTestId('tool-approval-deny')?.hasAttribute('disabled')).toBe(true);
    expect(byTestId('tool-approval-allow')?.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows the hint and no buttons to someone who may not decide', () => {
    render({ readOnlyHint: 'Sign in to approve or deny.' });

    expect(container.textContent).toContain('Sign in to approve or deny.');
    expect(byTestId('tool-approval-allow')).toBeNull();
    expect(byTestId('tool-approval-deny')).toBeNull();
  });

  it('says a refused decision was not accepted and lets the person decide again', () => {
    render({ onDecide: jest.fn(), rejected: true });

    expect(container.textContent).toContain("Your decision wasn't accepted.");
    expect(byTestId('tool-approval-allow')?.hasAttribute('disabled')).toBe(
      false,
    );
    expect(byTestId('tool-approval-deny')?.hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('after a failed send offers only to retry the same decision', () => {
    const onDecide = jest.fn();
    const onRetry = jest.fn();
    render({ onDecide, onRetry, sending: 'deny', failed: true });

    expect(container.textContent).toContain("Couldn't send your denial.");
    expect(byTestId('tool-approval-allow')).toBeNull();
    expect(byTestId('tool-approval-deny')).toBeNull();

    click('tool-approval-retry');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDecide).not.toHaveBeenCalled();
  });
});
