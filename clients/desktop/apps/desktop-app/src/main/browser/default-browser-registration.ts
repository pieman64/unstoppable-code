import type { DefaultBrowserRegistrationStatus } from '@canopy/desktop-shared/types';
import { win32 } from 'node:path';

const WEB_PROTOCOLS = ['http', 'https'] as const;

export interface DefaultBrowserProtocolRegistrar {
  setAsDefaultProtocolClient(
    protocol: string,
    path?: string,
    args?: string[],
  ): boolean;
  removeAsDefaultProtocolClient(
    protocol: string,
    path?: string,
    args?: string[],
  ): boolean;
  isDefaultProtocolClient(
    protocol: string,
    path?: string,
    args?: string[],
  ): boolean;
  getApplicationInfoForProtocol?(url: string): Promise<{ path: string }>;
}

export interface DefaultBrowserRegistrationServiceOptions {
  registrar: DefaultBrowserProtocolRegistrar;
  platform: 'darwin' | 'win32' | 'linux';
  isPackaged: boolean;
  isE2e: boolean;
  initialEnabled?: boolean;
  registrationPath?: string;
  registrationArgs?: string[];
  executablePath?: string;
  advertiseWindowsCapabilities?: () => Promise<void>;
  openWindowsSettings?: () => Promise<void>;
  onStatusChanged?: (status: DefaultBrowserRegistrationStatus) => void;
}

function sameStatus(
  left: DefaultBrowserRegistrationStatus,
  right: DefaultBrowserRegistrationStatus,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.registered === right.registered &&
    left.platform === right.platform &&
    left.failure === right.failure
  );
}

export class DefaultBrowserRegistrationService {
  private status: DefaultBrowserRegistrationStatus;
  private desiredEnabled: boolean;
  private intentGeneration = 0;
  private refreshGeneration = 0;
  private applyInFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: DefaultBrowserRegistrationServiceOptions,
  ) {
    const enabled = options.initialEnabled === true;
    this.desiredEnabled = enabled;
    const unsupported =
      options.isE2e ||
      options.platform === 'linux' ||
      (options.platform === 'darwin' && !options.isPackaged);
    this.status = {
      enabled,
      registered: false,
      platform: options.platform,
      ...(enabled && unsupported ? { failure: 'unsupported' as const } : {}),
    };
  }

  getStatus(): DefaultBrowserRegistrationStatus {
    return { ...this.status };
  }

  async refresh(): Promise<DefaultBrowserRegistrationStatus> {
    if (
      this.options.isE2e ||
      this.options.platform === 'linux' ||
      (this.options.platform === 'darwin' && !this.options.isPackaged)
    ) {
      return this.getStatus();
    }
    const intentGeneration = this.intentGeneration;
    const refreshGeneration = ++this.refreshGeneration;
    await this.applyInFlight;
    if (
      intentGeneration !== this.intentGeneration ||
      refreshGeneration !== this.refreshGeneration
    ) {
      return this.getStatus();
    }
    const enabled = this.desiredEnabled;
    try {
      const registrations = await Promise.all(
        WEB_PROTOCOLS.map((protocol) => this.isRegistered(protocol)),
      );
      const registered = enabled
        ? registrations.every(Boolean)
        : registrations.some(Boolean);
      const failure =
        enabled && !registered
          ? this.options.platform === 'win32'
            ? ('user-action-required' as const)
            : ('registration-refused' as const)
          : !enabled && registered
            ? ('registration-refused' as const)
            : undefined;
      return this.setRefreshStatusIfCurrent(
        intentGeneration,
        refreshGeneration,
        {
          enabled,
          registered,
          platform: this.options.platform,
          ...(failure ? { failure } : {}),
        },
      );
    } catch {
      return this.setRefreshStatusIfCurrent(
        intentGeneration,
        refreshGeneration,
        {
          enabled,
          registered: !enabled,
          platform: this.options.platform,
          failure: 'registration-refused',
        },
      );
    }
  }

  apply(args: {
    enabled: boolean;
    promptForWindowsSettings?: boolean;
  }): Promise<DefaultBrowserRegistrationStatus> {
    this.intentGeneration += 1;
    this.refreshGeneration += 1;
    this.desiredEnabled = args.enabled;
    const operation = this.performApply(args);
    const tracked = operation.finally(() => undefined);
    this.applyInFlight = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  private async performApply(args: {
    enabled: boolean;
    promptForWindowsSettings?: boolean;
  }): Promise<DefaultBrowserRegistrationStatus> {
    if (
      this.options.isE2e ||
      this.options.platform === 'linux' ||
      (this.options.platform === 'darwin' && !this.options.isPackaged)
    ) {
      return this.setStatus({
        enabled: args.enabled,
        registered: false,
        platform: this.options.platform,
        ...(args.enabled ? { failure: 'unsupported' as const } : {}),
      });
    }

    if (!args.enabled) {
      for (const protocol of WEB_PROTOCOLS) {
        try {
          if (this.options.registrationPath) {
            this.options.registrar.removeAsDefaultProtocolClient(
              protocol,
              this.options.registrationPath,
              this.options.registrationArgs ?? [],
            );
          } else {
            this.options.registrar.removeAsDefaultProtocolClient(protocol);
          }
        } catch {
          // Read back both registrations below; one removal can fail without
          // preventing the other protocol from being cleaned up.
        }
      }
      let registered: boolean;
      try {
        const registrations = await Promise.all(
          WEB_PROTOCOLS.map((protocol) => this.isRegistered(protocol)),
        );
        registered = registrations.some(Boolean);
      } catch {
        registered = true;
      }
      return this.setStatus({
        enabled: false,
        registered,
        platform: this.options.platform,
        ...(registered ? { failure: 'registration-refused' as const } : {}),
      });
    }

    let registered: boolean;
    try {
      if (this.options.platform === 'win32') {
        // Windows protects the effective HTTP(S) default behind Default Apps.
        // Electron's set/is APIs only write and compare direct Classes keys,
        // so advertise the current executable as a browser choice (including
        // ZIP builds where the NSIS hook never ran), remove any legacy direct
        // registration, and leave the effective association to user selection.
        await this.options.advertiseWindowsCapabilities?.();
        for (const protocol of WEB_PROTOCOLS) {
          try {
            if (this.options.registrationPath) {
              this.options.registrar.removeAsDefaultProtocolClient(
                protocol,
                this.options.registrationPath,
                this.options.registrationArgs ?? [],
              );
            } else {
              this.options.registrar.removeAsDefaultProtocolClient(protocol);
            }
          } catch {
            // Effective association verification below remains authoritative.
          }
        }
      } else {
        for (const protocol of WEB_PROTOCOLS) {
          if (this.options.registrationPath) {
            this.options.registrar.setAsDefaultProtocolClient(
              protocol,
              this.options.registrationPath,
              this.options.registrationArgs ?? [],
            );
          } else {
            this.options.registrar.setAsDefaultProtocolClient(protocol);
          }
        }
      }
      registered = (
        await Promise.all(
          WEB_PROTOCOLS.map((protocol) => this.isRegistered(protocol)),
        )
      ).every(Boolean);
    } catch {
      return this.setStatus({
        enabled: true,
        registered: false,
        platform: this.options.platform,
        failure: 'registration-refused',
      });
    }

    const status = this.setStatus({
      enabled: true,
      registered,
      platform: this.options.platform,
      ...(!registered
        ? {
            failure:
              this.options.platform === 'win32'
                ? ('user-action-required' as const)
                : ('registration-refused' as const),
          }
        : {}),
    });

    if (
      this.options.platform === 'win32' &&
      !registered &&
      args.promptForWindowsSettings
    ) {
      try {
        await this.options.openWindowsSettings?.();
      } catch {
        // Status already carries the user-action guidance.
      }
    }

    return status;
  }

  private async isRegistered(
    protocol: (typeof WEB_PROTOCOLS)[number],
  ): Promise<boolean> {
    if (this.options.platform === 'win32') {
      const expectedPath =
        this.options.executablePath ?? this.options.registrationPath;
      if (
        !expectedPath ||
        !this.options.registrar.getApplicationInfoForProtocol
      ) {
        return false;
      }
      const application =
        await this.options.registrar.getApplicationInfoForProtocol(
          `${protocol}://canopy-default-check.invalid`,
        );
      return (
        win32.normalize(application.path).toLocaleLowerCase('en-US') ===
        win32.normalize(expectedPath).toLocaleLowerCase('en-US')
      );
    }
    if (this.options.registrationPath) {
      return this.options.registrar.isDefaultProtocolClient(
        protocol,
        this.options.registrationPath,
        this.options.registrationArgs ?? [],
      );
    }
    return this.options.registrar.isDefaultProtocolClient(protocol);
  }

  private setStatus(
    status: DefaultBrowserRegistrationStatus,
  ): DefaultBrowserRegistrationStatus {
    if (!sameStatus(this.status, status)) {
      this.status = status;
      this.options.onStatusChanged?.(this.getStatus());
    }
    return this.getStatus();
  }

  private setRefreshStatusIfCurrent(
    intentGeneration: number,
    refreshGeneration: number,
    status: DefaultBrowserRegistrationStatus,
  ): DefaultBrowserRegistrationStatus {
    return intentGeneration === this.intentGeneration &&
      refreshGeneration === this.refreshGeneration
      ? this.setStatus(status)
      : this.getStatus();
  }
}

let service: DefaultBrowserRegistrationService | null = null;

export function initializeDefaultBrowserRegistrationService(
  options: DefaultBrowserRegistrationServiceOptions,
): DefaultBrowserRegistrationService {
  service = new DefaultBrowserRegistrationService(options);
  return service;
}

export function getDefaultBrowserRegistrationService(): DefaultBrowserRegistrationService {
  if (service === null) {
    throw new Error('Default browser registration service is not initialized');
  }
  return service;
}
