import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';

/// The harness a Cloud chat runs on, derived as the web Cloud picker does
/// (`harnessOfChat` in `cloud-snapshot.ts`). Once a turn has answered, Core's
/// [boundHarness] wins, else the catalog's explicit binding of the answering
/// model ([modelHarnesses]). A row's curated harness is display metadata and
/// never locks a chat. Null keeps the picker unlocked: nothing answered yet,
/// or no binding is known.
String? cloudLockedHarness({
  required String? boundHarness,
  required List<CloudTranscriptMessage> messages,
  required Map<String, String> modelHarnesses,
}) {
  final answered = messages.reversed
      .where((message) => message.role == ChatRole.assistant)
      .map((message) => message.model?['id'])
      .whereType<String>()
      .firstOrNull;
  if (answered == null) return null;
  return boundHarness ?? modelHarnesses[answered];
}
