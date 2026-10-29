import { spaceNotificationProducerId } from '../space-notification-ref';

it('derives a stable, one-way producer id from the device id', () => {
  const producerId = spaceNotificationProducerId('device-1');
  expect(producerId).toMatch(/^[0-9a-f]{64}$/);
  expect(producerId).toBe(spaceNotificationProducerId('device-1'));
  expect(producerId).not.toBe(spaceNotificationProducerId('device-2'));
  expect(producerId).not.toContain('device-1');
});
