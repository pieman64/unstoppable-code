/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatComposerToolbarChip } from '../ChatComposerToolbar';
import { buildPlanModeChip, planModeChipLabel } from '../composer-plan-chip';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: JSX.Element): void {
  act(() => root.render(node));
}

function button(testId: string): HTMLButtonElement {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`No button ${testId}`);
  }
  return el;
}

describe('buildPlanModeChip dismissible', () => {
  it('names Plan with its close glyph on a wide box and draws the glyph alone when compact', () => {
    const onDisable = jest.fn();
    render(
      <ChatComposerToolbarChip
        {...buildPlanModeChip({ readOnly: false, disabled: false, onDisable })}
      />,
    );
    const wide = button('chat-input-plan-mode-inline-button');
    expect(wide.textContent).toContain('Plan');
    expect(wide.getAttribute('aria-pressed')).toBe('true');
    expect(wide.getAttribute('aria-label')).toBe('Disable plan mode');
    const close = wide.querySelector('[data-plan-remove]');
    expect(close).not.toBeNull();
    expect(close?.getAttribute('data-glyph')).toBe('x');

    render(
      <ChatComposerToolbarChip
        {...buildPlanModeChip({
          readOnly: false,
          disabled: false,
          onDisable,
          compact: true,
        })}
      />,
    );
    const narrow = button('chat-input-plan-mode-inline-button');
    expect(narrow.textContent).not.toContain('Plan');
    expect(narrow.querySelector('[data-plan-remove]')).toBeNull();
    // Still says what a click does.
    expect(narrow.getAttribute('aria-label')).toBe('Disable plan mode');
  });

  it('presents Cursor and Copilot plan mode as read only', () => {
    const config = buildPlanModeChip({
      readOnly: true,
      disabled: false,
      onDisable: jest.fn(),
    });
    expect(config.label).toBe('Read only');
    expect(config.ariaLabel).toBe('Disable read-only mode');
    expect(config.title).toBe('Disable read-only mode');
  });

  it('keeps the chat selector by default and takes a host selector', () => {
    expect(
      buildPlanModeChip({
        readOnly: false,
        disabled: false,
        onDisable: jest.fn(),
      }).dataTestId,
    ).toBe('chat-input-plan-mode-inline-button');
    expect(
      buildPlanModeChip({
        readOnly: false,
        disabled: false,
        onDisable: jest.fn(),
        dataTestId: 'home-plan-mode-inline-button',
      }).dataTestId,
    ).toBe('home-plan-mode-inline-button');
  });

  it('turns Plan off on click and ignores clicks while disabled', () => {
    const onDisable = jest.fn();
    render(
      <ChatComposerToolbarChip
        {...buildPlanModeChip({ readOnly: false, disabled: false, onDisable })}
      />,
    );
    act(() => button('chat-input-plan-mode-inline-button').click());
    expect(onDisable).toHaveBeenCalledTimes(1);

    render(
      <ChatComposerToolbarChip
        {...buildPlanModeChip({ readOnly: false, disabled: true, onDisable })}
      />,
    );
    const disabled = button('chat-input-plan-mode-inline-button');
    expect(disabled.disabled).toBe(true);
    act(() => disabled.click());
    expect(onDisable).toHaveBeenCalledTimes(1);
  });
});

describe('buildPlanModeChip toggle', () => {
  it('stays mounted as an icon-only toggle while off', () => {
    const onToggle = jest.fn();
    render(
      <ChatComposerToolbarChip
        {...buildPlanModeChip({
          presentation: 'toggle',
          active: false,
          onToggle,
          dataTestId: 'plan-toggle',
        })}
      />,
    );
    const chip = button('plan-toggle');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.getAttribute('aria-label')).toBe('Toggle plan mode');
    expect(chip.textContent).not.toContain('Plan');
    act(() => chip.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shares the active label but has no close glyph while on', () => {
    render(
      <ChatComposerToolbarChip
        {...buildPlanModeChip({
          presentation: 'toggle',
          active: true,
          onToggle: jest.fn(),
          dataTestId: 'plan-toggle',
        })}
      />,
    );
    const chip = button('plan-toggle');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.textContent).toContain(planModeChipLabel(false));
    expect(chip.querySelector('[data-plan-remove]')).toBeNull();
  });

  it('leaves the selector and disabled state unset unless given', () => {
    const config = buildPlanModeChip({
      presentation: 'toggle',
      active: true,
      onToggle: jest.fn(),
    });
    expect('dataTestId' in config).toBe(false);
    expect('disabled' in config).toBe(false);
    expect(config.title).toBe('Disable plan mode');
    expect(
      buildPlanModeChip({
        presentation: 'toggle',
        active: false,
        onToggle: jest.fn(),
      }).title,
    ).toBe('Enable plan mode');
  });
});
