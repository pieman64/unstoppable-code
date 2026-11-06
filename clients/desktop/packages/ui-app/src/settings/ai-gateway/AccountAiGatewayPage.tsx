'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { useSettingsClient } from '../host';
import { AiGatewayEditor } from './AiGatewayEditor';
import {
  personalGatewayEditorConfig,
  usePersonalAiGatewayAdapter,
} from './ai-gateway-adapter';

/**
 * `/account/ai-gateway`: the Personal AI gateway. The page data names the
 * Personal organization it was read for; every save sends it back, so a
 * promotion since then is refused instead of saving into the new Personal.
 */
export function AccountAiGatewayPage({
  page,
}: SettingsPageProps<'account.ai-gateway'>): JSX.Element {
  const client = useSettingsClient();
  const adapter = usePersonalAiGatewayAdapter(client, page.data.organizationId);
  return (
    <AiGatewayEditor
      key={page.data.organizationId}
      adapter={adapter}
      initial={personalGatewayEditorConfig(page.data.gateway)}
    />
  );
}
