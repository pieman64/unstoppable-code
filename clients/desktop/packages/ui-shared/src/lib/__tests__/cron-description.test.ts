import { describeFiveFieldCron } from '../cron-description';

describe('describeFiveFieldCron', (): void => {
  it.each([
    ['0 2 * * *', 'Every day at 02:00'],
    ['30 9 * * 1-5', 'Every weekday at 09:30'],
    ['0 9 * * 1,3', 'Every Monday and Wednesday at 09:00'],
    ['0 9 * * 0', 'Every Sunday at 09:00'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['0 * * * *', 'Every hour'],
    ['0 8 1 * *', 'On day 1 of every month at 08:00'],
    ['* * * * *', 'Every minute'],
  ])('describes %s', (expression, expected): void => {
    expect(describeFiveFieldCron(expression)).toBe(expected);
  });

  it.each(['', 'nope', '0 2 * *', '0 2 * * * *', '5-10 * * * *', '0 2 L * *'])(
    'returns null for unsupported shape %j',
    (expression): void => {
      expect(describeFiveFieldCron(expression)).toBeNull();
    },
  );
});

it.each([
  '*/0 * * * *',
  '*/7 * * * *',
  '*/99 * * * *',
  '0 */0 * * *',
  '0 */5 * * *',
  '0 */99 * * *',
])(
  'does not describe invalid or uneven interval %s as a fixed interval',
  (expression): void => {
    expect(describeFiveFieldCron(expression)).toBeNull();
  },
);
