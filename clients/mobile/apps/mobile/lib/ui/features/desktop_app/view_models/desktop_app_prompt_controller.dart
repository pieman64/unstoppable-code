import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/services/desktop_app_prompt_store.dart';
import 'package:mobile/services/desktop_app/desktop_app_prompt_policy.dart';
import 'package:mobile/services/link_sharer.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_presentation.dart';

/// Owns the "Get the desktop app" prompt (CAN-4424): who may see it, when
/// a successful cloud turn raises it once per account on this device, and
/// what Share link and Copy link do.
///
/// App-lifetime singleton provided from `buildRootProviders()`, like the
/// satisfaction prompt, because cloud chats are pushed on the root navigator.
/// The shell publishes the account and pairing state through
/// [updateContext]; `DesktopAppPromptHost` decides when to [presentPending],
/// and the drawer calls [open].
class DesktopAppPromptController extends ChangeNotifier
    with DisposeSafeNotifier {
  DesktopAppPromptController({
    required this._store,
    required this._isActive,
    required this._downloadUrl,
    required this._sharer,
    Future<void> Function(String text)? copy,
    required this._showPrompt,
  }) : _copy = copy ?? _copyToClipboard;

  final DesktopAppPromptStore _store;
  final bool Function() _isActive;
  final String Function() _downloadUrl;
  final LinkSharer _sharer;
  final Future<void> Function(String text) _copy;
  final DesktopAppPromptPresenter _showPrompt;

  String? _accountScope;
  DesktopPairing _pairing = DesktopPairing.unknown;
  int _accountGeneration = 0;

  /// Accounts that closed the prompt this launch, kept in memory so a failed
  /// write still never re-prompts before the next launch.
  final Set<String> _dismissed = {};
  bool _pending = false;
  bool _presenting = false;

  /// Whether the signed-in account has no paired desktop, so the drawer
  /// offers the desktop app.
  bool get canOffer =>
      _isActive() &&
      canOfferDesktopApp(accountScope: _accountScope, pairing: _pairing);

  /// True when a successful turn raised the prompt and it has not opened yet.
  bool get pendingPrompt => _pending && !_presenting && canOffer;

  /// Publishes the signed-in account (`null` while signed out) and what is
  /// known about its paired desktop.
  void updateContext({
    required String? accountScope,
    required DesktopPairing pairing,
  }) {
    if (accountScope == _accountScope && pairing == _pairing) return;
    if (accountScope != _accountScope) {
      _accountGeneration++;
      _pending = false;
    }
    _accountScope = accountScope;
    _pairing = pairing;
    if (!canOffer) _pending = false;
    notifyListenersSafe();
  }

  /// Reports one successful cloud chat turn. Returns true when the prompt is
  /// raised by it, or already due or open, so other prompts leave this turn
  /// alone.
  Future<bool> claimSuccessfulTurn() async {
    if (_pending || _presenting) return true;
    final scope = _accountScope;
    if (scope == null || !canOffer || _dismissed.contains(scope)) return false;
    final generation = _accountGeneration;
    final dismissed = await _store.isDismissed(scope);
    if (generation != _accountGeneration) return false;
    if (dismissed) {
      _dismissed.add(scope);
      return false;
    }
    if (_pending || _presenting) return true;
    if (!canOffer) return false;
    _pending = true;
    notifyListenersSafe();
    return true;
  }

  /// Opens the prompt a turn raised. A no-op unless [pendingPrompt].
  Future<void> presentPending(BuildContext context) async {
    if (!pendingPrompt) return;
    await _run(context);
  }

  /// Opens the prompt on request, even after the account closed it before.
  Future<void> open(BuildContext context) async {
    if (_presenting || !canOffer) return;
    await _run(context);
  }

  Future<void> _run(BuildContext context) async {
    final scope = _accountScope;
    if (scope == null) return;
    _pending = false;
    _presenting = true;
    notifyListenersSafe();
    try {
      DesktopAppPromptChoice choice;
      try {
        choice = await _showPrompt(context);
      } catch (error) {
        debugPrint('Desktop app prompt failed to show: $error');
        choice = (action: DesktopAppPromptAction.dismissed, shareOrigin: null);
      }
      // Any close counts, so persist before acting on the choice.
      await _markDismissed(scope);
      final url = _downloadUrl();
      switch (choice.action) {
        case DesktopAppPromptAction.share:
          try {
            await _sharer.share(
              text: 'Get ${Brand.productDisplayName} for your computer: $url',
              subject: '${Brand.productDisplayName} for your computer',
              origin: choice.shareOrigin,
            );
          } catch (error) {
            debugPrint('Desktop app link not shared: $error');
          }
        case DesktopAppPromptAction.copy:
          var copied = true;
          try {
            await _copy(url);
          } catch (error) {
            copied = false;
            debugPrint('Desktop app link not copied: $error');
          }
          if (!context.mounted) return;
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            SnackBar(
              key: const ValueKey('desktop-app-prompt-copy-result'),
              content: Text(
                copied ? 'Link copied' : "Couldn't copy to clipboard",
              ),
            ),
          );
        case DesktopAppPromptAction.notNow:
        case DesktopAppPromptAction.dismissed:
          break;
      }
    } finally {
      _presenting = false;
      notifyListenersSafe();
    }
  }

  Future<void> _markDismissed(String scope) async {
    _dismissed.add(scope);
    try {
      await _store.markDismissed(scope);
    } catch (error) {
      debugPrint('Desktop app prompt dismissal not saved: $error');
    }
  }

  static Future<void> _copyToClipboard(String text) =>
      Clipboard.setData(ClipboardData(text: text));
}
