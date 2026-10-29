import { renderToString } from 'react-dom/server';
import {
  CustomizeIcon,
  PeopleIdCardIcon,
  PluginsIcon,
  StorefrontIcon,
  WorkflowsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { getSidebarNavItemDefs } from '../sidebar-nav-items';

describe('sidebar nav item icons', () => {
  it('uses app icons for every functional navigation item', () => {
    const definitions = getSidebarNavItemDefs();
    const functionalKeys = Object.keys(definitions).filter(
      (key) => key !== 'workers',
    );

    for (const key of functionalKeys) {
      expect(renderToString(definitions[key].icon)).toContain(
        'data-app-icon="true"',
      );
    }
  });

  it('labels the plugins row Customize and draws the briefcase, not the storefront or the puzzle piece', () => {
    const { plugins } = getSidebarNavItemDefs();

    expect(plugins.label).toBe('Customize');
    const icon = renderToString(plugins.icon);
    expect(icon).toBe(renderToString(<CustomizeIcon size={16} />));
    expect(icon).not.toBe(renderToString(<StorefrontIcon size={16} />));
    expect(icon).not.toBe(renderToString(<PluginsIcon size={16} />));
  });

  it('draws the Workflows row with the workflows glyph, not the agent glyph', () => {
    const definitions = getSidebarNavItemDefs();

    expect(definitions.workflows.label).toBe('Workflows');
    expect(renderToString(definitions.workflows.icon)).toBe(
      renderToString(<WorkflowsIcon size={16} />),
    );
    expect(renderToString(definitions.workflows.icon)).not.toBe(
      renderToString(<PeopleIdCardIcon size={16} />),
    );
  });

  it('has no retired Agents row (CAN-4266)', () => {
    expect(getSidebarNavItemDefs()).not.toHaveProperty('agents');
  });
});
