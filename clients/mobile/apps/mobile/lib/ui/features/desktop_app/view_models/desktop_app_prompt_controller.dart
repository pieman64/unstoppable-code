import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/services/desktop_app/desktop_app_prompt_policy.dart';
import 'package:mobile/services/link_sharer.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_presentation.dart';

/// Opens the desktop download/share sheet from the navigation drawer.
class DesktopAppPromptController extends ChangeNotifier
    with DisposeSafeNotifier {
  DesktopAppPromptController({
    required this._isActive,
    required this._downloadUrl,
    required this._sharer,
    Future<void> Function(String text)? copy,
    required this._showPrompt,
  }) : _copy = copy ?? _copyToClipboard;

  final bool Function() _isActive;
  final String Function() _downloadUrl;
  final LinkSharer _sharer;
  final Future<void> Function(String text) _copy;
  final DesktopAppPromptPresenter _showPrompt;

  String? _accountScope;
  DesktopPairing _pairing = DesktopPairing.unknown;

  bool _presenting = false;

  /// Whether the signed-in account has no paired desktop, so the drawer
  /// offers the desktop app.
  bool get canOffer =>
      _isActive() &&
      canOfferDesktopApp(accountScope: _accountScope, pairing: _pairing);

  /// Publishes the signed-in account (`null` while signed out) and what is
  /// known about its paired desktop.
  void updateContext({
    required String? accountScope,
    required DesktopPairing pairing,
  }) {
    if (accountScope == _accountScope && pairing == _pairing) return;
    _accountScope = accountScope;
    _pairing = pairing;
    notifyListenersSafe();
  }

  /// Opens the prompt on request, even after the account closed it before.
  Future<void> open(BuildContext context) async {
    if (_presenting || !canOffer) return;
    await _run(context);
  }

  Future<void> _run(BuildContext context) async {
    final scope = _accountScope;
    if (scope == null) return;
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

  static Future<void> _copyToClipboard(String text) =>
      Clipboard.setData(ClipboardData(text: text));
}
