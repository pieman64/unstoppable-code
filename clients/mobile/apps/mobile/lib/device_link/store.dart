abstract interface class DeviceLinkStore {
  Future<String?> read();
  Future<void> write(String value);
}
