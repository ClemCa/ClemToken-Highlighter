#!/usr/bin/env bash
# One-time setup for building the Linux engine inside WSL2. Run it from a WSL shell at the root of
# this repository:
#
#   bash scripts/setup-wsl.sh
#
# The first half needs root and will ask for your password; the second half installs the .NET SDK
# into ~/.dotnet so nothing outside your home directory is touched. Running the script as root only
# does the first half, which is handy when the password prompt is inconvenient.
set -euo pipefail

# NativeAOT links the finished executable with clang and zlib, so both have to be present. curl is
# only here for the SDK download below.
missing=""
for package in clang zlib1g-dev curl; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || missing="$missing $package"
done

if [ -n "$missing" ]; then
  echo "Installing:$missing"
  if [ "$(id -u)" -eq 0 ]; then
    apt="apt-get"
  else
    apt="sudo apt-get"
  fi
  $apt update -qq
  # shellcheck disable=SC2086
  $apt install -y --no-install-recommends $missing
fi

# Only the apt half can be done as root. The SDK belongs to whoever will run the build, and running
# it as root would put it in /root/.dotnet where the build would not find it.
if [ "$(id -u)" -eq 0 ]; then
  echo "Native toolchain ready. Re-run this script as your normal user for the .NET SDK:"
  echo "  bash scripts/setup-wsl.sh"
  exit 0
fi

if [ ! -x "$HOME/.dotnet/dotnet" ]; then
  echo "Installing the .NET 10 SDK into $HOME/.dotnet"
  curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir "$HOME/.dotnet"
fi

echo
echo "Ready:"
"$HOME/.dotnet/dotnet" --list-sdks
