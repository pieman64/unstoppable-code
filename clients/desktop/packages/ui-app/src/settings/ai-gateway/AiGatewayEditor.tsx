'use client';

import { useRef, useState, type JSX } from 'react';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  Button,
  ErrorBanner,
  Heading,
  InlineTextInput,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
  type ModelGatewayModel,
} from '@canopy/protocol/canopy-server';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import { useSettingsAiGatewayConnectionKey, useSettingsPrivacy } from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import { joinClassNames } from '../organization/settings/join-class-names';
import { GatewayModelList } from './gateway-model-list';
import { AiGatewaySetup } from './AiGatewaySetup';
import { AiGatewayRefreshDialog } from './AiGatewayRefreshDialog';
import { EditGatewayModelDialog } from './EditGatewayModelDialog';
import { CloudChatsKeySection } from './CloudChatsKeySection';
import {
  aiGatewayLabel,
  type AiGatewayEditorAdapter,
  type AiGatewayEditorConfig,
  type AiGatewayEditorPatch,
} from './ai-gateway-adapter';
import {
  AI_GATEWAY_ERROR_SCOPE,
  AI_GATEWAY_KNOWN_ERRORS,
} from './ai-gateway-copy';

export interface AiGatewayEditorProps {
  readonly adapter: AiGatewayEditorAdapter;
  readonly initial: AiGatewayEditorConfig | null;
}

/** A gateway is configured once it has an endpoint and a model. */
export function isAiGatewayConfigured(
  config: AiGatewayEditorConfig | null,
): config is AiGatewayEditorConfig & { baseUrl: string } {
  return config !== null && config.baseUrl !== null && config.models.length > 0;
}

/**
 * One scope's AI gateway: the setup flow until it has an endpoint and a
 * model, then its connection, models and switches. Personal and team pages
 * render this with their own adapter; nothing here asks which host it is in.
 */
export function AiGatewayEditor({
  adapter,
  initial,
}: AiGatewayEditorProps): JSX.Element {
  const [config, setConfig] = useState<AiGatewayEditorConfig | null>(initial);
  if (!isAiGatewayConfigured(config)) {
    return (
      <section className={SETTINGS_CARD_CLASS} data-testid="ai-gateway-empty">
        <div className={joinClassNames(SETTINGS_CARD_GROUP_CLASS, 'px-4')}>
          <AiGatewaySetup
            adapter={adapter}
            current={config}
            enableOnSave={adapter.scope === 'personal'}
            onSaved={setConfig}
          />
        </div>
      </section>
    );
  }
  return (
    <ConfiguredAiGateway
      adapter={adapter}
      config={config}
      onConfigChange={setConfig}
    />
  );
}

interface ConfiguredAiGatewayProps {
  readonly adapter: AiGatewayEditorAdapter;
  readonly config: AiGatewayEditorConfig & { baseUrl: string };
  readonly onConfigChange: (config: AiGatewayEditorConfig) => void;
}

function ConfiguredAiGateway({
  adapter,
  config,
  onConfigChange,
}: ConfiguredAiGatewayProps): JSX.Element {
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const { maskClassName } = useSettingsPrivacy();
  const KeyRow = useSettingsAiGatewayConnectionKey();
  const personal = adapter.scope === 'personal';
  const host = gatewayHostname(config.baseUrl);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [editing, setEditing] = useState<ModelGatewayModel | null>(null);
  const [cloudKeys, setCloudKeys] = useState(false);

  // Every patch is built from the server's last answer, and one runs at a
  // time, so a second edit can't send a value the first already replaced.
  const latestRef = useRef(config);
  latestRef.current = config;
  const savingRef = useRef(false);
  const nameInFlightRef = useRef<string | null>(null);

  const apply = async (patch: AiGatewayEditorPatch): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await adapter.save(patch, latestRef.current.revision);
      latestRef.current = { ...saved, baseUrl: saved.baseUrl ?? '' };
      onConfigChange(saved);
      return true;
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'update your AI gateway',
          known: AI_GATEWAY_KNOWN_ERRORS,
        }),
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Blur and Enter both submit; the second of a pair is the same value and
  // is dropped. A refused name puts the saved one back.
  const submitName = async (value: string): Promise<void> => {
    const next = value.trim();
    const previous = latestRef.current.displayName ?? '';
    if (next === previous || nameInFlightRef.current === next) return;
    nameInFlightRef.current = next;
    await apply({ displayName: next || null });
    nameInFlightRef.current = null;
  };

  const label = aiGatewayLabel(config, adapter.fallbackName);
  const lastModel = config.enabled && config.models.length === 1;

  return (
    <div className="flex flex-col gap-10" data-testid="ai-gateway-configured">
      <section className={SETTINGS_CARD_CLASS}>
        <div className="flex items-center justify-between gap-3">
          <Heading level={2} variant="section">
            <span className={maskClassName}>{label}</span>
          </Heading>
          {personal ? (
            <ToggleSwitch
              label="AI gateway"
              checked={config.enabled}
              disabled={saving}
              dataTestId="ai-gateway-enabled-toggle"
              onChange={(next) => void apply({ enabled: next })}
            />
          ) : null}
        </div>
        <ErrorBanner error={error?.copy} details={error?.details} />
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <div className={SETTINGS_CARD_ROW_CLASS}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className={joinClassNames('max-w-80', maskClassName)}>
                <InlineTextInput
                  aria-label="Name"
                  value={config.displayName ?? ''}
                  maxLength={MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH}
                  placeholder={adapter.fallbackName ?? host}
                  disabled={saving}
                  data-testid="ai-gateway-name-input"
                  onCommit={(value) => void submitName(value)}
                />
              </div>
              <p
                className={joinClassNames(
                  'truncate font-mono text-xs fg-secondary',
                  maskClassName,
                )}
                data-testid="ai-gateway-url"
              >
                {config.baseUrl}
              </p>
            </div>
          </div>
          {KeyRow ? (
            <div
              className={SETTINGS_CARD_ROW_CLASS}
              data-testid="ai-gateway-key-row"
            >
              <span className="text-s font-medium fg-primary">
                {personal ? 'API key' : 'Your API key'}
              </span>
              <KeyRow
                organizationId={adapter.organizationId}
                baseUrl={config.baseUrl}
                revision={keyRevision}
                label={personal ? 'API key' : 'Your API key'}
              />
            </div>
          ) : cloudKeys && config.enabled ? null : (
            // Once cloud chats take a key below, this pointer would send
            // members to the desktop app for a key they can save here.
            <div className={SETTINGS_CARD_ROW_CLASS}>
              <p
                className="text-s fg-secondary"
                data-testid="ai-gateway-desktop-key"
              >
                Add your key in the desktop app.
              </p>
            </div>
          )}
          {personal ? null : (
            <div className={SETTINGS_CARD_ROW_CLASS}>
              <span className="text-s font-medium fg-primary">
                Offer to members
              </span>
              <ToggleSwitch
                label="Offer to members"
                checked={config.enabled}
                disabled={saving}
                dataTestId="ai-gateway-offer-toggle"
                onChange={(next) => void apply({ enabled: next })}
              />
            </div>
          )}
        </div>
      </section>

      {config.enabled ? (
        <CloudChatsKeySection
          organizationId={adapter.organizationId}
          baseUrl={config.baseUrl}
          revision={keyRevision}
          onAvailabilityChange={setCloudKeys}
        />
      ) : null}

      <section className={SETTINGS_CARD_CLASS} data-testid="ai-gateway-models">
        <div className="flex items-center justify-between gap-3">
          <Heading level={2} variant="section">
            {`Models (${config.models.length})`}
          </Heading>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={saving}
            data-testid="ai-gateway-refresh-models"
            onClick={() => setRefreshOpen(true)}
          >
            Refresh models
          </Button>
        </div>
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <GatewayModelList
            models={config.models}
            busy={saving}
            canRemove={!lastModel}
            onEdit={setEditing}
            onRemove={(id) =>
              void apply({
                models: latestRef.current.models.filter(
                  (model) => model.id !== id,
                ),
              })
            }
          />
        </div>
      </section>

      {personal ? (
        <section className={SETTINGS_CARD_CLASS}>
          <div className={SETTINGS_CARD_GROUP_CLASS}>
            <div className={SETTINGS_CARD_ROW_CLASS}>
              <span className="text-s font-medium fg-primary">
                Use only my AI gateway
              </span>
              <ToggleSwitch
                label="Use only my AI gateway"
                checked={config.onlyThisGateway}
                disabled={saving || !config.enabled}
                dataTestId="ai-gateway-only-toggle"
                onChange={(next) => void apply({ onlyThisGateway: next })}
              />
            </div>
          </div>
        </section>
      ) : null}

      {refreshOpen ? (
        <AiGatewayRefreshDialog
          adapter={adapter}
          config={config}
          onClose={() => setRefreshOpen(false)}
          onAdd={async (models) => {
            const ok = await apply({
              models: [...latestRef.current.models, ...models],
            });
            if (ok) setRefreshOpen(false);
            return ok;
          }}
          onKeySaved={() => setKeyRevision((revision) => revision + 1)}
        />
      ) : null}
      {editing ? (
        <EditGatewayModelDialog
          model={editing}
          busy={saving}
          error={error}
          onClose={() => setEditing(null)}
          onSave={async (edited) => {
            const ok = await apply({
              models: latestRef.current.models.map((model) =>
                model.id === edited.id ? edited : model,
              ),
            });
            if (ok) setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
