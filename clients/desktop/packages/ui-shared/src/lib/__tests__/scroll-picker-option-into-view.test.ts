/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  scrollPickerOptionIntoView,
  usePickerActiveScrollIntent,
} from '../scroll-picker-option-into-view';

describe('scrollPickerOptionIntoView', () => {
  let scrollIntoView: jest.Mock;

  beforeEach(() => {
    scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  it('scrolls the matching data-option-key row', () => {
    const list = document.createElement('div');
    const first = document.createElement('button');
    first.dataset.optionKey = 'one';
    const second = document.createElement('button');
    second.dataset.optionKey = 'two';
    list.append(first, second);
    document.body.append(list);

    scrollPickerOptionIntoView(list, 'two', 'data-option-key');

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(second);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    list.remove();
  });

  it('scrolls the matching data-option-id row', () => {
    const list = document.createElement('div');
    const row = document.createElement('button');
    row.dataset.optionId = 'alpha';
    list.append(row);
    document.body.append(list);

    scrollPickerOptionIntoView(list, 'alpha', 'data-option-id');

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(row);
    list.remove();
  });
});

type PickerScrollIntentApi = ReturnType<typeof usePickerActiveScrollIntent>;

describe('usePickerActiveScrollIntent', () => {
  function IntentProbe({
    apiRef,
  }: {
    apiRef: { current: PickerScrollIntentApi | null };
  }): null {
    apiRef.current = usePickerActiveScrollIntent();
    return null;
  }

  it('consumes scroll intent once', () => {
    const apiRef: { current: PickerScrollIntentApi | null } = { current: null };
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(createElement(IntentProbe, { apiRef }));
    });

    const api = apiRef.current;
    if (!api) throw new Error('hook api missing');
    expect(api.consumeActiveOptionScrollIntent()).toBe(false);
    api.markActiveOptionScrollIntent();
    expect(api.consumeActiveOptionScrollIntent()).toBe(true);
    expect(api.consumeActiveOptionScrollIntent()).toBe(false);
    api.clearActiveOptionScrollIntent();
    api.markActiveOptionScrollIntent();
    api.clearActiveOptionScrollIntent();
    expect(api.consumeActiveOptionScrollIntent()).toBe(false);

    act(() => root.unmount());
    container.remove();
  });

  it('holds a targeted intent until the matching row becomes active', () => {
    const apiRef: { current: PickerScrollIntentApi | null } = { current: null };
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(createElement(IntentProbe, { apiRef }));
    });

    const api = apiRef.current;
    if (!api) throw new Error('hook api missing');

    // Open-time restore: the effect that scrolls runs in the same passive
    // flush as the `setActiveIndex` that restores the selection, so it first
    // sees the stale row. A targeted intent must survive that pass instead of
    // being burned on row 0, or the selected option never scrolls into view.
    api.markActiveOptionScrollIntent('branch:feature');
    expect(api.consumeActiveOptionScrollIntent('branch:first')).toBe(false);
    expect(api.consumeActiveOptionScrollIntent('branch:feature')).toBe(true);
    expect(api.consumeActiveOptionScrollIntent('branch:feature')).toBe(false);

    // Keyboard navigation marks no target: reveal whichever row lands next.
    api.markActiveOptionScrollIntent();
    expect(api.consumeActiveOptionScrollIntent('branch:anything')).toBe(true);

    api.markActiveOptionScrollIntent('branch:feature');
    api.clearActiveOptionScrollIntent();
    expect(api.consumeActiveOptionScrollIntent('branch:feature')).toBe(false);

    act(() => root.unmount());
    container.remove();
  });
});
