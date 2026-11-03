import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import { SecureStorageNotice } from '@/components/auth/SecureStorageNotice';
import {
  unavailableSecureStorageFailure,
  unknownSecureStorageFailure,
} from '@/lib/secureStorageNotice';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { EyeIcon, EyeOffIcon, Globe } from '@canopy/ui-shared/icons/AppIcons';
import type { ModelGatewayCredentialValidation } from '@canopy/desktop-shared/types';
import type { OrgModelGateway } from '@/hooks/useOrgModelGateway';
import { notifyModelGatewayCredentialChanged } from '@/lib/integrationConnectionEvents';
import {
  Button,
  ProviderStatusDot,
  StatusLabel,
} from '@canopy/ui-shared/components';
import { SettingsRow, SettingsTextField } from './SettingsLayout';

const SAVE_DEBOUNCE_MS = 600;

// Shared by every mounted section: a reopened section's read, saves and Retry
// wait behind the unmount flush of the section it replaced, so the closed
// section's queued key cannot land after a newer edit or show as current.
let gatewayCredentialWriteQueue: Promise<void> | null = null;

interface ModelGatewayCredentialSectionProps {
  gateway: OrgModelGateway;
}

/**
 * The organization's mark, sized to sit level with the Claude and Codex logos
 * on the sibling provider rows.
 *
 * `logoUrl` is deliberately optional and currently always absent:
 * `CanopyOrgEnforcedSettings` (the only org data the desktop receives) carries
 * `organizationId` and `organizationName` and nothing else, so the org image
 * the web team pages render is not reachable from here yet. Wiring it is a
 * protocol field plus a server change; this component is the seam that change
 * lands in, and until then a globe reads as "an endpoint your org runs" rather
 * than as a broken image.
 */
function OrgGatewayMark({
  name,
  logoUrl,
}: {
  name: string;
  logoUrl?: string;
}): JSX.Element {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={`${name} logo`}
        data-testid="model-gateway-org-logo"
        className="h-4 w-4 shrink-0 rounded-sm object-cover"
      />
    );
  }
  return (
    <Globe
      size="sm"
      aria-hidden
      data-testid="model-gateway-org-logo-placeholder"
      className="shrink-0 fg-primary"
    />
  );
}

/**
 * The member's own key for their organization's model gateway.
 *
 * Traffic goes straight from this machine to the org's endpoint, so the key is
 * per-user and never leaves the device: it is stored encrypted beside the
 * GitHub and Linear credentials and injected into the harness at spawn time.
 *
 * Validated on SAVE rather than on first turn, like the Linear key and unlike
 * the fire-and-forget GitHub PAT. A gateway key is usually pasted once during
 * setup and then not looked at again — surfacing a typo here costs a second,
 * surfacing it at the first turn costs a confusing failed run.
 */
export function ModelGatewayCredentialSection({
  gateway,
}: ModelGatewayCredentialSectionProps): JSX.Element {
  const inputId = useId();
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [storageFailure, setStorageFailure] =
    useState<SecureStorageFailure | null>(null);
  const latestValueRef = useRef(value);
  const editRevisionRef = useRef(0);
  const readRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const readFailedRef = useRef(false);
  const [validation, setValidation] =
    useState<ModelGatewayCredentialValidation | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{
    organizationId: string;
    baseUrl: string;
    apiKey: string;
  } | null>(null);
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;

  useEffect(() => {
    let cancelled = false;
    editRevisionRef.current += 1;
    const editRevision = editRevisionRef.current;
    const request = ++readRequestRef.current;
    latestValueRef.current = '';
    readFailedRef.current = false;
    setValue('');
    setSaving(false);
    setValidation(null);
    setStorageFailure(null);
    setStorageAvailable(true);
    setLoaded(false);
    void (gatewayCredentialWriteQueue ?? Promise.resolve())
      .then(() => {
        if (cancelled) return null;
        return window.api.loadModelGatewayCredential(gateway.organizationId);
      })
      .then((state) => {
        if (
          !state ||
          cancelled ||
          request !== readRequestRef.current ||
          editRevision !== editRevisionRef.current
        )
          return;
        latestValueRef.current = state.apiKey;
        setValue(state.apiKey);
        setStorageFailure(
          state.secureStorageFailure ??
            (state.storageAvailable
              ? null
              : unavailableSecureStorageFailure('read')),
        );
        readFailedRef.current =
          !!state.secureStorageFailure || !state.storageAvailable;
        setStorageAvailable(state.storageAvailable);
        setValidation(
          state.apiKey && state.lastError
            ? { valid: false, error: state.lastError }
            : state.apiKey
              ? { valid: true, error: null }
              : null,
        );
      })
      .catch(() => {
        if (
          !cancelled &&
          request === readRequestRef.current &&
          editRevision === editRevisionRef.current
        ) {
          readFailedRef.current = true;
          setStorageFailure(unknownSecureStorageFailure('read'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return (): void => {
      cancelled = true;
      if (
        gatewayRef.current.organizationId === gateway.organizationId &&
        gatewayRef.current.baseUrl !== gateway.baseUrl
      ) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        pendingSaveRef.current = null;
      }
    };
  }, [gateway.organizationId, gateway.baseUrl]);

  const commit = useCallback(
    async (input: {
      organizationId: string;
      baseUrl: string;
      apiKey: string;
    }): Promise<void> => {
      const editRevision = editRevisionRef.current;
      const request = ++saveRequestRef.current;
      const isCurrentGateway = (): boolean =>
        gatewayRef.current.organizationId === input.organizationId &&
        gatewayRef.current.baseUrl === input.baseUrl;
      const isCurrent = (): boolean =>
        isCurrentGateway() &&
        request === saveRequestRef.current &&
        editRevision === editRevisionRef.current &&
        latestValueRef.current === input.apiKey;
      if (
        gatewayRef.current.organizationId === input.organizationId &&
        !isCurrentGateway()
      )
        return;
      if (isCurrentGateway()) readFailedRef.current = false;
      if (isCurrentGateway()) setSaving(true);
      try {
        const preceding = gatewayCredentialWriteQueue;
        const save = preceding
          ? preceding.then(() => window.api.saveModelGatewayCredential(input))
          : window.api.saveModelGatewayCredential(input);
        const settled = save.then(
          () => undefined,
          () => undefined,
        );
        gatewayCredentialWriteQueue = settled;
        void settled.then(() => {
          if (gatewayCredentialWriteQueue === settled)
            gatewayCredentialWriteQueue = null;
        });
        const result = await save;
        if (isCurrent()) {
          setStorageFailure(result.secureStorageFailure ?? null);
          if (!result.secureStorageFailure) setStorageAvailable(true);
          setValidation(input.apiKey.trim() ? result : null);
        }
        // Clearing a key and persisting a rejected key also change routing.
        if (!result.secureStorageFailure) notifyModelGatewayCredentialChanged();
      } catch {
        if (isCurrent()) {
          setStorageFailure(unknownSecureStorageFailure('write'));
          setValidation({
            valid: false,
            error: 'We couldn’t save your key. Try again.',
          });
        }
      } finally {
        if (isCurrent()) setSaving(false);
      }
    },
    [],
  );

  // Deliberately NOT named after the legacy chat-snapshot debounce: the
  // renderer persistence guard bans those writer names outright, and this
  // credential debounce has nothing to do with chat state.
  const scheduleKeySave = useCallback(
    (apiKey: string): void => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const pending = {
        organizationId: gateway.organizationId,
        baseUrl: gateway.baseUrl,
        apiKey,
      };
      pendingSaveRef.current = pending;
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        pendingSaveRef.current = null;
        void commit(pending);
      }, SAVE_DEBOUNCE_MS);
    },
    [commit, gateway.baseUrl, gateway.organizationId],
  );

  useEffect(() => {
    return (): void => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending) void commit(pending);
      }
    };
  }, [commit]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.value;
    editRevisionRef.current += 1;
    readFailedRef.current = false;
    latestValueRef.current = next;
    setValue(next);
    setValidation(null);
    setSaving(true);
    scheduleKeySave(next);
  };

  const hasKey = value.trim().length > 0;
  // Orgs name themselves things like "Acme Engineering Gateway"; appending the
  // word again reads as a typo on the one row whose name is user-supplied.
  const title = /\bgateway$/i.test(gateway.organizationName.trim())
    ? gateway.organizationName
    : `${gateway.organizationName} gateway`;

  // One status line, like the Claude and Codex rows beside it: what the
  // gateway needs, then whether the member's own key for it works.
  let statusLine: ReactNode;
  if (storageFailure) {
    statusLine = 'Your saved key is not available.';
  } else if (saving) {
    statusLine = <>Checking your key&hellip;</>;
  } else if (hasKey && validation?.valid === true) {
    statusLine = 'Your gateway key works.';
  } else if (hasKey && validation?.valid === false) {
    statusLine = (
      <StatusLabel data-testid="model-gateway-error">
        {validation.error ?? 'That key didn’t work.'}
      </StatusLabel>
    );
  } else {
    statusLine = gateway.enforced
      ? `Your agents run through ${gateway.organizationName}'s gateway. Add your key to start a turn.`
      : `Add your key to run agents through ${gateway.organizationName}'s gateway.`;
  }

  return (
    // The wrapper is the group's row: it carries the organization id the
    // row itself has no attribute for.
    <div
      data-testid="settings-model-gateway-credential"
      data-organization-id={gateway.organizationId}
    >
      <SettingsRow
        label={
          // Same label shape as the Claude and Codex rows beside it: mark,
          // name, then the live status dot. A gateway IS a provider.
          <span className="inline-flex items-center gap-2">
            <OrgGatewayMark name={gateway.organizationName} />
            {title}
            {loaded && !storageFailure && hasKey && validation ? (
              <ProviderStatusDot
                tone={validation.valid ? 'connected' : 'failed'}
                data-testid="model-gateway-key-status"
              />
            ) : null}
          </span>
        }
        description={statusLine}
        control={
          <>
            <SettingsTextField
              id={inputId}
              width="md"
              aria-label="Gateway key"
              type={visible ? 'text' : 'password'}
              value={value}
              onChange={handleChange}
              disabled={!loaded || !storageAvailable}
              placeholder="sk-..."
              data-testid="settings-model-gateway-key-input"
            />
            <Button
              size="compact"
              variant="ghost"
              iconOnly
              aria-label={visible ? 'Hide key' : 'Show key'}
              onClick={() => setVisible((prev) => !prev)}
            >
              {visible ? (
                <EyeOffIcon size="sm" aria-hidden />
              ) : (
                <EyeIcon size="sm" aria-hidden />
              )}
            </Button>
          </>
        }
      >
        <SecureStorageNotice
          failure={storageFailure}
          retrying={saving}
          onRetry={(): void => {
            if (!readFailedRef.current) {
              void commit({
                organizationId: gateway.organizationId,
                baseUrl: gateway.baseUrl,
                apiKey: latestValueRef.current,
              });
              return;
            }
            const editRevision = editRevisionRef.current;
            const request = ++readRequestRef.current;
            const organizationId = gateway.organizationId;
            const baseUrl = gateway.baseUrl;
            setSaving(true);
            void (gatewayCredentialWriteQueue ?? Promise.resolve())
              .then(() => {
                if (
                  request !== readRequestRef.current ||
                  editRevision !== editRevisionRef.current ||
                  gatewayRef.current.organizationId !== organizationId ||
                  gatewayRef.current.baseUrl !== baseUrl
                )
                  return null;
                return window.api.loadModelGatewayCredential(organizationId);
              })
              .then((state) => {
                if (
                  !state ||
                  request !== readRequestRef.current ||
                  editRevision !== editRevisionRef.current ||
                  gatewayRef.current.organizationId !== organizationId ||
                  gatewayRef.current.baseUrl !== baseUrl
                )
                  return;
                setStorageFailure(
                  state.secureStorageFailure ??
                    (state.storageAvailable
                      ? null
                      : unavailableSecureStorageFailure('read')),
                );
                setStorageAvailable(state.storageAvailable);
                if (!state.secureStorageFailure && state.storageAvailable) {
                  readFailedRef.current = false;
                  latestValueRef.current = state.apiKey;
                  setValue(state.apiKey);
                  setValidation(
                    state.apiKey
                      ? {
                          valid: !state.lastError,
                          error: state.lastError ?? null,
                        }
                      : null,
                  );
                  notifyModelGatewayCredentialChanged();
                }
              })
              .catch(() => {
                if (
                  request !== readRequestRef.current ||
                  editRevision !== editRevisionRef.current ||
                  gatewayRef.current.organizationId !== organizationId ||
                  gatewayRef.current.baseUrl !== baseUrl
                )
                  return;
                setStorageFailure(unknownSecureStorageFailure('read'));
                setValidation({
                  valid: false,
                  error: 'Couldn’t read your saved key. Try again.',
                });
              })
              .finally(() => {
                if (
                  request === readRequestRef.current &&
                  editRevision === editRevisionRef.current &&
                  gatewayRef.current.organizationId === organizationId &&
                  gatewayRef.current.baseUrl === baseUrl
                )
                  setSaving(false);
              });
          }}
        />
        <p className="text-xs fg-secondary">
          Your key goes to{' '}
          <span className="font-mono fg-primary">{gateway.baseUrl}</span> and
          stays on this machine. Ask your admin if you don&apos;t have one.
        </p>
      </SettingsRow>
    </div>
  );
}
