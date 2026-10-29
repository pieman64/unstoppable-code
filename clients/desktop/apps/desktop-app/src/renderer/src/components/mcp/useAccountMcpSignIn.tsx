import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  ACCOUNT_MCP_ENDPOINT_REQUIRED,
  type AccountMcpClientSetup,
} from '@canopy/protocol/mcp-servers';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import {
  AccountMcpConnectionError,
  type AccountMcpConnectionSummary,
} from '@canopy/desktop-shared/types/mcp-servers';
import { overlayGeneration } from '@canopy/ui-shared/components';
import { mcpConnectErrorMessage } from '@canopy/ui-shared/lib';
import {
  useAccountMcpActions,
  type AccountMcpConnectOptions,
  type AccountMcpConnectOutcome,
} from '@/hooks/useAccountMcpActions';
import { useCuratedMcpServers } from '@/hooks/useCuratedMcpServers';
import {
  AccountMcpCredentialDialog,
  type AccountMcpCredentialKind,
} from './AccountMcpControls';
import {
  accountMcpClientPromptStep,
  accountMcpConnectStep,
  accountMcpCredentialTarget,
  accountMcpEndpointEntry,
  accountMcpUnavailableMessage,
  type AccountMcpConnectStep,
  type AccountMcpCredentialTarget,
} from './accountMcpConnectSteps';

/** An account server to sign in: its connection, or a catalog key without one. */
export interface AccountMcpSignInTarget {
  readonly connection?: AccountMcpConnectionSummary;
  readonly curatedKey?: string;
  readonly configId?: string;
}

/** How one sign-in ended; a setup dialog's close is a cancellation. */
export type AccountMcpSignInOutcome = Exclude<
  AccountMcpConnectOutcome,
  { kind: 'recovering' }
>;

/**
 * Routing and progress for one sign-in, across every setup and credential
 * dialog it opens. {@link onSettled} runs exactly once.
 */
export interface AccountMcpSignInFlow {
  readonly browser?: 'embedded';
  readonly onAuthorizing?: (embeddedUrl: string | undefined) => void;
  readonly onSettled?: (outcome: AccountMcpSignInOutcome) => void;
}

interface SignInAttempt {
  readonly flow: AccountMcpSignInFlow;
  settled: boolean;
}

function settleAttempt(
  attempt: SignInAttempt | undefined,
  outcome: AccountMcpSignInOutcome,
): void {
  if (!attempt || attempt.settled) return;
  attempt.settled = true;
  attempt.flow.onSettled?.(outcome);
}

/** The connect options that carry an attempt's routing and report its end. */
function attemptOptions(
  attempt: SignInAttempt | undefined,
): AccountMcpConnectOptions {
  if (!attempt) return {};
  return {
    ...(attempt.flow.browser ? { browser: attempt.flow.browser } : {}),
    ...(attempt.flow.onAuthorizing
      ? { onAuthorizing: attempt.flow.onAuthorizing }
      : {}),
    onOutcome: (outcome): void => {
      // A recovery reopens a dialog that carries this same attempt.
      if (outcome.kind !== 'recovering') settleAttempt(attempt, outcome);
    },
  };
}

export interface AccountMcpSignIn {
  /** Server keys whose sign-in is waiting on the browser. */
  readonly pending: ReadonlySet<string>;
  readonly error: string | null;
  readonly errorCode: string | null;
  /** A setup or credential dialog is open. */
  readonly setupOpen: boolean;
  /**
   * A catalog server's Connect reads its setup from the catalog, so it waits
   * while the catalog loads or after it failed to.
   */
  readonly waitsForCatalog: (target: AccountMcpSignInTarget) => boolean;
  /** The catalog could not be read; {@link retryCatalog} reads it again. */
  readonly catalogFailed: boolean;
  readonly retryCatalog: () => void;
  readonly connect: (
    target: AccountMcpSignInTarget,
    flow?: AccountMcpSignInFlow,
  ) => void;
  /** Cancels the flow for `serverKey`, closing its setup dialog if open. */
  readonly cancel: (serverKey: string) => void;
  /** The setup and credential dialogs; render once. */
  readonly dialogs: JSX.Element;
}

interface CredentialPrompt {
  readonly target: AccountMcpCredentialTarget;
  readonly kind: AccountMcpCredentialKind;
  readonly clientSetup?: AccountMcpClientSetup;
  readonly intro?: string;
  readonly entry?: CuratedMcpServerEntry;
  readonly connection?: AccountMcpConnectionSummary;
  readonly attempt?: SignInAttempt;
}

interface CatalogSetup {
  readonly entry: CuratedMcpServerEntry;
  readonly configId: string;
  /** Reopened for the user's own OAuth app after a refused start. */
  readonly requiresOAuthClient: boolean;
  readonly clientSetup?: AccountMcpClientSetup;
  readonly endpointUrl?: string;
  readonly attempt?: SignInAttempt;
}

const ACCOUNT_CHANGED = new AccountMcpConnectionError('account-changed')
  .message;

/** The MCP servers settings' setup dialog, fetched when a setup step opens it. */
const McpServerDialog = lazy(() =>
  import('@/components/pages/McpServersTab').then((module) => ({
    default: module.McpServerDialog,
  })),
);

/**
 * Connect for account MCP servers outside the MCP servers settings, the same
 * way those settings connect them: the shared steps, `useAccountMcpActions`,
 * and the catalog setup and credential dialogs, including the user's own
 * OAuth app when a server registers no clients itself. Credentials typed into
 * a dialog are bound to the account it opened under. A catalog server's
 * Connect waits for the catalog, so its setup step is never skipped.
 * `enabled: false` skips the catalog read until a host has an account server
 * to connect.
 */
export function useAccountMcpSignIn(
  refresh: () => Promise<void>,
  options: { enabled?: boolean } = {},
): AccountMcpSignIn {
  const actions = useAccountMcpActions(refresh);
  const catalog = useCuratedMcpServers({ enabled: options.enabled ?? true });
  const curatedEntries = catalog.entries;
  const catalogReady = !catalog.loading && catalog.error === null;
  const waitsForCatalog = useCallback(
    ({ connection, curatedKey }: AccountMcpSignInTarget): boolean =>
      !catalogReady &&
      (curatedKey !== undefined || connection?.kind === 'CURATED'),
    [catalogReady],
  );
  const [credentialPrompt, setCredentialPrompt] =
    useState<CredentialPrompt | null>(null);
  const [catalogSetup, setCatalogSetup] = useState<CatalogSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const capturedAccountId = useRef<string | undefined>(undefined);
  const setupRequest = useRef(0);
  const setupOpen = credentialPrompt !== null || catalogSetup !== null;
  const setupOpenRef = useRef(setupOpen);
  setupOpenRef.current = setupOpen;

  // The attempt a dialog (or a dialog about to open) carries; closing the
  // setup without connecting ends it as cancelled.
  const setupAttempt = useRef<SignInAttempt | undefined>(undefined);
  const setupServerKey = useRef<string | undefined>(undefined);
  const closeSetup = useCallback((): void => {
    setupRequest.current += 1;
    capturedAccountId.current = undefined;
    settleAttempt(setupAttempt.current, { kind: 'cancelled' });
    setupAttempt.current = undefined;
    setupServerKey.current = undefined;
    setCredentialPrompt(null);
    setCatalogSetup(null);
  }, []);
  const failSetup = (
    attempt: SignInAttempt | undefined,
    message: string,
  ): void => {
    setSetupError(message);
    settleAttempt(attempt, { kind: 'failed', message });
  };

  const withCapturedAccount = (
    open: () => void,
    attempt: SignInAttempt | undefined,
  ): void => {
    const request = ++setupRequest.current;
    // A superseded setup's attempt ends; this one now owns the dialog.
    if (setupAttempt.current !== attempt)
      settleAttempt(setupAttempt.current, { kind: 'cancelled' });
    setupAttempt.current = attempt;
    setSetupError(null);
    void (async (): Promise<void> => {
      let accountId: string | undefined;
      try {
        accountId = (await window.api?.loadCanopyCloudAccount?.())?.account?.id;
      } catch {
        accountId = undefined;
      }
      if (request !== setupRequest.current) return;
      if (!accountId) {
        setupAttempt.current = undefined;
        failSetup(attempt, 'Sign in to connect account servers.');
        return;
      }
      capturedAccountId.current = accountId;
      open();
    })();
  };

  useEffect(
    (): (() => void) | undefined =>
      window.mcpServers?.onAuthChanged?.((): void => {
        if (!setupOpenRef.current) return;
        const captured = capturedAccountId.current;
        if (captured === undefined) {
          closeSetup();
          return;
        }
        void window.api
          ?.loadCanopyCloudAccount?.()
          .then((state): void => {
            if (setupOpenRef.current && state.account?.id !== captured)
              closeSetup();
          })
          .catch((): void => closeSetup());
      }),
    [closeSetup],
  );

  const promptForOAuthClient = (
    entry: CuratedMcpServerEntry | undefined,
    connection: AccountMcpConnectionSummary | undefined,
    configId: string,
    clientSetup?: AccountMcpClientSetup,
    endpointUrl?: string,
    attempt?: SignInAttempt,
  ): void => {
    const step = accountMcpClientPromptStep({
      ...(entry ? { entry } : {}),
      ...(connection ? { connection } : {}),
      configId,
      ...(clientSetup ? { clientSetup } : {}),
      ...(endpointUrl ? { endpointUrl } : {}),
    });
    const carried = attempt ? { attempt } : {};
    if (step.kind === 'error') failSetup(attempt, step.message);
    else if (step.kind === 'token')
      withCapturedAccount(
        (): void =>
          setCredentialPrompt({
            target: step.target,
            kind: 'bearer',
            intro: step.intro,
            ...(entry ? { entry } : {}),
            ...carried,
          }),
        attempt,
      );
    else if (step.kind === 'setup')
      withCapturedAccount(
        (): void =>
          setCatalogSetup({
            entry: step.entry,
            configId: step.configId,
            requiresOAuthClient: true,
            ...(step.clientSetup ? { clientSetup: step.clientSetup } : {}),
            ...(step.endpointUrl ? { endpointUrl: step.endpointUrl } : {}),
            ...carried,
          }),
        attempt,
      );
    else
      withCapturedAccount(
        (): void =>
          setCredentialPrompt({
            target: accountMcpCredentialTarget(step.connection),
            kind: 'oauth-client',
            connection: step.connection,
            ...(step.clientSetup ? { clientSetup: step.clientSetup } : {}),
            ...(entry ? { entry } : {}),
            ...carried,
          }),
        attempt,
      );
  };

  const openCatalogSetup = (
    entry: CuratedMcpServerEntry,
    configId: string,
    attempt: SignInAttempt | undefined,
  ): void =>
    withCapturedAccount(
      (): void =>
        setCatalogSetup({
          entry,
          configId,
          requiresOAuthClient: false,
          ...(attempt ? { attempt } : {}),
        }),
      attempt,
    );

  // A setup, or any dialog on the page, opened or closed while the catalog is
  // read wins over this one.
  const promptForEndpoint = (
    serverKey: string,
    configId: string,
    attempt: SignInAttempt | undefined,
  ): void => {
    const request = ++setupRequest.current;
    const overlays = overlayGeneration(document);
    void accountMcpEndpointEntry(
      serverKey,
      curatedEntries,
      catalog.refresh,
    ).then((entry): void => {
      if (
        request !== setupRequest.current ||
        overlays !== overlayGeneration(document)
      ) {
        settleAttempt(attempt, { kind: 'cancelled' });
        return;
      }
      if (entry) openCatalogSetup(entry, configId, attempt);
      else
        failSetup(
          attempt,
          mcpConnectErrorMessage(ACCOUNT_MCP_ENDPOINT_REQUIRED),
        );
    });
  };

  const start = (
    step: AccountMcpConnectStep<AccountMcpConnectionSummary>,
    entry: CuratedMcpServerEntry | undefined,
    connection: AccountMcpConnectionSummary | undefined,
    attempt: SignInAttempt | undefined,
  ): void => {
    if (step.kind === 'unavailable')
      failSetup(attempt, accountMcpUnavailableMessage(entry));
    else if (step.kind === 'setup')
      openCatalogSetup(step.entry, step.configId, attempt);
    else if (step.kind === 'credential')
      withCapturedAccount(
        (): void =>
          setCredentialPrompt({
            target: accountMcpCredentialTarget(step.connection),
            kind: 'bearer',
            connection: step.connection,
            ...(attempt ? { attempt } : {}),
          }),
        attempt,
      );
    else if (step.kind === 'connect')
      void actions.connect(step.serverKey, step.configId, {
        ...attemptOptions(attempt),
        onOAuthClientRequired: (clientSetup): void =>
          promptForOAuthClient(
            entry,
            connection,
            step.configId,
            clientSetup,
            undefined,
            attempt,
          ),
        onEndpointRequired: (): void =>
          promptForEndpoint(step.serverKey, step.configId, attempt),
      });
  };

  const connect = (
    target: AccountMcpSignInTarget,
    flow?: AccountMcpSignInFlow,
  ): void => {
    const attempt: SignInAttempt | undefined = flow
      ? { flow, settled: false }
      : undefined;
    if (waitsForCatalog(target)) {
      settleAttempt(attempt, { kind: 'failed', message: null });
      return;
    }
    setSetupError(null);
    const { connection, curatedKey, configId } = target;
    settleAttempt(setupAttempt.current, { kind: 'cancelled' });
    setupAttempt.current = attempt;
    setupServerKey.current = connection?.serverKey ?? curatedKey;
    const entry = curatedEntries.find(
      (candidate): boolean =>
        candidate.key === (curatedKey ?? connection?.serverKey),
    );
    start(
      accountMcpConnectStep({
        ...(entry ? { entry } : {}),
        ...(connection ? { connection } : {}),
        ...(curatedKey ? { curatedKey } : {}),
        ...(configId ? { configId } : {}),
      }),
      entry,
      connection,
      attempt,
    );
  };

  // Submitting a dialog hands its attempt to the connect it starts.
  const expectedAccount = (
    attempt: SignInAttempt | undefined,
  ): string | undefined => {
    const accountId = capturedAccountId.current;
    setupAttempt.current = undefined;
    closeSetup();
    if (!accountId) failSetup(attempt, ACCOUNT_CHANGED);
    return accountId;
  };

  const dialogs = (
    <>
      {credentialPrompt && (
        <AccountMcpCredentialDialog
          key={`${credentialPrompt.kind}:${credentialPrompt.target.id}`}
          kind={credentialPrompt.kind}
          displayName={credentialPrompt.target.displayName}
          {...(credentialPrompt.intro ? { intro: credentialPrompt.intro } : {})}
          {...(credentialPrompt.clientSetup
            ? { clientSetup: credentialPrompt.clientSetup }
            : {})}
          onSubmit={(credential): void => {
            const { target, entry, connection, attempt } = credentialPrompt;
            const expectedAccountId = expectedAccount(attempt);
            if (!expectedAccountId) return;
            void actions.connect(target.serverKey, target.configId, {
              ...credential,
              ...attemptOptions(attempt),
              expectedAccountId,
              onOAuthClientRequired: (clientSetup): void =>
                promptForOAuthClient(
                  entry,
                  connection,
                  target.configId,
                  clientSetup,
                  undefined,
                  attempt,
                ),
            });
          }}
          onClose={closeSetup}
        />
      )}
      {catalogSetup && (
        <Suspense fallback={null}>
          <McpServerDialog
            key={`account:${catalogSetup.entry.key}`}
            serverId={null}
            mode="account"
            initialCurated={catalogSetup.entry}
            curatedEntries={curatedEntries}
            requiresOAuthClient={catalogSetup.requiresOAuthClient}
            {...(catalogSetup.clientSetup
              ? { clientSetup: catalogSetup.clientSetup }
              : {})}
            {...(catalogSetup.endpointUrl
              ? { initialEndpointUrl: catalogSetup.endpointUrl }
              : {})}
            onAccountConnect={(options): void => {
              const { entry, configId, attempt } = catalogSetup;
              const expectedAccountId = expectedAccount(attempt);
              if (!expectedAccountId) return;
              void actions.connect(entry.key, configId, {
                ...options,
                ...attemptOptions(attempt),
                expectedAccountId,
                onOAuthClientRequired: (clientSetup): void =>
                  promptForOAuthClient(
                    entry,
                    undefined,
                    configId,
                    clientSetup,
                    options.endpointUrl,
                    attempt,
                  ),
              });
            }}
            onClose={closeSetup}
            onSaved={refresh}
          />
        </Suspense>
      )}
    </>
  );

  return {
    pending: actions.pending,
    error: setupError ?? actions.error,
    errorCode: setupError === null ? actions.errorCode : null,
    setupOpen,
    waitsForCatalog,
    catalogFailed: !catalog.loading && catalog.error !== null,
    retryCatalog: (): void => void catalog.refresh(),
    connect,
    cancel: (serverKey: string): void => {
      const open =
        credentialPrompt?.target.serverKey ?? catalogSetup?.entry.key;
      if (open === serverKey || setupServerKey.current === serverKey)
        closeSetup();
      void actions.cancel(serverKey);
    },
    dialogs,
  };
}
