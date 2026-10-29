/**
 * @jest-environment jsdom
 */
/**
 * Unit coverage for the shared presentational {@link ChatComposerToolbar} and
 * its {@link ChatComposerToolbarChip} primitive (CAN-1215). The toolbar is the
 * single source of truth for the composer control row consumed by both the
 * desktop renderer and the web portal, so these tests pin the chip shape,
 * controlled-callback wiring, disabled states, slot rendering, control
 * ordering, and the desktop overflow-wrapper vs. portal bare-rail branch.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ChatComposerToolbar,
  ChatComposerToolbarChip,
} from '../ChatComposerToolbar';
import { Tooltip } from '../Tooltip';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function cleanup(container: HTMLDivElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function hasClasses(el: Element | null, classes: string[]): boolean {
  if (!el) return false;
  return classes.every((cls) => el.classList.contains(cls));
}

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('ChatComposerToolbarChip', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the desktop chip shape with icon, label, and trailing', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip
        ariaLabel="Plugins"
        title="Plugins"
        icon={<svg data-testid="icon" />}
        label="Plugins"
        trailing={<span data-testid="trailing" />}
      />,
    );
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    // Canonical chip shape, matched by desktop's plugins/plan/fast buttons and
    // the portal's plugins/model/plan/thinking chips.
    expect(
      hasClasses(button, [
        'rounded-md',
        'px-1.5',
        'py-0.5',
        'text-2xs',
        'shrink-0',
      ]),
    ).toBe(true);
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('Plugins');
    // Hover help is a rich tooltip, never a native `title` (CAN-2799): the
    // native tooltip lags on macOS while the rich one opens on mouseenter.
    expect(button?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      focusViaKeyboard(button);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Plugins',
    );
    expect(container.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trailing"]')).not.toBeNull();
    expect(button?.querySelector('span')?.textContent).toBe('Plugins');
    expect(button?.classList.contains('hover:bg-subtle')).toBe(true);
    expect(button?.classList.contains('hover:bg-muted/50')).toBe(false);
    cleanup(container, root);
  });

  it('carries a coarse-pointer 44px floor on the labelled chip', () => {
    // The compact chip has no height of its own (`py-0.5` around `text-2xs`), so
    // a labelled chip measured around 17px tall — under the touch floor the
    // icon-only composer buttons beside it already clear via `h-11 w-11`. The
    // mobile Playwright run measured `Plugins is 25.0x17.0` and the model picker
    // `112.9x17.0`.
    //
    // Keyed on POINTER TYPE, not width: a tablet has the same thumb as a phone,
    // so a width-gated floor would fix 390px and leave 768px broken. This is the
    // idiom `MobileTopBarButton` and `ChatTab` already use, and it leaves a
    // mouse-driven desktop untouched at any window width.
    const { container, root } = render(
      <ChatComposerToolbarChip
        ariaLabel="Plugins"
        icon={<svg />}
        label="Plugins"
      />,
    );
    const button = container.querySelector('button');
    // Both axes: with only a height floor the same run measured `Plugins` at
    // 29x44, because a chip whose label collapses at narrow widths is an icon in
    // a 29px box.
    expect(
      hasClasses(button, [
        'pointer-coarse:min-h-11',
        'pointer-coarse:min-w-11',
        'pointer-coarse:px-2',
      ]),
    ).toBe(true);
    // The fine-pointer shape is byte-identical to before the floor existed.
    expect(hasClasses(button, ['px-1.5', 'py-0.5', 'text-2xs'])).toBe(true);
    cleanup(container, root);
  });

  it('keeps the 32px capsule on fine pointers and the 44px floor on coarse ones', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip
        variant="capsule"
        ariaLabel="Plan"
        icon={<svg />}
        label="Plan"
      />,
    );
    const button = container.querySelector('button');
    // 32px is desktop's contract; a phone composer renders the same capsule
    // and must still meet the coarse-pointer tap minimum.
    expect(hasClasses(button, ['h-8', 'rounded-full'])).toBe(true);
    expect(
      hasClasses(button, [
        'pointer-coarse:min-h-11',
        'pointer-coarse:min-w-11',
      ]),
    ).toBe(true);
    cleanup(container, root);
  });

  it('omits the label span when no label is supplied (icon-only chip)', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip ariaLabel="Plan" icon={<svg />} />,
    );
    expect(container.querySelector('span')).toBeNull();
    cleanup(container, root);
  });

  it('renders the roomier capsule geometry on request', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip
        variant="capsule"
        ariaLabel="Toggle plan mode"
        icon={<svg />}
        label="Plan"
      />,
    );
    const button = container.querySelector('button');
    expect(
      hasClasses(button, [
        'focus-ring',
        'h-8',
        'rounded-full',
        'px-2.5',
        'text-xs',
      ]),
    ).toBe(true);
    expect(button?.classList.contains('py-0.5')).toBe(false);
    cleanup(container, root);
  });

  it('fires onClick and reflects the disabled state', () => {
    const onClick = jest.fn();
    const { container, root } = render(
      <ChatComposerToolbarChip
        ariaLabel="Plan"
        icon={<svg />}
        onClick={onClick}
      />,
    );
    act(() => {
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    cleanup(container, root);

    const { container: c2, root: r2 } = render(
      <ChatComposerToolbarChip ariaLabel="Plan" icon={<svg />} disabled />,
    );
    expect(c2.querySelector('button')?.disabled).toBe(true);
    cleanup(c2, r2);
  });

  it('applies active treatments only while active and threads aria-pressed', () => {
    const activeStyle = { color: 'rgb(251, 191, 36)' };
    const { container, root } = render(
      <ChatComposerToolbarChip
        ariaLabel="Fast"
        icon={<svg />}
        active
        activeTone="warning"
        activeStyle={activeStyle}
        ariaPressed
      />,
    );
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.style.color).toBe('rgb(251, 191, 36)');
    expect(button?.classList.contains('bg-warning-subtle')).toBe(true);
    expect(button?.classList.contains('fg-warning')).toBe(true);
    expect(button?.classList.contains('hover:bg-warning-subtle')).toBe(true);
    // Active chips drop the idle muted-text classes.
    expect(button?.classList.contains('fg-secondary')).toBe(false);
    cleanup(container, root);

    const { container: c2, root: r2 } = render(
      <ChatComposerToolbarChip
        ariaLabel="Fast"
        icon={<svg />}
        activeTone="warning"
        activeStyle={activeStyle}
      />,
    );
    const idle = c2.querySelector('button');
    expect(idle?.style.color).toBe('');
    expect(idle?.classList.contains('bg-warning-subtle')).toBe(false);
    expect(idle?.classList.contains('fg-secondary')).toBe(true);
    // aria-pressed is omitted entirely for non-toggle chips.
    expect(idle?.hasAttribute('aria-pressed')).toBe(false);
    cleanup(c2, r2);
  });

  it('offers a default and an accent active tone beside the warning one', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip ariaLabel="Plan" icon={<svg />} active />,
    );
    const plain = container.querySelector('button');
    // The default active chip takes the surrounding ink and only keeps the
    // hover surface.
    expect(plain?.classList.contains('hover:bg-subtle')).toBe(true);
    expect(plain?.classList.contains('fg-secondary')).toBe(false);
    expect(plain?.classList.contains('fg-warning')).toBe(false);
    cleanup(container, root);

    const { container: c2, root: r2 } = render(
      <ChatComposerToolbarChip
        ariaLabel="Plan"
        icon={<svg />}
        active
        activeTone="accent"
      />,
    );
    const accent = c2.querySelector('button');
    expect(accent?.classList.contains('bg-accent-subtle')).toBe(true);
    expect(accent?.classList.contains('fg-accent')).toBe(true);
    expect(accent?.classList.contains('hover:bg-accent-subtle')).toBe(true);
    cleanup(c2, r2);
  });

  it('threads aria-haspopup / aria-expanded for popup-trigger chips', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip
        ariaLabel="Select working directory"
        icon={<svg />}
        ariaHasPopup="listbox"
        ariaExpanded={true}
      />,
    );
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    cleanup(container, root);

    // Plain chips render neither attribute so their markup is unchanged.
    const { container: c2, root: r2 } = render(
      <ChatComposerToolbarChip ariaLabel="Plan" icon={<svg />} />,
    );
    const plain = c2.querySelector('button');
    expect(plain?.hasAttribute('aria-haspopup')).toBe(false);
    expect(plain?.hasAttribute('aria-expanded')).toBe(false);
    cleanup(c2, r2);
  });

  it('accepts Tooltip aria-describedby wiring on its underlying button', () => {
    const { container, root } = render(
      <Tooltip label="Plugins">
        <ChatComposerToolbarChip ariaLabel="Plugins" icon={<svg />} />
      </Tooltip>,
    );
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-describedby')).toBeNull();

    act(() => {
      focusViaKeyboard(button);
    });

    const tooltip =
      document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip?.id).toBeTruthy();
    expect(button?.getAttribute('aria-describedby')).toBe(tooltip?.id);
    cleanup(container, root);
  });

  it('opens no tooltip when no title is supplied', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip ariaLabel="Plugins" icon={<svg />} />,
    );
    const button = container.querySelector('button');
    act(() => {
      focusViaKeyboard(button);
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    cleanup(container, root);
  });

  it('forwards a data-testid when provided', () => {
    const { container, root } = render(
      <ChatComposerToolbarChip
        ariaLabel="Plugins"
        icon={<svg />}
        dataTestId="chat-plugins-button"
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-plugins-button"]'),
    ).not.toBeNull();
    cleanup(container, root);
  });
});

describe('ChatComposerToolbar', () => {
  it('renders chip configs as chips in left-rail order', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        plugins={{ ariaLabel: 'Plugins', icon: <svg /> }}
        model={{ ariaLabel: 'Model', icon: <svg /> }}
        planMode={{ ariaLabel: 'Toggle plan mode', icon: <svg /> }}
        thinking={{ ariaLabel: 'Cycle thinking level', icon: <svg /> }}
      />,
    );
    const html = container.innerHTML;
    const idxPlugins = html.indexOf('aria-label="Plugins"');
    const idxModel = html.indexOf('aria-label="Model"');
    const idxPlan = html.indexOf('aria-label="Toggle plan mode"');
    const idxThinking = html.indexOf('aria-label="Cycle thinking level"');
    expect(idxPlugins).toBeGreaterThan(-1);
    expect(idxModel).toBeGreaterThan(idxPlugins);
    expect(idxPlan).toBeGreaterThan(idxModel);
    expect(idxThinking).toBeGreaterThan(idxPlan);
    cleanup(container, root);
  });

  it('prefers the desktop model/thinking slots over the chip configs', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        model={{ ariaLabel: 'Model', icon: <svg /> }}
        modelSlot={<div data-testid="model-picker" />}
        thinking={{ ariaLabel: 'Cycle thinking level', icon: <svg /> }}
        thinkingSlot={<div data-testid="thinking-button" />}
      />,
    );
    expect(
      container.querySelector('[data-testid="model-picker"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="thinking-button"]'),
    ).not.toBeNull();
    // The chip variant must not also render when the slot wins.
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Cycle thinking level"]'),
    ).toBeNull();
    cleanup(container, root);
  });

  it('adds 4px between capsule thinking and usage slots', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        capsuleLayout
        thinkingSlot={<button data-testid="thinking-button" />}
        usageSlot={<button data-testid="usage-indicator" />}
      />,
    );
    const usage = container.querySelector('[data-testid="usage-indicator"]');

    expect(usage?.parentElement?.classList.contains('ml-1')).toBe(true);
    cleanup(container, root);
  });

  it('honors an explicit null slot to suppress the control even with a chip config', () => {
    // `null` is a valid "render nothing" node — an explicit `modelSlot={null}`
    // / `thinkingSlot={null}` must suppress the control rather than falling
    // back to the chip config (a `??` would have leaked the chip through).
    const { container, root } = render(
      <ChatComposerToolbar
        model={{ ariaLabel: 'Model', icon: <svg /> }}
        modelSlot={null}
        thinking={{ ariaLabel: 'Cycle thinking level', icon: <svg /> }}
        thinkingSlot={null}
        planMode={{ ariaLabel: 'Toggle plan mode', icon: <svg /> }}
      />,
    );
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Cycle thinking level"]'),
    ).toBeNull();
    // Adjacent chips still render, so the suppression is scoped, not a crash.
    expect(
      container.querySelector('[aria-label="Toggle plan mode"]'),
    ).not.toBeNull();
    cleanup(container, root);
  });

  it('renders right-rail slots in order', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        attachSlot={<button data-testid="attach" />}
        commandsSlot={<button data-testid="commands" />}
        trailingSlot={<button data-testid="send" />}
      />,
    );
    const html = container.innerHTML;
    expect(html.indexOf('data-testid="attach"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="commands"')).toBeGreaterThan(
      html.indexOf('data-testid="attach"'),
    );
    expect(html.indexOf('data-testid="send"')).toBeGreaterThan(
      html.indexOf('data-testid="commands"'),
    );
    cleanup(container, root);
  });

  it('renders the bare scroll rail (no overflow wrapper) by default', () => {
    const { container, root } = render(
      <ChatComposerToolbar plugins={{ ariaLabel: 'Plugins', icon: <svg /> }} />,
    );
    expect(
      hasClasses(container.querySelector('.relative'), ['flex', 'min-w-0']),
    ).toBe(false);
    expect(
      container.querySelector('.scrollbar-hide')?.classList.contains('gap-3'),
    ).toBe(true);
    expect(
      container
        .querySelector('.scrollbar-hide')
        ?.hasAttribute('data-composer-toolbar-rail'),
    ).toBe(true);
    cleanup(container, root);
  });

  it('wraps the rail in the overflow host when a scroll button is passed', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        overflowLeftSlot={<button data-testid="scroll-left" />}
        overflowRightSlot={<button data-testid="scroll-right" />}
        plugins={{ ariaLabel: 'Plugins', icon: <svg /> }}
      />,
    );
    expect(
      hasClasses(container.querySelector('.relative'), ['flex', 'min-w-0']),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="scroll-left"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="scroll-right"]'),
    ).not.toBeNull();
    cleanup(container, root);
  });

  it('tightens gaps and padding in compact mode', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        compact
        plugins={{ ariaLabel: 'Plugins', icon: <svg /> }}
      />,
    );
    const row = container.firstElementChild;
    expect(hasClasses(row, ['gap-1', 'px-2'])).toBe(true);
    expect(row?.classList.contains('gap-2')).toBe(false);
    expect(
      container.querySelector('.scrollbar-hide')?.classList.contains('gap-1'),
    ).toBe(true);
    cleanup(container, root);
  });

  it('keeps the capsule leading gap aligned with the trailing control gap', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        capsuleLayout
        compact
        leadingSlot={<button data-testid="plus" />}
        directorySlot={<button data-testid="directory" />}
        voiceSlot={<button data-testid="voice" />}
        interfaceToggleSlot={<button data-testid="toggle" />}
      />,
    );
    const row = container.firstElementChild;
    expect(row?.classList.contains('gap-2')).toBe(true);
    expect(row?.classList.contains('gap-1')).toBe(false);

    const rightCluster = container.querySelector(
      '[data-testid="voice"]',
    )?.parentElement;
    expect(rightCluster?.classList.contains('gap-2')).toBe(true);
    cleanup(container, root);
  });

  it('keeps capsule controls on one row', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        capsuleLayout
        compact
        modelSlot={<button data-testid="model" />}
        planMode={{
          variant: 'capsule',
          onClick: (): void => {},
          ariaLabel: 'Toggle plan mode',
          title: 'Enable plan mode',
          icon: <svg />,
          dataTestId: 'plan',
        }}
        thinkingSlot={<button data-testid="thinking" />}
        voiceSlot={<button data-testid="voice" />}
        trailingSlot={<button data-testid="send" />}
      />,
    );
    const row = container.firstElementChild;
    const rightCluster = container.querySelector(
      '[data-testid="voice"]',
    )?.parentElement;
    expect(row?.hasAttribute('data-toolbar-stacked')).toBe(false);
    expect(row?.classList.contains('flex-nowrap')).toBe(true);
    expect(row?.classList.contains('flex-wrap')).toBe(false);
    expect(rightCluster?.classList.contains('basis-full')).toBe(false);
    expect(rightCluster?.classList.contains('justify-end')).toBe(false);
    // The tooltip-wrapped plan chip stays a shrink-0 inline participant of
    // the same row rather than a block that would force a wrap.
    const plan = container.querySelector<HTMLElement>('[data-testid="plan"]');
    expect(plan?.hasAttribute('title')).toBe(false);
    expect(plan?.parentElement?.classList.contains('inline-flex')).toBe(true);
    expect(plan?.parentElement?.classList.contains('shrink-0')).toBe(true);
    cleanup(container, root);
  });

  it('applies labelClassName to the chip label span', () => {
    const { container, root } = render(
      <ChatComposerToolbar
        model={{
          ariaLabel: 'Model',
          icon: <svg />,
          label: 'Claude Sonnet 4.5',
          labelClassName: 'max-w-[7rem] truncate',
        }}
      />,
    );
    const span = container.querySelector('[aria-label="Model"] span');
    expect(span?.classList.contains('truncate')).toBe(true);
    expect(span?.classList.contains('max-w-[7rem]')).toBe(true);
    cleanup(container, root);
  });

  it('collapses plan/fast/thinking into a ⋯ overflow menu and forces a single row (CAN-1229)', () => {
    const onPlan = jest.fn();
    const { container, root } = render(
      <ChatComposerToolbar
        compact
        dataTestId="composer-toolbar"
        plugins={{ ariaLabel: 'Plugins', icon: <svg /> }}
        model={{ ariaLabel: 'Model', icon: <svg /> }}
        overflowMenu={{
          items: [
            {
              key: 'plan',
              icon: <svg />,
              label: 'Plan mode',
              stateLabel: 'Off',
              active: false,
              onSelect: onPlan,
              ariaLabel: 'Plan mode off',
            },
          ],
          triggerDataTestId: 'overflow-trigger',
        }}
      />,
    );
    const row = container.querySelector('[data-testid="composer-toolbar"]');
    // Single row: no-wrap, never flex-wrap.
    expect(row?.classList.contains('flex-nowrap')).toBe(true);
    expect(row?.classList.contains('flex-wrap')).toBe(false);
    // The ⋯ trigger renders; the inline plan/fast/thinking chips are omitted by
    // the caller in this mode.
    expect(
      container.querySelector('[data-testid="overflow-trigger"]'),
    ).not.toBeNull();
    // Right cluster uses the tighter gap.
    const rightCluster = row?.lastElementChild;
    expect(rightCluster?.classList.contains('gap-1')).toBe(true);
    expect(rightCluster?.classList.contains('gap-1.5')).toBe(false);
    cleanup(container, root);
  });

  it('omits the overflow menu (and its data-testid) when overflowMenu is not set', () => {
    const { container, root } = render(
      <ChatComposerToolbar plugins={{ ariaLabel: 'Plugins', icon: <svg /> }} />,
    );
    expect(
      container.querySelector('[aria-label="More composer options"]'),
    ).toBeNull();
    // No stray data-testid attribute on the row when dataTestId is unset.
    expect(container.firstElementChild?.hasAttribute('data-testid')).toBe(
      false,
    );
    cleanup(container, root);
  });
});
