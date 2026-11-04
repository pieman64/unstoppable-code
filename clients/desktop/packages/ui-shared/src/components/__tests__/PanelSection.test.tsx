/** @jest-environment jsdom */
import { act, useContext, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SummaryIcon } from '../../icons/AppIcons';
import { HeaderActionButton } from '../HeaderActionButton';
import {
  PanelSection,
  PanelSectionHeaderActionSlotContext,
} from '../PanelSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('PanelSection', () => {
  it('uses shared ghost controls, normalized icon chrome, and equal card padding', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PanelSection
          icon={<SummaryIcon data-testid="section-icon" />}
          title="Summary"
          subtitle="Updated just now"
          headerAction={
            <HeaderActionButton data-testid="section-action">
              Refresh
            </HeaderActionButton>
          }
        >
          <div data-testid="section-body">Summary body</div>
        </PanelSection>,
      );
    });

    const section = container.querySelector('section');
    const header = section?.firstElementChild;
    const icon = container.querySelector('[data-testid="section-icon"]');
    const leadingIcon = container.querySelector(
      '[data-panel-section-leading-icon]',
    );
    const hoverChevron = container.querySelector(
      '[data-panel-section-hover-chevron]',
    );
    const titleRow = container.querySelector('[data-panel-section-title-row]');
    const controls = container.querySelector('[data-panel-section-controls]');
    const subtitle = container.querySelector('[data-panel-section-subtitle]');
    const divider = container.querySelector('[data-panel-section-divider]');
    const body = container.querySelector('[data-panel-section-body]');
    expect(section?.className).toContain('rounded-lg');
    expect(section?.className).toContain('bg-tertiary');
    expect(section?.className).toContain('shadow-sm');
    expect(section?.className).toContain('p-3');
    expect(section?.className).toContain('space-y-3');
    expect(section?.className).not.toContain('py-2.5');
    expect(section?.className).not.toContain('border');
    expect(section?.className).not.toContain('bg-fg-primary/[0.03]');
    expect(section?.className).not.toContain('rounded-xl');
    expect(header?.className).toContain('grid');
    expect(header?.className).toContain('group/section-header');
    expect(header?.className).toContain('gap-y-1');
    expect(header?.className).not.toContain('gap-y-0.5');
    expect(header?.className).not.toContain('gap-y-2');
    expect(header?.className).toContain('relative');
    expect(header?.className).not.toContain('min-h-8');
    expect(titleRow?.className).not.toContain('min-h-7');
    expect(titleRow?.className).toContain('items-center');
    expect(titleRow?.className).toContain('gap-3');
    expect(titleRow?.className).not.toContain('gap-2');
    expect(titleRow?.contains(icon ?? null)).toBe(true);
    expect(leadingIcon?.contains(icon ?? null)).toBe(true);
    expect(leadingIcon?.className).toContain(
      'group-hover/section-header:hidden',
    );
    expect(hoverChevron?.className).toContain(
      'group-hover/section-header:inline-flex',
    );
    expect(icon?.parentElement?.className).toContain('h-4');
    expect(icon?.parentElement?.className).toContain('w-4');
    expect(icon?.parentElement?.className).toContain('[&_svg]:h-4');
    expect(icon?.getAttribute('data-app-icon')).toBe('true');
    expect(icon?.parentElement?.className).not.toContain('stroke-[');
    expect(
      controls?.querySelector('[aria-label="Collapse section"]'),
    ).toBeNull();
    expect(controls?.className).toContain('h-0');
    expect(controls?.className).toContain('self-center');
    expect(controls?.className).toContain('items-center');
    expect(controls?.className).toContain('-mr-1');
    expect(controls?.className).not.toContain('self-start');
    expect(subtitle?.className).toContain('row-start-2');
    expect(subtitle?.className).toContain('pl-7');
    expect(subtitle?.className).not.toContain('pl-6');
    expect(subtitle?.className).toContain('text-2xs');
    expect(subtitle?.className).toContain('font-normal');
    expect(subtitle?.className).not.toContain('text-xs');
    expect(divider?.className.split(' ')).toContain('bg-line-tertiary');
    expect(divider?.className).toContain('h-[var(--default-border-width)]');
    expect(divider?.className).not.toContain('h-px');
    expect(divider?.className).not.toMatch(/bg-[^ ]+\//);
    expect(divider?.className).toContain('top-full');
    expect(divider?.className).toContain('translate-y-3');
    expect(divider?.className).not.toContain('-bottom-3');
    expect(divider?.className).toContain('-left-3');
    expect(divider?.className).toContain('-right-3');
    expect(divider?.className).not.toContain('left-0');
    expect(divider?.className).not.toContain('right-0');
    expect(divider?.className).not.toContain('-bottom-1.5');
    expect(divider?.className).toContain('duration-200');
    expect(divider?.className).toContain('ease-out');
    expect(divider?.className).toContain('motion-reduce:transition-none');
    expect(divider?.className).toContain('opacity-100');
    expect(body?.className).toContain('pt-3.25');
    expect(body?.className).toContain('space-y-3');
    expect(body?.className).not.toContain('border-t');
    expect(body?.className).not.toContain('border-transparent');
    expect(
      container.querySelector('[data-testid="section-action"]')?.parentElement,
    ).toBe(controls?.lastElementChild);
    expect(
      container.querySelector('[aria-label="Collapse section"]'),
    ).toBeNull();
    const action = container.querySelector('[data-testid="section-action"]');
    const title = container.querySelector('h3');
    expect(titleRow?.querySelector('h3')).toBeNull();
    expect(title?.contains(titleRow ?? null)).toBe(true);
    expect(action?.className).toContain('text-xs');
    expect(action?.className).toContain('font-normal');
    expect(action?.className).toContain('px-2.5');
    expect(action?.getAttribute('data-header-action-button')).toBe('true');
    expect(action?.className).toContain('fg-accent');
    expect(action?.className).not.toContain('fg-secondary');
    expect(title?.className).toContain('text-s');
    expect(title?.className).toContain('font-medium');
    expect(title?.className).toContain('truncate');

    expect(titleRow).toBeInstanceOf(HTMLButtonElement);
    if (!(titleRow instanceof HTMLButtonElement)) {
      throw new Error('Expected the section title row to be a button');
    }
    act(() => titleRow.click());
    expect(titleRow?.getAttribute('aria-expanded')).toBe('false');
    expect(section?.className).not.toContain('space-y-3');
    expect(container.querySelector('[data-testid="section-body"]')).toBeNull();
    expect(divider?.className).toContain('opacity-0');
    expect(divider?.className).not.toContain('opacity-100');

    act(() => root.unmount());
    container.remove();
  });

  it('toggles from a header click without letting an action click toggle it', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onAction = jest.fn();

    act(() => {
      root.render(
        <PanelSection
          icon={<svg />}
          title="Scripts"
          subtitle="3 configured"
          headerAction={
            <button data-testid="section-action" onClick={onAction}>
              Settings
            </button>
          }
        >
          <div data-testid="section-body">Scripts body</div>
        </PanelSection>,
      );
    });

    const header = container.querySelector<HTMLElement>(
      '[data-panel-section-header]',
    );
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="section-action"]',
    );
    expect(header).not.toBeNull();

    act(() => action?.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="section-body"]'),
    ).not.toBeNull();

    act(() => header?.click());
    expect(container.querySelector('[data-testid="section-body"]')).toBeNull();
    expect(
      container
        .querySelector('[data-panel-section-title-row]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');

    act(() => root.unmount());
    container.remove();
  });

  it('reserves collapsed icon color for warnings', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <>
          <PanelSection
            icon={<svg data-testid="warning-icon" />}
            title="Changed Files"
            collapsedIconColor="amber"
            defaultCollapsed
          >
            <div>Changed files</div>
          </PanelSection>
          <PanelSection
            icon={<svg data-testid="active-icon" />}
            title="Summary"
            collapsedIconColor="blue"
            defaultCollapsed
          >
            <div>Summary</div>
          </PanelSection>
          <PanelSection
            icon={<svg data-testid="empty-icon" />}
            title="Plans"
            collapsedIconColor="muted"
            defaultCollapsed
          >
            <div>Plans</div>
          </PanelSection>
        </>,
      );
    });

    const warningIcon = container.querySelector('[data-testid="warning-icon"]');
    const activeIcon = container.querySelector('[data-testid="active-icon"]');
    const emptyIcon = container.querySelector('[data-testid="empty-icon"]');

    expect(warningIcon?.parentElement?.className).toContain('fg-warning');
    expect(warningIcon?.parentElement?.className).not.toContain('fg-info');
    expect(activeIcon?.parentElement?.className).toContain('fg-secondary');
    expect(activeIcon?.parentElement?.className).not.toContain('fg-info');
    expect(emptyIcon?.parentElement?.className).toContain('fg-secondary');

    act(() => root.unmount());
    container.remove();
  });

  it('expands once for each new host expand request', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (expandRequest: number | undefined): void => {
      act(() => {
        root.render(
          <PanelSection
            icon={<svg />}
            title="Pipeline runs"
            defaultCollapsed
            expandRequest={expandRequest}
          >
            <div data-testid="section-body">Runs</div>
          </PanelSection>,
        );
      });
    };
    const expanded = (): string | null | undefined =>
      container
        .querySelector('[data-panel-section-title-row]')
        ?.getAttribute('aria-expanded');

    // The request present at mount is not a new request.
    render(3);
    expect(expanded()).toBe('false');

    render(4);
    expect(expanded()).toBe('true');
    expect(
      container.querySelector('[data-testid="section-body"]'),
    ).not.toBeNull();

    // The user can collapse it again; re-rendering the same request keeps it.
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-panel-section-title-row]')
        ?.click(),
    );
    expect(expanded()).toBe('false');
    render(4);
    expect(expanded()).toBe('false');

    render(5);
    expect(expanded()).toBe('true');

    act(() => root.unmount());
    container.remove();
  });

  it('omits disclosure chrome when the section has no expandable content', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PanelSection
          icon={<svg data-testid="section-icon" />}
          title="Plans"
          subtitle="No tracked plans yet"
          headerAction={<button data-testid="section-action">Import</button>}
          collapsible={false}
        >
          <p>Body content</p>
        </PanelSection>,
      );
    });

    expect(
      container.querySelector('[aria-label="Collapse section"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Expand section"]')).toBeNull();
    expect(
      container.querySelector('[data-panel-section-hover-chevron]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="section-action"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('section')?.getAttribute('data-collapsible'),
    ).toBe('false');
    expect(container.querySelector('[data-panel-section-divider]')).toBeNull();
    expect(
      container.querySelector('[data-panel-section-body]')?.className,
    ).toContain('pt-3');

    act(() => root.unmount());
    container.remove();
  });

  it('lets body content lift its action into the header controls slot', () => {
    // Hosts whose action handlers live in the body (desktop body-only chrome)
    // portal their button through this slot so it lands in the same
    // title-row-centered grid cell a `headerAction` prop would.
    function BodyOwnedAction(): JSX.Element | null {
      const slot = useContext(PanelSectionHeaderActionSlotContext);
      if (slot === null) return null;
      return createPortal(
        <HeaderActionButton
          iconOnly
          aria-label="Add note"
          data-testid="lifted-action"
        >
          <SummaryIcon />
        </HeaderActionButton>,
        slot,
      );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <PanelSection icon={<SummaryIcon />} title="Notes" subtitle="1 note">
          <BodyOwnedAction />
          <div data-testid="section-body">Notes body</div>
        </PanelSection>,
      );
    });

    const controls = container.querySelector('[data-panel-section-controls]');
    const lifted = container.querySelector('[data-testid="lifted-action"]');
    const body = container.querySelector('[data-panel-section-body]');
    expect(lifted).not.toBeNull();
    expect(controls?.contains(lifted)).toBe(true);
    expect(body?.contains(lifted)).toBe(false);
    expect(controls?.className).toContain('row-start-1');
    expect(controls?.className).toContain('h-0');
    expect(controls?.className).toContain('self-center');
    expect(controls?.className).toContain('items-center');

    act(() => root.unmount());
    container.remove();
  });
});
