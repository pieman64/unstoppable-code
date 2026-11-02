export interface PairingTelemetryContext {
  pairing_kind: 'phone_code' | 'computer_outgoing' | 'computer_incoming';
  pairing_entry: 'portal_modal' | 'pair_computer_dialog' | 'incoming_prompt';
  peer_platform: 'darwin' | 'win32' | 'linux' | 'unknown';
  is_additional_device?: boolean;
}

export type PairingTelemetryOutcome =
  | 'approved'
  | 'rejected'
  | 'declined'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'timed_out';
export interface PairingTelemetryAttempt {
  end(outcome: PairingTelemetryOutcome): void;
}
export type PairingTelemetryRecorder = (
  context: PairingTelemetryContext,
) => PairingTelemetryAttempt | undefined;
