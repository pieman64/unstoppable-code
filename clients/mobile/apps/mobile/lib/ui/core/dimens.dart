/// Shared layout dimensions in Flutter logical pixels.
///
/// Use padding values with `EdgeInsets` and border widths with `BorderSide`
/// or `Border.all`. Constants can also be used in const widget constructors.
abstract final class AppDimens {
  static const double padding4 = 4;
  static const double padding8 = 8;
  static const double padding16 = 16;
  static const double padding32 = 32;

  /// The navigation list's row grid: a leading inset, a leading slot, and a
  /// gap put every row title on one column. Settings list rows share it. Rows without a leading widget
  /// inset their text by [navRowTitleInset] so it sits on that same column.
  static const double navRowLeadingInset = 16;
  static const double navRowLeadingSize = 24;
  static const double navRowLeadingGap = 12;
  static const double navRowTitleInset =
      navRowLeadingInset + navRowLeadingSize + navRowLeadingGap;

  /// Settings list rows: the reference rhythm, above the 48px touch target.
  static const double settingsRowMinHeight = 56;

  static const double border1 = 1;
  static const double border2 = 2;
}
