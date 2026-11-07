'use client';

import { useEffect, useId, useRef, useState, type JSX } from 'react';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  ErrorBanner,
  FormField,
  Heading,
  ProviderStatusDot,
  StatusLabel,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
  MODEL_GATEWAY_MAX_MODELS,
  type ModelGatewayModel,
} from '@canopy/protocol/canopy-server';
import {
  gatewayHostname,
  suggestGatewayModel,
  type AiGatewayConnectionResult,
  type DiscoveredGatewayModel,
} from '@canopy/protocol/model-gateway/discovery';
import {
  useSettingsAiGatewayConnectionKey,
  useSettingsClient,
  useSettingsPrivacy,
} from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import { joinClassNames } from '../organization/settings/join-class-names';
import { AddGatewayModelForm } from './gateway-model-list';
import {
  ABSENT_GATEWAY_REVISION,
  keepKeyForCloudChats,
  type AiGatewayEditorAdapter,
  type AiGatewayEditorConfig,
} from './ai-gateway-adapter';
import {
  AI_GATEWAY_ERROR_SCOPE,
  AI_GATEWAY_KNOWN_ERRORS,
  connectionFailureCopy,
  maskedKeySuffix,
} from './ai-gateway-copy';

export interface AiGatewaySetupProps {
  readonly adapter: AiGatewayEditorAdapter;
  /** The stored gateway being set up again, or `null` for a first setup. */
  readonly current: AiGatewayEditorConfig | null;
  readonly onSaved: (config: AiGatewayEditorConfig) => void;
  /** First run turns the gateway on when it saves. */
  readonly enableOnSave: boolean;
  /**
   * `dialog` stacks the URL and key and shows the compact
   * `Connected · N models` status, for first run's narrow dialog.
   */
  readonly layout?: 'page' | 'dialog';
}

type SetupStep =
  | { readonly kind: 'connect' }
  | {
      readonly kind: 'connected';
      readonly baseUrl: string;
      readonly keySuffix: string | null;
      readonly suggestions: readonly ModelGatewayModel[];
    };

/**
 * Connect, then pick models, then Save. Connect is an explicit action, never
 * a probe on each keystroke. On a host that keeps keys a successful Connect
 * stores the key; elsewhere the key goes with that one request. Saving is a
 * separate step, so a failed save keeps the draft for another try.
 */
export function AiGatewaySetup({
  adapter,
  current,
  onSaved,
  enableOnSave,
  layout = 'page',
}: AiGatewaySetupProps): JSX.Element {
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const { maskClassName } = useSettingsPrivacy();
  const client = useSettingsClient();
  const KeyRow = useSettingsAiGatewayConnectionKey();
  const keepsKeys = KeyRow !== undefined;
  const statusId = useId();
  const compactStatus = layout === 'dialog';

  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [step, setStep] = useState<SetupStep>({ kind: 'connect' });
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [name, setName] = useState(current?.displayName ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [manualModels, setManualModels] = useState<ModelGatewayModel[]>([]);
  const [manualOpen, setManualOpen] = useState(false);

  // A response belongs to the input it was sent for; editing the URL or key,
  // or closing, makes any response still in flight stale.
  const attemptRef = useRef(0);
  const connectingRef = useRef(false);
  const savingRef = useRef(false);
  // The key that connected, kept until Save: the server takes a cloud chats
  // key only for a stored gateway.
  const cloudKeyRef = useRef('');
  useEffect(
    () => (): void => {
      attemptRef.current += 1;
    },
    [],
  );

  const editInput = (): void => {
    attemptRef.current += 1;
    setConnecting(false);
    setNotice(null);
    setError(null);
    if (step.kind === 'connected') setStep({ kind: 'connect' });
  };

  const connect = async (): Promise<void> => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    const attempt = ++attemptRef.current;
    const typedKey = apiKey.trim();
    setConnecting(true);
    setNotice(null);
    setError(null);
    let result: AiGatewayConnectionResult;
    try {
      result = await adapter.connect({
        baseUrl: baseUrl.trim(),
        ...(typedKey ? { apiKey: typedKey } : {}),
      });
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setConnecting(false);
      setError(
        errorCopy.actionFailure(err, {
          action: 'connect to your AI gateway',
          known: AI_GATEWAY_KNOWN_ERRORS,
        }),
      );
      return;
    } finally {
      connectingRef.current = false;
    }
    if (attempt !== attemptRef.current) return;
    setConnecting(false);
    if (result.status !== 'connected') {
      setNotice(connectionFailureCopy(result.status, keepsKeys));
      return;
    }
    // The key has done its job: stored on a host that keeps keys, and
    // elsewhere held only until Save keeps it for cloud chats.
    setApiKey('');
    cloudKeyRef.current = keepsKeys ? '' : typedKey;
    const existing = current?.models ?? [];
    const suggestions = suggestModels(
      result.models,
      existing,
      adapter.organizationId,
    );
    setSelected(
      new Set([...existing, ...suggestions].map((model) => model.id)),
    );
    setManualModels([]);
    setManualOpen(existing.length + suggestions.length === 0);
    setStep({
      kind: 'connected',
      baseUrl: result.baseUrl,
      keySuffix: keepsKeys ? maskedKeySuffix(typedKey) : null,
      suggestions,
    });
  };

  if (step.kind === 'connect') {
    return (
      <div className="flex flex-col gap-3" data-testid="ai-gateway-setup">
        <ErrorBanner error={error?.copy} details={error?.details} />
        <div
          className={
            layout === 'dialog' ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'
          }
        >
          <FormField label="Gateway URL">
            {(control) => (
              <div className={maskClassName}>
                <TextInput
                  {...control}
                  density="settings"
                  mono
                  type="url"
                  value={baseUrl}
                  disabled={connecting}
                  placeholder="https://gateway.example.com"
                  autoComplete="off"
                  data-testid="ai-gateway-setup-url"
                  onChange={(event) => {
                    setBaseUrl(event.target.value);
                    editInput();
                  }}
                />
              </div>
            )}
          </FormField>
          <FormField label="API key">
            {(control) => (
              <div className={maskClassName}>
                <TextInput
                  {...control}
                  density="settings"
                  mono
                  type="password"
                  value={apiKey}
                  disabled={connecting}
                  autoComplete="off"
                  data-testid="ai-gateway-setup-key"
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    editInput();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void connect();
                  }}
                />
              </div>
            )}
          </FormField>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-xs fg-secondary" role="status">
            {notice ? (
              <StatusLabel tone="destructive" data-testid="ai-gateway-notice">
                {notice}
              </StatusLabel>
            ) : null}
          </p>
          <Button
            type="button"
            variant="primary"
            size="compact"
            disabled={connecting || baseUrl.trim().length === 0}
            data-testid="ai-gateway-connect"
            onClick={() => void connect()}
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </div>
    );
  }

  const models = [
    ...(current?.models ?? []),
    ...step.suggestions,
    ...manualModels,
  ];
  const chosen = models.filter((model) => selected.has(model.id));
  const combined = chosen;
  const overLimit = combined.length > MODEL_GATEWAY_MAX_MODELS;
  const host = gatewayHostname(step.baseUrl);

  const save = async (): Promise<void> => {
    if (savingRef.current || combined.length === 0 || overLimit) return;
    savingRef.current = true;
    const attempt = attemptRef.current;
    setSaving(true);
    setError(null);
    try {
      const saved = await adapter.save(
        {
          baseUrl: step.baseUrl,
          displayName: name.trim() || null,
          models: combined,
          ...(enableOnSave ? { enabled: true } : {}),
        },
        current?.revision ?? ABSENT_GATEWAY_REVISION,
      );
      // Before `onSaved`, so Cloud chats reads the key as saved when it mounts.
      if (cloudKeyRef.current && saved.baseUrl)
        await keepKeyForCloudChats(
          client,
          adapter.organizationId,
          cloudKeyRef.current,
          saved.baseUrl,
        );
      if (attempt === attemptRef.current) onSaved(saved);
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setError(
        errorCopy.actionFailure(err, {
          action: 'save your AI gateway',
          known: AI_GATEWAY_KNOWN_ERRORS,
        }),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="ai-gateway-setup">
      <ErrorBanner error={error?.copy} details={error?.details} />
      <p
        id={statusId}
        role="status"
        className="flex items-center gap-2 text-s fg-primary"
        data-testid="ai-gateway-connected"
      >
        <ProviderStatusDot tone="connected" />
        <span className="font-medium">Connected</span>
        <span
          className={joinClassNames(
            'min-w-0 truncate fg-secondary',
            maskClassName,
          )}
        >
          {compactStatus
            ? `· ${models.length} ${models.length === 1 ? 'model' : 'models'}`
            : [host, step.keySuffix].filter(Boolean).join(' · ')}
        </span>
      </p>
      {compactStatus ? null : (
        <FormField label="Name">
          {(control) => (
            <div className={maskClassName}>
              <TextInput
                {...control}
                density="settings"
                type="text"
                value={name}
                maxLength={MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH}
                disabled={saving}
                placeholder={host}
                data-testid="ai-gateway-setup-name"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          )}
        </FormField>
      )}
      <GatewayModelChecklist
        models={models}
        selected={selected}
        disabled={saving}
        onToggle={(id) =>
          setSelected((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
      />
      {models.length === 0 ? (
        <p className="text-xs fg-secondary" data-testid="ai-gateway-no-models">
          Your gateway didn&apos;t list any models. Add one manually.
        </p>
      ) : null}
      {manualOpen ? (
        <div className="flex flex-col">
          <AddGatewayModelForm
            busy={saving}
            existing={[...(current?.models ?? []), ...models]}
            organizationId={adapter.organizationId}
            onAdd={(model) => {
              setManualModels((previous) => [...previous, model]);
              setSelected((previous) => new Set(previous).add(model.id));
              setManualOpen(false);
            }}
            onCancel={() => setManualOpen(false)}
          />
        </div>
      ) : null}
      {overLimit ? (
        <StatusLabel tone="destructive" size="xs">
          {`A gateway can have up to ${MODEL_GATEWAY_MAX_MODELS} models.`}
        </StatusLabel>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {manualOpen ? (
          <span />
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={saving}
            data-testid="ai-gateway-add-manual"
            onClick={() => setManualOpen(true)}
          >
            Add model manually
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          size="compact"
          disabled={saving || combined.length === 0 || overLimit}
          data-testid="ai-gateway-save"
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Suggested settings for each discovered model the gateway doesn't have yet,
 * with IDs that stay unique among themselves as well as the stored models.
 */
export function suggestModels(
  discovered: readonly DiscoveredGatewayModel[],
  existing: readonly ModelGatewayModel[],
  ownerId: string,
): ModelGatewayModel[] {
  const configured = new Set(existing.map((model) => model.gatewayId));
  const taken: ModelGatewayModel[] = [...existing];
  const suggestions: ModelGatewayModel[] = [];
  for (const model of discovered) {
    if (configured.has(model.id)) continue;
    const suggestion = suggestGatewayModel(model, taken, ownerId);
    taken.push(suggestion);
    suggestions.push(suggestion);
  }
  return suggestions;
}

interface GatewayModelChecklistProps {
  readonly models: readonly ModelGatewayModel[];
  readonly selected: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onToggle: (id: string) => void;
}

/** The discovered models: name on the left, the gateway's ID on the right. */
export function GatewayModelChecklist({
  models,
  selected,
  disabled,
  onToggle,
}: GatewayModelChecklistProps): JSX.Element | null {
  const { maskClassName } = useSettingsPrivacy();
  if (models.length === 0) return null;
  const count = models.filter((model) => selected.has(model.id)).length;
  return (
    <div className="flex flex-col gap-1.5">
      <Heading level={3} variant="title">
        {`Models (${count} of ${models.length})`}
      </Heading>
      <div className="max-h-72 overflow-y-auto">
        <ChoiceList aria-label="Models">
          {models.map((model) => (
            <ChoiceListRow
              key={model.id}
              selected={selected.has(model.id)}
              disabled={disabled}
              data-testid={`ai-gateway-model-choice-${model.gatewayId}`}
              onClick={() => onToggle(model.id)}
              trailing={
                <span className={`font-mono ${maskClassName}`}>
                  {model.gatewayId}
                </span>
              }
            >
              <span className={maskClassName}>{model.label}</span>
            </ChoiceListRow>
          ))}
        </ChoiceList>
      </div>
    </div>
  );
}
