export type PortalServiceErrorCode =
  | 'invalid_payload'
  | 'invalid_target'
  | 'not_found'
  | 'execution_failed'
  | 'github_not_connected';

export class PortalServiceError extends Error {
  public constructor(
    public readonly code: PortalServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PortalServiceError';
  }
}
