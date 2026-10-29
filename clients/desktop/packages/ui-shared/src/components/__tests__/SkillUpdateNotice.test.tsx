/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SkillUpdateNotice,
  SkillUpdateStatus,
  hasSkillUpdateStatus,
  skillUpdateMenuItem,
} from '../SkillUpdateNotice';
import {
  SKILL_UPDATE_DESKTOP_ONLY_REASON,
  type SkillUpdateAction,
} from '../../lib/skill-update-action';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let root: Root | null = null;
let container: HTMLDivElement;

function render(element: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function notice(): HTMLElement | null {
  return container.querySelector('[data-testid="skill-update-notice"]');
}

function click(testId: string): void {
  act(() =>
    container
      .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      ?.click(),
  );
}

type Ready = Extract<SkillUpdateAction, { status: 'ready' }>;

function ready(overrides: Partial<Ready> = {}): Ready {
  return {
    status: 'ready',
    updateAvailable: false,
    pending: 'none',
    onCheck: jest.fn(),
    onApply: jest.fn(),
    ...overrides,
  };
}

describe('SkillUpdateNotice (CAN-4264)', () => {
  it('says nothing without an action or a known update', () => {
    render(<SkillUpdateNotice action={undefined} />);
    expect(notice()).toBeNull();
    act(() => root?.render(<SkillUpdateNotice action={ready()} />));
    expect(notice()).toBeNull();
  });

  it('offers Update for an available update', () => {
    const action = ready({ updateAvailable: true });
    render(<SkillUpdateNotice action={action} />);
    expect(notice()?.getAttribute('data-state')).toBe('available');
    expect(notice()?.textContent).toContain('Update available');
    click('skill-read-detail-apply-update');
    expect(action.onApply).toHaveBeenCalledTimes(1);
  });

  it('shows progress, not a button, while updating', () => {
    render(
      <SkillUpdateNotice
        action={ready({ updateAvailable: true, pending: 'applying' })}
      />,
    );
    expect(notice()?.getAttribute('data-state')).toBe('applying');
    expect(notice()?.textContent).toContain('Updating to the latest version');
    expect(notice()?.querySelector('button')).toBeNull();
  });

  it('puts a failure ahead of the update and retries the right operation', () => {
    const action = ready({
      updateAvailable: true,
      error: { kind: 'update-failed', detail: 'Invalid source in lock file.' },
    });
    render(<SkillUpdateNotice action={action} />);
    expect(notice()?.getAttribute('data-state')).toBe('update-failed');
    expect(notice()?.textContent).toContain('Couldn’t update this skill');
    expect(notice()?.textContent).toContain('Invalid source in lock file.');
    click('skill-update-notice-retry');
    expect(action.onApply).toHaveBeenCalledTimes(1);

    const check = ready({ error: { kind: 'check-failed' } });
    act(() => root?.render(<SkillUpdateNotice action={check} />));
    expect(notice()?.textContent).toContain('Couldn’t check for updates');
    click('skill-update-notice-retry');
    expect(check.onCheck).toHaveBeenCalledTimes(1);
  });

  it('offers Remove for a skill its source no longer has', () => {
    const onRemove = jest.fn();
    render(
      <SkillUpdateNotice
        action={ready({ error: { kind: 'missing-source' } })}
        onRemove={onRemove}
      />,
    );
    expect(notice()?.textContent).toContain(
      'This skill is no longer in its source',
    );
    expect(notice()?.textContent).toContain(
      'You can keep using this copy or remove it.',
    );
    click('skill-update-notice-remove');
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('tells a blocked host where to update, with no action', () => {
    render(
      <SkillUpdateNotice
        action={{
          status: 'blocked',
          updateAvailable: true,
          reason: SKILL_UPDATE_DESKTOP_ONLY_REASON,
        }}
      />,
    );
    expect(notice()?.getAttribute('data-state')).toBe('blocked');
    expect(notice()?.textContent).toContain(SKILL_UPDATE_DESKTOP_ONLY_REASON);
    expect(notice()?.querySelector('button')).toBeNull();
  });
});

describe('SkillUpdateStatus (CAN-4264)', () => {
  it('reports a check in progress', () => {
    render(<SkillUpdateStatus action={ready({ pending: 'checking' })} />);
    expect(container.textContent).toBe('Checking for updates…');
  });

  it('says up to date only after a check found nothing newer', () => {
    expect(hasSkillUpdateStatus(ready())).toBe(false);
    expect(
      hasSkillUpdateStatus(ready({ updateAvailable: true, checkedAt: 1 })),
    ).toBe(false);
    expect(
      hasSkillUpdateStatus(
        ready({ checkedAt: 1, error: { kind: 'check-failed' } }),
      ),
    ).toBe(false);
    render(
      <SkillUpdateStatus
        action={ready({ checkedAt: Date.now() - 5 * 60_000 })}
      />,
    );
    expect(container.textContent).toBe('Up to date·Checked 5m ago');
  });
});

describe('skillUpdateMenuItem (CAN-4264)', () => {
  it('disables Check for updates while busy and explains a blocked host', () => {
    expect(skillUpdateMenuItem(undefined)).toBeNull();
    expect(skillUpdateMenuItem(ready())).toMatchObject({
      label: 'Check for updates',
      disabled: false,
    });
    expect(skillUpdateMenuItem(ready({ pending: 'applying' }))?.disabled).toBe(
      true,
    );
    expect(
      skillUpdateMenuItem({
        status: 'blocked',
        updateAvailable: false,
        reason: SKILL_UPDATE_DESKTOP_ONLY_REASON,
      }),
    ).toMatchObject({
      disabled: true,
      reason: SKILL_UPDATE_DESKTOP_ONLY_REASON,
    });
  });
});
