import {
  INSTALLED_ITEM_STATUS_DESCRIPTION_LINE,
  INSTALLED_STATUS_FILTER_ANY_LABEL,
  installedStatusFilterEmptyText,
  installedStatusFilterLabel,
} from '../installed-item-status';

describe('installed status filter copy (CAN-4838)', () => {
  it('spells the empty and label copy exactly', () => {
    expect(installedStatusFilterEmptyText('disabled')).toBe(
      'Nothing is disabled.',
    );
    expect(installedStatusFilterEmptyText('active')).toBe('Nothing is active.');
    expect(installedStatusFilterEmptyText('available')).toBe(
      'Nothing is available.',
    );
    expect(installedStatusFilterLabel(null)).toBe(
      INSTALLED_STATUS_FILTER_ANY_LABEL,
    );
    expect(INSTALLED_STATUS_FILTER_ANY_LABEL).toBe('Any status');
    expect(installedStatusFilterLabel('available')).toBe('Available');
    expect(INSTALLED_ITEM_STATUS_DESCRIPTION_LINE).toBe(
      'Active items are added to every new chat. Available ones load when you or an agent need them. Disabled ones stay installed but are hidden.',
    );
  });
});
