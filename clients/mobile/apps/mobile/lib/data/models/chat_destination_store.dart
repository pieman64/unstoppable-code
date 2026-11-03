/// Remembers where the last chat started on this device runs (CAN-2932), so
/// the next new-chat draft opens on the same destination.
///
/// The value is opaque to the store; the home feature encodes it. The app
/// wires the `shared_preferences` implementation, and tests substitute an
/// in-memory one.
abstract interface class ChatDestinationStore {
  /// The stored destination, or null when none was stored.
  Future<String?> read();

  Future<void> write(String destination);
}
