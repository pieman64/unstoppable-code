import type { JSX } from 'react';
import { renderToString } from 'react-dom/server';
import type {
  NavigationController,
  NavigationLocation,
} from '@canopy/app-core';
import { NavigationProvider, useNavigation } from '../NavigationProvider';

function fixedController(location: NavigationLocation): NavigationController {
  return {
    current: location,
    navigate: (): void => {},
    subscribe: () => (): void => {},
  };
}

function Probe(): JSX.Element {
  const { location } = useNavigation();
  return <span data-page={location.page}>{location.page}</span>;
}

describe('NavigationProvider / useNavigation', () => {
  it('exposes the controller location to consumers', () => {
    const html = renderToString(
      <NavigationProvider controller={fixedController({ page: 'chat' })}>
        <Probe />
      </NavigationProvider>,
    );
    expect(html).toContain('data-page="chat"');
  });

  it('throws when used outside a provider', () => {
    expect(() => renderToString(<Probe />)).toThrow(/NavigationProvider/);
  });
});
