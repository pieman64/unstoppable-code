export class IdentifierValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdentifierValidationError';
  }
}
