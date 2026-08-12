#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
composer_source="$project_dir/build/pulse-md.icon"
output_icns="$project_dir/build/pulse-md.icns"

if [[ ! -d "$composer_source" || -L "$composer_source" ]]; then
    print -u2 "Missing Icon Composer source: $composer_source"
    exit 1
fi
for required_composer_file in \
    "$composer_source/icon.json" \
    "$composer_source/Assets/folded-corner-dark.svg" \
    "$composer_source/Assets/folded-corner-light.svg" \
    "$composer_source/Assets/markdown-mark-dark.svg" \
    "$composer_source/Assets/markdown-mark-light.svg" \
    "$composer_source/Assets/placeholder-lines-dark.svg" \
    "$composer_source/Assets/placeholder-lines-light.svg"; do
    if [[ ! -f "$required_composer_file" ]]; then
        print -u2 "Missing Icon Composer document file: $required_composer_file"
        exit 1
    fi
done
if ! actool_path=$(/usr/bin/xcrun --find actool 2>/dev/null); then
    print -u2 "Install Xcode 26 or newer to rebuild pulse-md.icns."
    exit 1
fi

temporary_dir=$(/usr/bin/mktemp -d -t pulse-md-icon)
temporary_dir=${temporary_dir:A}
if [[ -z "$temporary_dir" || ! -d "$temporary_dir" || -L "$temporary_dir" ||
      "$temporary_dir" != /private/*/pulse-md-icon.* ]]; then
    print -u2 "Could not create a safe temporary icon directory."
    exit 1
fi
cleanup() {
    if [[ -n "$temporary_dir" && -d "$temporary_dir" &&
          ! -L "$temporary_dir" &&
          "$temporary_dir" == /private/*/pulse-md-icon.* ]]; then
        /bin/rm -rf "$temporary_dir"
    fi
}
trap cleanup EXIT INT TERM

staged_composer_source="$temporary_dir/Icon.icon"
compiled_icon_dir="$temporary_dir/compiled"
/usr/bin/ditto "$composer_source" "$staged_composer_source"
/bin/mkdir -p "$compiled_icon_dir"
"$actool_path" "$staged_composer_source" \
    --compile "$compiled_icon_dir" \
    --output-format human-readable-text \
    --notices \
    --warnings \
    --output-partial-info-plist "$compiled_icon_dir/assetcatalog_generated_info.plist" \
    --app-icon Icon \
    --include-all-app-icons \
    --enable-on-demand-resources NO \
    --development-region en \
    --target-device mac \
    --minimum-deployment-target 13.0 \
    --platform macosx \
    --standalone-icon-behavior all

compiled_icns="$compiled_icon_dir/Icon.icns"
if [[ ! -f "$compiled_icns" ]]; then
    print -u2 "actool did not generate the legacy application icon."
    exit 1
fi
/bin/cp "$compiled_icns" "$output_icns"
print -r -- "$output_icns"
