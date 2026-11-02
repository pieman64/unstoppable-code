import {
  getInAppNotificationContainerClasses,
  IN_APP_NOTIFICATION_WIDTH_PX,
  type InAppNotificationPlacement,
} from '../notification-placement';

const PLACEMENTS: readonly InAppNotificationPlacement[] = [
  'top-right',
  'bottom-right',
  'top-left',
  'bottom-left',
];

const ROOT_FONT_PX = 16;

function classesOf(
  placement: InAppNotificationPlacement,
  clearHeader: boolean,
): readonly string[] {
  return getInAppNotificationContainerClasses(placement, { clearHeader }).split(
    ' ',
  );
}

describe('getInAppNotificationContainerClasses', () => {
  it('is as wide as a macOS notification banner', () => {
    expect(IN_APP_NOTIFICATION_WIDTH_PX).toBe(344);
  });

  it.each(PLACEMENTS)(
    'sizes the %s corner to the banner width, never wider than the window less its margins',
    (placement) => {
      for (const clearHeader of [false, true]) {
        const widths = classesOf(placement, clearHeader).filter((name) =>
          name.startsWith('w-'),
        );
        expect(widths).toEqual(['w-[min(21.5rem,calc(100vw-2rem))]']);
        const rem = /^w-\[min\(([\d.]+)rem,/.exec(widths[0] ?? '')?.[1];
        expect(Number(rem) * ROOT_FONT_PX).toBe(IN_APP_NOTIFICATION_WIDTH_PX);
      }
    },
  );

  it.each([
    ['top-right', ['fixed', 'right-4', 'top-4']],
    ['bottom-right', ['fixed', 'right-4', 'bottom-4']],
    ['top-left', ['fixed', 'left-4', 'top-4']],
    ['bottom-left', ['fixed', 'left-4', 'bottom-4']],
  ] as const)('pins the %s corner 16px in', (placement, expected) => {
    const classes = classesOf(placement, false);
    for (const name of expected) expect(classes).toContain(name);
    expect(classes).toContain('z-toast');
    expect(classes).toContain('pointer-events-none');
  });

  it('keeps the top corners below the header only when asked', () => {
    for (const placement of ['top-right', 'top-left'] as const) {
      expect(classesOf(placement, false)).toContain('top-4');
      expect(classesOf(placement, false)).not.toContain('top-14');
      expect(classesOf(placement, true)).toContain('top-14');
      expect(classesOf(placement, true)).not.toContain('top-4');
    }
    for (const placement of ['bottom-right', 'bottom-left'] as const) {
      expect(classesOf(placement, true)).toEqual(classesOf(placement, false));
    }
  });
});
