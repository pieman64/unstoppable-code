/** A verified loss of authentication revokes cached model availability. */
export class CursorModelAuthenticationError extends Error {
  constructor() {
    super('Reconnect Cursor in Settings to load models.');
    this.name = 'CursorModelAuthenticationError';
  }
}
