import { activateSidebarNavItem } from '../sidebar-nav-activation';

describe('activateSidebarNavItem', () => {
  it('enters a row that is not current', () => {
    const onSelect = jest.fn();
    const onReturnToRoot = jest.fn();
    activateSidebarNavItem({ active: false, onSelect, onReturnToRoot });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onReturnToRoot).not.toHaveBeenCalled();
  });

  it('returns the current row to its section root', () => {
    const onSelect = jest.fn();
    const onReturnToRoot = jest.fn();
    activateSidebarNavItem({ active: true, onSelect, onReturnToRoot });
    expect(onReturnToRoot).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects the current row again when the host has no root to return to', () => {
    const onSelect = jest.fn();
    activateSidebarNavItem({ active: true, onSelect });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
