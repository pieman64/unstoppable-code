/** @jest-environment jsdom */
import {
  dispatchCursorSettingsAction,
  registerCursorSettingsAction,
} from '../cursor-settings-actions';

afterEach(() => jest.useRealTimers());

it('waits for Settings to mount and uses the panel handler', async () => {
  jest.useFakeTimers();
  const handler = jest.fn(() => true);
  const result = dispatchCursorSettingsAction({
    type: 'cursor.connection',
    operation: 'connect',
  });
  expect(handler).not.toHaveBeenCalled();
  const unregister = registerCursorSettingsAction('cursor.connection', handler);
  await jest.advanceTimersByTimeAsync(20);
  await expect(result).resolves.toBe(true);
  expect(handler).toHaveBeenCalledWith('connect');
  unregister();
});

it('does not invoke a handler after its panel unmounts', async () => {
  jest.useFakeTimers();
  const handler = jest.fn(() => true);
  registerCursorSettingsAction('cursor.approval_check', handler)();
  const result = dispatchCursorSettingsAction({
    type: 'cursor.approval_check',
    operation: 'run',
  });
  await jest.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBe(false);
  expect(handler).not.toHaveBeenCalled();
});

it('keeps the latest mounted owner when the previous registration is cleaned up', async () => {
  const old = registerCursorSettingsAction('cursor.connection', () => true);
  const handler = jest.fn(() => false);
  const current = registerCursorSettingsAction('cursor.connection', handler);
  old();
  await expect(
    dispatchCursorSettingsAction({
      type: 'cursor.connection',
      operation: 'cancel',
    }),
  ).resolves.toBe(false);
  expect(handler).toHaveBeenCalledWith('cancel');
  current();
});
