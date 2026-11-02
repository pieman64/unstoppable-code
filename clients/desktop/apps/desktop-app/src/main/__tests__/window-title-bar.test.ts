import { getWindowTitleBarOptions } from '../lib/window-title-bar';

// Every family supplies its existing custom chrome; the host owns the frame.
describe.each([
  {
    family: 'main',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
  },
  {
    family: 'Advisor',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
  },
  {
    family: 'auxiliary',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 15, y: 12 },
  },
] as const)(
  '$family title bar options',
  ({ titleBarStyle, trafficLightPosition }) => {
    const customOptions = { titleBarStyle, trafficLightPosition };
    it('uses the Linux native frame without custom title bar options', () => {
      expect(getWindowTitleBarOptions(customOptions, 'linux')).toEqual({
        frame: true,
      });
    });

    it.each<NodeJS.Platform>(['darwin', 'win32'])(
      'preserves existing options exactly on %s',
      (platform) => {
        expect(getWindowTitleBarOptions(customOptions, platform)).toEqual(
          customOptions,
        );
      },
    );
  },
);
