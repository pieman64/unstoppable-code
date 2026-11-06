'use client';

import type { JSX } from 'react';
import { McpSettingsSection } from './McpSettingsSection';

/** `/account/mcp`: the installed MCP servers, managed in Customize. */
// `account.mcp` page data is empty, so the page takes no props (it still
// satisfies the registry's `SettingsPageProps` component type).
export function McpPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6" data-testid="account-mcp-page">
      <McpSettingsSection />
    </div>
  );
}
