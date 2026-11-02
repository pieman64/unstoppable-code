import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';

/**
 * One curated catalog entry advertising a provider connector, shared by every
 * connector suite so the copies cannot drift from each other.
 *
 * The annotation is deliberate but does not reach a gate: `tsconfig.web.json`
 * excludes `__tests__/**`, and Jest's SWC transform does not type-check, so
 * neither `tsc:check` nor `jest` type-checks this file.
 * It documents the production shape and holds in the editor; the reason the
 * fixture lives in one place is that a single shared copy is the part that
 * actually prevents drift.
 */
export const GMAIL_CONNECTOR: CuratedMcpServerEntry = {
  key: 'gmail-gmailmcp',
  name: 'Gmail',
  shortDescription: 'Read and send mail',
  url: 'https://gmailmcp.googleapis.com/mcp/v1',
  transport: 'http',
  categories: [],
  popular: false,
  sortOrder: 0,
  updatedAt: '2026-08-31T00:00:00.000Z',
  providerConnector: { providers: ['claude', 'codex'] },
};
