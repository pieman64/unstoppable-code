import { mcpConnectActionButtonLabel } from '../McpConnectActionButton';

describe('mcpConnectActionButtonLabel (REG-3052)', () => {
  it.each([
    ['add', 'idle', 'Granola', 'Add'],
    ['enable', 'idle', 'Granola', 'Enable'],
    ['connect', 'idle', 'Granola', 'Connect Granola'],
    ['reconnect', 'idle', 'Granola', 'Reconnect Granola'],
    ['connect', 'idle', undefined, 'Sign in'],
    ['reconnect', 'idle', undefined, 'Reconnect'],
    [
      'connect-to-account',
      'idle',
      'Granola',
      'Connect Granola to your account',
    ],
    ['use-account', 'idle', 'Granola', 'Use Granola from your account'],
    ['connect', 'connecting', 'Granola', 'Connecting…'],
    ['connect-to-account', 'waiting', 'Granola', 'Waiting for sign-in…'],
  ] as const)(
    'labels %s while %s for %s as %s',
    (action, phase, name, label): void => {
      expect(mcpConnectActionButtonLabel(action, phase, name)).toBe(label);
    },
  );
});
