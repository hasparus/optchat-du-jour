#!/bin/sh
# Installs the Bend this kernel is checked and compiled with, pinned by version and sha256
# (the same archives bend-lang.com/install.sh fetches), into $BEND_HOME (default ~/.bend).
set -eu
VER=2.0.35
case $(uname -s)-$(uname -m) in
  Linux-x86_64) arch=linux-x64; sum=63039d1a119f716767ac5a7d8fe0717cfacf219c6c253c35192148e0dade722f;;
  Linux-aarch64) arch=linux-arm64; sum=09b813073241628f590f2c2fe420299ec25e4dddd6cf3fdc49c9486339989564;;
  Darwin-arm64) arch=darwin-arm64; sum=2582f25057a519c330e6875798b784b727d4201f1c1f6944a105348f0eb8972e;;
  Darwin-x86_64) arch=darwin-x64; sum=7e59da4513e32ea7526464b342344a992a56372cdf62e0c55a30e9ce26baaeef;;
  *) echo "install-bend: $(uname -s)-$(uname -m) is not supported" >&2; exit 1;;
esac
home=${BEND_HOME:-$HOME/.bend}
name=bend-$VER-$arch.tar.gz
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/$name" "https://github.com/bendlang/bend/releases/download/v$VER/$name"
if command -v sha256sum >/dev/null 2>&1; then echo "$sum  $tmp/$name" | sha256sum -c - >/dev/null
else echo "$sum  $tmp/$name" | shasum -a 256 -c - >/dev/null; fi
tar -xzf "$tmp/$name" -C "$tmp" 2>/dev/null # GNU tar warns about macOS xattr headers
mkdir -p "$home/bin"
rm -rf "$home/bend2" "$home/guide"
mv "$tmp/bend/bend2" "$tmp/bend/guide" "$home/"
mv -f "$tmp/bend/bin/bend" "$home/bin/bend"
echo "bend $VER installed at $home/bin/bend"
