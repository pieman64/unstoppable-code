#!/usr/bin/env bash
# Launch the Unstoppable Code mobile app (apps/mobile) on a physical phone or a
# virtual device (iOS Simulator / Android emulator).
#
# The target device is auto-detected from `flutter devices` so no per-machine
# device name has to be committed to canopy.json. Called by Canopy's
# "Launch UD Mobile (*)" scripts.
#
# Usage: tool/run.sh <ios|android> <device|simulator|emulator>
#   device                -> connected physical phone (profile build, prod + staging)
#   simulator | emulator  -> booted virtual device (debug build, prod + staging)
set -uo pipefail

usage() {
  echo "Usage: $0 <ios|android> <device|simulator|emulator>" >&2
  exit 2
}

platform="${1:-}"
kind="${2:-}"

case "$platform" in
  ios | android) ;;
  *) usage ;;
esac
case "$kind" in
  device) want_emulator=false ;;
  simulator | emulator) want_emulator=true ;;
  *) usage ;;
esac

command -v flutter >/dev/null 2>&1 || {
  echo "flutter was not found on PATH. Install Flutter (https://docs.flutter.dev/get-started/install)" >&2
  echo "or add it to PATH, then retry." >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required to detect the target device." >&2
  exit 1
}

# Run from apps/mobile regardless of the caller's working directory.
cd "$(dirname "$0")/.."

PROD_URL="https://app.unstoppable.ai"
STAGING_URL="https://code.ud-staging.com"

# Print the id of the first flutter device matching the platform + emulator flag.
resolve_device() {
  flutter devices --machine 2>/dev/null | python3 -c '
import json, sys
plat, want = sys.argv[1], sys.argv[2] == "true"
try:
    devices = json.load(sys.stdin)
except Exception:
    devices = []
for d in devices:
    if str(d.get("targetPlatform", "")).startswith(plat) \
       and bool(d.get("emulator", False)) == want:
        print(d.get("id", ""))
        break
' "$platform" "$want_emulator"
}

# Best-effort boot of a virtual device when none is already running.
boot_virtual() {
  if [[ "$platform" == "ios" ]]; then
    open -a Simulator
    return
  fi
  # Android: launch the first available AVD. `flutter emulators` has no
  # machine-readable mode, so AVD names come from the SDK's emulator binary.
  local emulator_bin avd
  emulator_bin="$(command -v emulator 2>/dev/null)"
  for candidate in \
    "${ANDROID_HOME:-}/emulator/emulator" \
    "${ANDROID_SDK_ROOT:-}/emulator/emulator" \
    "$HOME/Library/Android/sdk/emulator/emulator"; do
    [[ -n "$emulator_bin" ]] && break
    [[ -x "$candidate" ]] && emulator_bin="$candidate"
  done
  [[ -n "$emulator_bin" ]] || return
  avd="$("$emulator_bin" -list-avds 2>/dev/null | head -1)"
  [[ -n "$avd" ]] && flutter emulators --launch "$avd" >/dev/null 2>&1 || true
}

if [[ "$want_emulator" == true ]]; then
  device_id="$(resolve_device || true)"
  if [[ -z "$device_id" ]]; then
    boot_virtual
    # Cold boots can be slow; poll until the virtual device appears.
    for _ in $(seq 1 60); do
      device_id="$(resolve_device || true)"
      [[ -n "$device_id" ]] && break
      sleep 1
    done
  fi
  if [[ -z "$device_id" ]]; then
    echo "No booted $platform virtual device found. Boot one and retry." >&2
    echo "Available emulators:" >&2
    flutter emulators >&2 || true
    exit 1
  fi
  # Debug builds receive both fixed origins so the hidden sign-in environment
  # picker can exercise production without rebuilding. AppConfig keeps staging
  # as the first-run debug default; a persisted choice still wins thereafter.
  exec flutter run -d "$device_id" \
    --dart-define=UNSTOPPABLE_CODE_API_BASE_URL_PRODUCTION="$PROD_URL" \
    --dart-define=UNSTOPPABLE_CODE_API_BASE_URL_STAGING="$STAGING_URL"
fi

# Physical device (profile build, canonical prod + staging dart-defines).
device_id="$(resolve_device || true)"
if [[ -z "$device_id" ]]; then
  echo "No connected physical $platform device found. Plug in & trust a phone, then retry." >&2
  echo "Connected devices:" >&2
  flutter devices >&2 || true
  exit 1
fi
exec flutter run --profile -d "$device_id" \
  --dart-define=UNSTOPPABLE_CODE_API_BASE_URL_PRODUCTION="$PROD_URL" \
  --dart-define=UNSTOPPABLE_CODE_API_BASE_URL_STAGING="$STAGING_URL"
