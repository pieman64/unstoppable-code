/// The identity and title used by the shared mobile chat-tabs sheet.
abstract interface class ChatTabItem {
  String get chatId;
  String get displayTitle;
}

/// A file tab in the shared mobile chat-tabs sheet.
abstract interface class ChatFileTabItem {
  String get fileTabId;
  String get displayTitle;

  /// The folder holding the file, to tell same-named files apart.
  String? get displayFolder;
}
