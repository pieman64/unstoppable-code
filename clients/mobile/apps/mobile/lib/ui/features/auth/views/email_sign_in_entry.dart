import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/email_auth_screen.dart';
import 'package:provider/provider.dart';

/// Probe failures/old servers hide only this entry, preserving social access.
class EmailSignInEntry extends StatefulWidget {
  const EmailSignInEntry({required this.enabled, super.key});
  final bool enabled;
  @override
  State<EmailSignInEntry> createState() => _EmailSignInEntryState();
}

class _EmailSignInEntryState extends State<EmailSignInEntry>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    AppConfig.environmentListenable.addListener(_probe);
    _probe();
  }

  void _probe() {
    unawaited(context.read<AuthViewModel>().loadEmailEntry());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _probe();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    AppConfig.environmentListenable.removeListener(_probe);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthViewModel>();
    final repository = auth.emailAuthRepository;
    if (!auth.emailEntryAvailable || repository == null) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: OutlinedButton.icon(
        icon: const Icon(Icons.email_outlined),
        label: const Text('Continue with email'),
        onPressed: !widget.enabled
            ? null
            : () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => EmailAuthScreen(repository: repository),
                ),
              ),
      ),
    );
  }
}
