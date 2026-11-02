/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SafetyDenyReason } from '@canopy/protocol/approvals';
import {
  APPROVAL_SAFETY_DENIED_COPY,
  ApprovalSafetyDeniedNotice,
} from '../ApprovalSafetyDeniedNotice';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ApprovalSafetyDeniedNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function notice(): HTMLElement | null {
    return container.querySelector(
      '[data-testid="approval-safety-denied-notice"]',
    );
  }

  it.each<[SafetyDenyReason, string, string]>([
    [
      'force-push',
      'Force-push blocked by a safety rule.',
      'This call cannot be approved from a prompt.',
    ],
    [
      'destructive-delete',
      'Destructive delete blocked by a safety rule.',
      'This call cannot be approved from a prompt.',
    ],
    [
      'disk-write',
      'Disk write blocked by a safety rule.',
      'This call cannot be approved from a prompt.',
    ],
    [
      'unverifiable-command',
      'Command blocked by a safety rule.',
      'Its effect could not be checked. This call cannot be approved from a prompt.',
    ],
  ])('renders the %s copy as an attention status', (reason, title, message) => {
    act(() =>
      root.render(
        <ApprovalSafetyDeniedNotice reason={reason} command="git push -f" />,
      ),
    );
    const element = notice();
    expect(element?.getAttribute('data-safety-reason')).toBe(reason);
    expect(element?.getAttribute('data-notice-intent')).toBe('attention');
    expect(element?.getAttribute('role')).toBe('status');
    expect(element?.textContent).toContain(title);
    expect(element?.textContent).toContain(message);
    // The title carries its own stop; Notice must not add a second one.
    expect(element?.textContent).not.toContain('..');
    expect(element?.querySelectorAll('button')).toHaveLength(0);
  });

  it('covers every reason', () => {
    expect(Object.keys(APPROVAL_SAFETY_DENIED_COPY).sort()).toEqual([
      'destructive-delete',
      'disk-write',
      'force-push',
      'unverifiable-command',
    ]);
  });

  it('renders the command as replay-blocked, wrapping text', () => {
    const command = `git push --force origin HEAD <img src=x onerror=alert(1)> ${'x'.repeat(500)}\n[truncated]`;
    act(() =>
      root.render(
        <ApprovalSafetyDeniedNotice reason="force-push" command={command} />,
      ),
    );
    const detail = container.querySelector(
      '[data-testid="approval-safety-denied-command"]',
    );
    expect(detail?.textContent).toBe(command);
    expect(detail?.querySelector('img')).toBeNull();
    expect(detail?.classList.contains('ph-no-capture')).toBe(true);
    expect(detail?.className).toContain('whitespace-pre-wrap');
    expect(detail?.className).toContain('wrap-anywhere');
    // Only the command is replay content; the title and message stay visible.
    expect(notice()?.classList.contains('ph-no-capture')).toBe(false);
  });

  it('omits the command line when there is no display text', () => {
    act(() =>
      root.render(
        <ApprovalSafetyDeniedNotice reason="unverifiable-command" command="" />,
      ),
    );
    expect(
      container.querySelector('[data-testid="approval-safety-denied-command"]'),
    ).toBeNull();
  });

  it('keeps its live region untouched across ordinary rerenders', () => {
    act(() =>
      root.render(
        <ApprovalSafetyDeniedNotice
          reason="force-push"
          command="git push -f"
        />,
      ),
    );
    const before = notice();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) =>
      mutations.push(...records),
    );
    if (before) {
      observer.observe(before, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    act(() =>
      root.render(
        <ApprovalSafetyDeniedNotice
          reason="force-push"
          command="git push -f"
        />,
      ),
    );
    mutations.push(...observer.takeRecords());
    observer.disconnect();
    expect(notice()).toBe(before);
    expect(mutations).toHaveLength(0);
  });
});
