import type { JSX } from 'react';
import { brandText } from '@/lib/brand';
import { SettingsGroup, SettingsPage, SettingsSection } from './SettingsLayout';

const TRADEMARK_NOTICES = [
  'OpenAI, ChatGPT, GPT, Codex, and related marks are trademarks of OpenAI.',
  'Anthropic, Claude, and related marks are trademarks of Anthropic, PBC.',
  'GitHub, the GitHub logo, Invertocat, and Octocat are trademarks of GitHub, Inc.',
  'Ollama and related marks are trademarks of their respective owners.',
];

export function LegalTab(): JSX.Element {
  const appName = brandText.appName;
  return (
    <SettingsPage
      title="Legal"
      description={
        <>
          Notices for third-party names, marks, and software referenced by{' '}
          {appName}.
        </>
      }
      dataTestId="settings-tab-legal"
    >
      <SettingsSection title="Third-party marks">
        <SettingsGroup>
          <p className="text-s text-pretty fg-primary">
            {appName} is an independent application and is not affiliated with,
            endorsed by, sponsored by, or approved by OpenAI, Anthropic, GitHub,
            Ollama, or other third-party providers referenced in the app.
          </p>
          <p className="text-s text-pretty fg-primary">
            Third-party names, logos, trademarks, and brands are the property of
            their respective owners. They are used only to identify the
            services, tools, models, integrations, or dependencies that{' '}
            {appName} can work with.
          </p>
          {TRADEMARK_NOTICES.map((notice) => (
            <p key={notice} className="text-s text-pretty fg-secondary">
              {notice}
            </p>
          ))}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Open source notices">
        <SettingsGroup>
          <p className="text-s text-pretty fg-primary">
            {appName} includes third-party open source software and bundled
            command line tools. Their license terms remain governed by the
            licenses and notices published by their respective projects and
            distributors.
          </p>
          <p className="text-s text-pretty fg-secondary">
            Third-party license notices are included in THIRD_PARTY_NOTICES.txt,
            distributed alongside the application resources.
          </p>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
