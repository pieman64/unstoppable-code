import 'package:flutter/material.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

/// A failed validation does not grant access or discard the saved session.
class SessionRecoveryScreen extends StatefulWidget {
  const SessionRecoveryScreen({super.key});

  @override
  State<SessionRecoveryScreen> createState() => _SessionRecoveryScreenState();
}

class _SessionRecoveryScreenState extends State<SessionRecoveryScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      context.read<AuthViewModel>().restore();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.cloud_off_outlined,
                size: 40,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 24),
              Text(
                "Couldn't verify your session",
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              Text(
                'Your sign-in is saved. Check your connection and try again.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 24),
              FilledButton(
                key: const ValueKey('session-retry'),
                onPressed: () => context.read<AuthViewModel>().restore(),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
