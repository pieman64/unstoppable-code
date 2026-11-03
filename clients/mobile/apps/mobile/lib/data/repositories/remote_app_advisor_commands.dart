import 'package:mobile/data/models/remote_app_advisor.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_session_command.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;

/// Shown instead of sending when the desktop predates App Advisor support.
const String kRemoteAppAdvisorNeedsDesktopUpdate =
    'Update the desktop app to use Orchestrator here.';

/// Submits a command and returns the server's response, including the
/// desktop's answer to a small RPC that arrived in time. Only a
/// `portal.state.request` may pass a [target].
typedef RemoteSessionCommandRequest =
    Future<RemotePortalCommandResult> Function({
      required String type,
      required Map<String, dynamic> payload,
      Map<String, String>? target,
    });

/// The paired desktop's App Advisor commands (CAN-3989). The repository
/// supplies its session capabilities and its shared command submission.
///
/// Every `portal.app_advisor.*` command is payload-only: the server rejects
/// any that carries an envelope target, because the desktop always routes
/// the family to its own Advisor workspace.
final class RemoteAppAdvisorCommands {
  const RemoteAppAdvisorCommands({
    required this._hasCapability,
    required this._submit,
    required this._request,
  });

  final bool Function(String capability) _hasCapability;
  final RemoteSessionCommandSubmit _submit;
  final RemoteSessionCommandRequest _request;

  /// Whether the desktop announces the `app_advisor` capability.
  bool get isSupported => _hasCapability('app_advisor');

  /// Sends [text] to [chatId], or starts a new chat when [chatId] is null.
  /// The new chat's id arrives in the command's completion result. [model]
  /// runs the turn on that model; omitted, the chat keeps its model and a new
  /// chat uses the Advisor default.
  Future<String> send({
    String? chatId,
    required String userMessageId,
    required String text,
    String? workEntryId,
    String? model,
  }) => _submitAdvisor('portal.app_advisor.send', {
    'chatId': ?chatId,
    'userMessageId': userMessageId,
    'text': text,
    'workEntryId': ?workEntryId,
    'model': ?model,
  });

  /// Reads the Advisor default model and its catalog. [settings] is null
  /// when the desktop did not answer in time; the answer then arrives as the
  /// command's completion.
  Future<({String commandId, RemoteAppAdvisorSettings? settings})>
  readSettings() async {
    _requireSupport();
    final response = await _request(
      type: 'portal.app_advisor.settings.get',
      payload: const {},
    );
    final error = response.error;
    if (error != null && error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    final result = response.result;
    return (
      commandId: response.commandId,
      settings: result == null
          ? null
          : RemoteAppAdvisorSettings.fromJson(result),
    );
  }

  Future<String> cancel(String chatId) =>
      _submitAdvisor('portal.app_advisor.cancel', {'chatId': chatId});

  /// Persists [chatId]'s model without sending. The desktop applies its
  /// model policy and re-projects the chat with the result.
  Future<String> setModel({required String chatId, required String model}) =>
      _submitAdvisor('portal.app_advisor.set_model', {
        'chatId': chatId,
        'model': model,
      });

  /// Creates an empty tab with the client-minted [chatId] in [workEntryId].
  Future<String> createTab({required String chatId, String? workEntryId}) =>
      _submitAdvisor('portal.app_advisor.create_tab', {
        'chatId': chatId,
        'workEntryId': ?workEntryId,
      });

  Future<String> answerQuestion({
    required String chatId,
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) => _submitAdvisor('portal.app_advisor.answer_question', {
    'chatId': chatId,
    'requestId': requestId,
    'answers': [for (final answer in answers) answer.toJson()],
  });

  Future<String> dismissQuestion({
    required String chatId,
    required String requestId,
  }) => _submitAdvisor('portal.app_advisor.dismiss_question', {
    'chatId': chatId,
    'requestId': requestId,
  });

  /// Asks the desktop to project every Advisor chat with a transcript seed.
  /// The answer lands as an `app_advisor` snapshot event.
  Future<String> requestState() =>
      _submitAdvisor('portal.state.request', {'scope': 'app_advisor'});

  /// Asks the desktop for one chat and its transcript, reading only that
  /// chat's Work Entry. The answer lands as a snapshot targeted at [chatId];
  /// the command fails when the desktop cannot resolve the chat.
  Future<String> requestChatState(String chatId) async {
    _requireSupport();
    final response = await _request(
      type: 'portal.state.request',
      payload: const {'scope': 'app_advisor'},
      target: {'chatLocalId': chatId},
    );
    final error = response.error;
    if (error != null && error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return response.commandId;
  }

  Future<String> _submitAdvisor(
    String type,
    Map<String, dynamic> payload,
  ) async {
    _requireSupport();
    return _submit(type: type, payload: payload);
  }

  void _requireSupport() {
    if (!isSupported) {
      throw const RemoteControlException(kRemoteAppAdvisorNeedsDesktopUpdate);
    }
  }
}
