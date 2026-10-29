import { MCP_BRAND_LOGOS } from '../mcp-brand-logos';

it('keeps the bundled Hugging Face artwork within its encoded payload budget', () => {
  // Base64 alignment makes formatting whitespace surprisingly expensive in
  // this shared asset. Keep headroom in every route that loads the catalog.
  expect(MCP_BRAND_LOGOS['hugging-face'].length).toBeLessThanOrEqual(17_600);
});
