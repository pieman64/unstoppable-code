import type { ServerResponse } from 'node:http';
import { BRAND } from '@canopy/brand/current';
import { writeBrandedCallbackPage } from '../lib/branded-callback-page';

/**
 * Render the shared browser response for every MCP OAuth loopback listener.
 *
 * The proxy listener and fixed-port listener use different redirect URI shapes
 * because providers register them exactly, but the page a user sees after the
 * redirect should not depend on which listener completed the flow.
 */
export function writeMcpOAuthCallbackPage(
  response: ServerResponse,
  statusCode: number,
  result: { success: boolean; message: string },
): void {
  writeBrandedCallbackPage(response, statusCode, {
    tone: result.success ? 'success' : 'error',
    title: result.success ? 'Connected' : `Couldn't connect`,
    message: result.success
      ? `${BRAND.displayName} can now use this server.`
      : `Head back to ${BRAND.displayName} and try connecting again.`,
    detail: result.message,
    scrubQuery: true,
  });
}
