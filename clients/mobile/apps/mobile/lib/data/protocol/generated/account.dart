// dart format off
// GENERATED FILE. Do not edit by hand.
// Maintainer-generated API bindings; verify with the adjacent public digest manifest.

/// `200` body for `PATCH /api/account/profile`.
class UpdateProfileResponse {
  const UpdateProfileResponse({this.image, required this.name});

  final String? image;
  final String name;

  factory UpdateProfileResponse.fromJson(Map<String, dynamic> json) => UpdateProfileResponse(
        image: json['image'] as String?,
        name: json['name'] as String,
      );
}
