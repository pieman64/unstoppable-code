import { useEffect, useState, type JSX } from 'react';
import { Button } from '@canopy/ui-shared';
import { DialogModal } from '../shared/DialogModal';
import {
  defaultConfigAuthToken,
  CLOUD_SINGLE_CONFIG_REQUIRED,
} from './mcpManagementOperations';

interface McpMoveToCloudDialogProps {
  serverName: string;
  /** Why the server can't move; the confirmation says so and can't confirm. */
  blockedReason?: string;
  /** Whether an access token goes to the cloud account with the server. */
  tokenMoves: boolean;
  /** The access token field, when this confirmation is where it is chosen. */
  token?: {
    value: string;
    loading: boolean;
    onChange: (value: string) => void;
  };
  dataTestId: string;
  confirmTestId: string;
  onConfirm: () => void;
  onClose: () => void;
}

// A move carries the server's own configuration, token included, so the
// confirmation says so before anything is sent.
export function McpMoveToCloudDialog({
  serverName,
  blockedReason,
  tokenMoves,
  token,
  dataTestId,
  confirmTestId,
  onConfirm,
  onClose,
}: McpMoveToCloudDialogProps): JSX.Element {
  return (
    <DialogModal
      title={`Move ${serverName} to your cloud account`}
      onClose={onClose}
      dataTestId={dataTestId}
    >
      <div className="space-y-4 p-6">
        {blockedReason ? (
          <p className="text-s fg-secondary" data-testid="mcp-move-blocked">
            {blockedReason}
          </p>
        ) : (
          <>
            <p className="text-s fg-secondary">
              Cloud chats and every signed-in desktop can use it.
            </p>
            <p className="text-s fg-secondary" data-testid="mcp-move-carries">
              {tokenMoves
                ? 'Its URL, headers, and access token move to your cloud account.'
                : 'Its URL and headers move to your cloud account. No access token goes with it.'}
            </p>
            <p className="text-s fg-secondary">
              OAuth sign-ins don't move. If it signs in with OAuth, sign in
              again after it moves.
            </p>
          </>
        )}
        {token && !blockedReason && (
          <label className="block text-sm">
            <span className="mb-1.5 block fg-secondary">Access token</span>
            <input
              type="password"
              autoComplete="off"
              value={token.value}
              disabled={token.loading}
              onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                token.onChange(e.target.value)
              }
              placeholder="Optional"
              data-testid="mcp-promote-access-token"
              className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs fg-secondary">
              Clear it to move the server without a token, or enter another one.
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={blockedReason !== undefined || token?.loading === true}
            data-testid={confirmTestId}
          >
            Move to cloud account
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}

interface McpPromoteDialogProps {
  serverId: string;
  serverName: string;
  onConfirm: (bearerToken: string | undefined) => void;
  onClose: () => void;
}

/** Moving a device row to the cloud account from its row button. */
export function McpPromoteDialog({
  serverId,
  serverName,
  onConfirm,
  onClose,
}: McpPromoteDialogProps): JSX.Element {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [blockedReason, setBlockedReason] = useState<string>();
  useEffect((): (() => void) => {
    let cancelled = false;
    void window.mcpServers
      .loadServer(serverId)
      .then(({ server }): void => {
        if (cancelled) return;
        setToken(defaultConfigAuthToken(server.configs) ?? '');
        setBlockedReason(
          server.configs.length > 1 ? CLOUD_SINGLE_CONFIG_REQUIRED : undefined,
        );
      })
      .catch((): void => undefined)
      .finally((): void => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [serverId]);
  return (
    <McpMoveToCloudDialog
      serverName={serverName}
      blockedReason={blockedReason}
      tokenMoves={token.trim().length > 0}
      token={{ value: token, loading, onChange: setToken }}
      dataTestId="mcp-promote-dialog"
      confirmTestId="mcp-promote-confirm"
      onConfirm={(): void => onConfirm(token.trim() || undefined)}
      onClose={onClose}
    />
  );
}

interface McpMoveToDeviceDialogProps {
  serverName: string;
  signInAgain: boolean;
  /** Present when the move would leave the cloud's stored headers behind. */
  storedHeadersChoice?: {
    /** False when the cloud didn't say whether it stores any. */
    known: boolean;
    confirmed: boolean;
    onChange: (confirmed: boolean) => void;
  };
  onConfirm: () => void;
  onClose: () => void;
}

export function McpMoveToDeviceDialog({
  serverName,
  signInAgain,
  storedHeadersChoice,
  onConfirm,
  onClose,
}: McpMoveToDeviceDialogProps): JSX.Element {
  return (
    <DialogModal
      title={`Move ${serverName} to this device`}
      onClose={onClose}
      dataTestId="mcp-move-to-device-dialog"
    >
      <div className="space-y-4 p-6">
        <p className="text-s fg-secondary">
          Cloud chats, cloud project defaults, and your other desktops lose{' '}
          {serverName}, because they can't use a server on this device. Chats
          and defaults on this device keep it.
        </p>
        {signInAgain && (
          <p className="text-s fg-secondary">
            Sign in to it again on this device after it moves.
          </p>
        )}
        {storedHeadersChoice && (
          <>
            <p className="text-s fg-secondary">
              {storedHeadersChoice.known
                ? "This server has stored headers that can't be copied to this device. Enter them again in the editor, or move it without them."
                : "This server may have stored headers that can't be copied to this device. Enter them again in the editor, or move it without them."}
            </p>
            <label className="flex cursor-pointer items-start gap-2 text-s fg-primary">
              <input
                type="checkbox"
                checked={storedHeadersChoice.confirmed}
                onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                  storedHeadersChoice.onChange(e.target.checked)
                }
                className="mt-0.5 rounded"
                data-testid="mcp-move-drop-stored-headers"
              />
              <span>Move without its stored headers</span>
            </label>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={
              storedHeadersChoice !== undefined &&
              !storedHeadersChoice.confirmed
            }
            data-testid="mcp-move-to-device-confirm"
          >
            Move to this device
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
