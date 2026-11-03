/// Remembers the model picker's last harness tab on this device.
///
/// The shared chat stack depends on this interface only; the app wires the
/// `shared_preferences` implementation, and tests substitute an in-memory one.
abstract interface class ModelPickerTabStore {
  /// The stored tab name, or null when none was stored.
  Future<String?> read();

  Future<void> write(String tab);
}
