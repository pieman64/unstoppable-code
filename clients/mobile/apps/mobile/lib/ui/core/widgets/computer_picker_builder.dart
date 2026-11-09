import 'package:flutter/widgets.dart';

/// App-composed computer picker for detail routes. Features borrow this slot
/// without depending on the Computer Connect feature or owning its sessions.
typedef ComputerPickerBuilder = Widget Function(String title);
