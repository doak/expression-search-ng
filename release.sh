#!/usr/bin/env bash

set -eu


# On Debian this requires the package 'p7zip-full'.
zip() {
    7z a -tzip -mx1 "$@"
}

getVersion() {
    git describe --dirty --tags --always
}

createXpi() {
    local name="$1"
    shift
    local version
    local archive
    local content=(
        api
        ex-background.js
        html
        _locales
        manifest.json
        modules
        scripts
        skin
    )
    
    version="$(getVersion)"
    version="${version#*/}"
    archive="$name-$version.xpi"

    rm -f "$archive"
    zip "$archive" "$@" "${content[@]}"
}


createXpi expression-search-ng
