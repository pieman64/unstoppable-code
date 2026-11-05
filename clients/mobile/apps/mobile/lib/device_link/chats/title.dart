/// The desktop's custom name wins over its generated description; `title`
/// remains the fallback captured from the first prompt on older records.
String deviceChatTitle(Map<String, dynamic> tab, {String fallback = 'Chat'}) {
  for (final key in ['customTitle', 'description', 'title']) {
    final value = tab[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return fallback;
}
