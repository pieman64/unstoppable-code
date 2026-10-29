/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceSelect } from '../AppearanceSelect';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
it('gives a long appearance list one scroll viewport while preserving options and checks', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const change = jest.fn();
  try {
    act(() =>
      root.render(
        <AppearanceSelect
          label="Interface scale"
          value="100"
          testId="scale"
          onChange={change}
          options={Array.from({ length: 31 }, (_, index) => {
            const value = String(50 + index * 5);
            return { value, label: `${value}%` };
          })}
        />,
      ),
    );
    const trigger =
      container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(trigger?.classList.contains('w-36')).toBe(true);
    act(() => trigger?.click());
    const menu = document.querySelector('[role="listbox"]');
    expect(menu?.querySelectorAll('[role="option"]')).toHaveLength(31);
    expect(menu?.getAttribute('style')).toContain('max-height: 208px');
    expect(menu?.querySelectorAll('[data-overlay-scroll-area]')).toHaveLength(
      1,
    );
    expect(menu?.querySelector('[aria-selected="true"]')?.textContent).toBe(
      '100%',
    );
    const option = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    ).find((entry) => entry.textContent === '125%');
    act(() => option?.click());
    expect(change).toHaveBeenCalledWith('125');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
