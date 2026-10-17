#!/usr/bin/env bash
# Builds the Linux NativeAOT engine inside WSL2.
#
#   bash scripts/stage-engine.sh <engine-repo> <bin-dir> [rid]
#
# Paths may be given in either Windows or WSL form. Normally this is driven by
# scripts/stage-engine.mjs, but it can be run on its own from a WSL shell.
set -euo pipefail

# a path that already starts with / is a WSL path; anything else came from Windows
to_wsl() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) wslpath -u "$1" ;;
  esac
}

engine=$(to_wsl "${1:?engine repo path required}")
bin=$(to_wsl "${2:?bin directory required}")
rid="${3:-linux-x64}"

dotnet="$HOME/.dotnet/dotnet"
if [ ! -x "$dotnet" ]; then
  dotnet="$(command -v dotnet || true)"
fi
if [ -z "$dotnet" ]; then
  echo "No .NET SDK found inside WSL. Run 'bash scripts/setup-wsl.sh' first." >&2
  exit 1
fi

# Building straight from /mnt/c is several times slower than from WSL's own filesystem, so the
# sources are copied in and only the finished artifacts go back.
work="${XDG_CACHE_HOME:-$HOME/.cache}/clemtoken-stage"
rm -rf "$work"
mkdir -p "$work/src"

shopt -s nullglob
cp "$engine"/*.cs "$engine"/*.csproj "$engine"/dsl.ct "$work/src/"

echo "Publishing NativeAOT engine ($rid) inside WSL"
"$dotnet" publish "$work/src/ClemToken.csproj" -c Release -r "$rid" -p:PublishAot=true -o "$work/out"

mkdir -p "$bin/$rid"
cp "$work/out/ClemToken" "$bin/$rid/ClemToken"

# compiled by the engine that was just built, so the binary and the grammar cannot drift apart
"$work/out/ClemToken" build "$work/src/dsl.ct" -o "$bin/dsl.cta"

echo "Staged $bin/$rid"
