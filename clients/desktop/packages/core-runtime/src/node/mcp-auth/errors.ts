/** Fixed text; never carries the owner's error. */
export class McpAuthorizationUnavailableError extends Error {
  constructor() {
    super('MCP authorization is temporarily unavailable. Try again shortly.');
    this.name = 'McpAuthorizationUnavailableError';
  }
}

export class McpCredentialCapacityError extends Error {
  constructor() {
    super('Too many MCP connections are open. Close some chats and try again.');
    this.name = 'McpCredentialCapacityError';
  }
}
