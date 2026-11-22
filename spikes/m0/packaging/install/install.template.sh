#!/bin/sh
# Tasks installer for Linux x64, version @@VERSION@@. M0.03 packaging spike (A2 3.12.4).
# Generated from spikes/m0/packaging/install/install.template.sh. Do not edit: the release keys
# below are what this script trusts.
#
# Usage: sh install-@@VERSION@@.sh --source <folder> [--root <folder>]
#   --source  folder with ttasks-@@VERSION@@-linux-x64.tar.gz, SHA256SUMS and SHA256SUMS.sshsig
#   --root    install root. Defaults to $TTASKS_HOME. The spike installs only into a folder that
#             is named this way, never into ~/.local/share/ttasks.
#
# Order of trust: the Ed25519 signature of SHA256SUMS must verify with ssh-keygen against a key
# pinned below, and the archive's SHA-256 must match SHA256SUMS, before the archive is unpacked.
# So nothing from the archive runs, or even reaches the disk outside the download copy, unless
# both hold. Only then is every unpacked file checked against manifest.json, and only then does
# the new version's own launcher run its self-test. An existing folder of the same version runs
# only if it is exactly this signed release: its manifest.json equal to the unpacked one and every
# file matching it.
set -eu
umask 077

VERSION='@@VERSION@@'
ARCHIVE="ttasks-$VERSION-linux-x64.tar.gz"
NAMESPACE='ttasks-release'
# Pinned release keys, one per line: the current key and, during a rotation, the next one.
RELEASE_KEYS='@@RELEASE_KEYS@@'

work=''
staging=''
cleanup() {
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  if [ -n "$staging" ]; then rm -rf -- "$staging"; fi
  work=''
  staging=''
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

fail() {
  printf 'ttasks install: %s\n' "$1" >&2
  cleanup
  exit 1
}

cannot_verify() {
  fail "Cannot verify this download ($1). Stopped before anything from the archive ran."
}

source_dir=''
root=${TTASKS_HOME:-}
while [ $# -gt 0 ]; do
  case $1 in
    --source)
      [ $# -ge 2 ] || fail 'missing value for --source'
      source_dir=$2
      shift 2
      ;;
    --root)
      [ $# -ge 2 ] || fail 'missing value for --root'
      root=$2
      shift 2
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ -n "$source_dir" ] || fail '--source <folder> is required'
[ -n "$root" ] || fail 'Set TTASKS_HOME or pass --root: the spike installs only into a folder you name.'

[ "$(uname -s)" = Linux ] || fail 'this installer is for Linux'
[ "$(uname -m)" = x86_64 ] || fail 'this installer is for x86-64'
case $(getconf GNU_LIBC_VERSION 2>/dev/null || true) in
  glibc\ *) ;;
  *) fail 'this build needs glibc' ;;
esac

mkdir -p -- "$root/versions"
root=$(cd -- "$root" && pwd -P)
versions="$root/versions"

# 1. Copy the three inputs into a private folder, so what is verified is what gets unpacked.
work=$(mktemp -d "$versions/.download-XXXXXXXX")
for name in "$ARCHIVE" SHA256SUMS SHA256SUMS.sshsig; do
  [ -f "$source_dir/$name" ] || cannot_verify "$name is missing"
  cp -- "$source_dir/$name" "$work/$name"
done

# 2. The signature of SHA256SUMS, with the OS's own ssh-keygen and only the pinned keys.
keygen=$(command -v ssh-keygen 2>/dev/null) ||
  cannot_verify 'ssh-keygen not found. Install openssh-client, then run the installer again'
printf '%s\n' "$RELEASE_KEYS" | while IFS= read -r key; do
  if [ -n "$key" ]; then printf '%s namespaces="%s" %s\n' "$NAMESPACE" "$NAMESPACE" "$key"; fi
done > "$work/allowed_signers"
if ! verdict=$("$keygen" -Y verify -f "$work/allowed_signers" -I "$NAMESPACE" -n "$NAMESPACE" \
  -s "$work/SHA256SUMS.sshsig" < "$work/SHA256SUMS" 2>&1); then
  printf '%s\n' "$verdict" >&2
  cannot_verify 'the signature of SHA256SUMS does not verify'
fi

# 3. The archive's SHA-256 against its single line in the signed SHA256SUMS.
expected=$(awk -v name="$ARCHIVE" '
  NF == 2 && ($2 == name || $2 == ("*" name)) { print $1; n++ }
  END { if (n != 1) exit 1 }' "$work/SHA256SUMS") || cannot_verify "SHA256SUMS does not list $ARCHIVE exactly once"
case $expected in
  *[!0-9a-f]* | '') cannot_verify 'SHA256SUMS holds a malformed digest' ;;
esac
[ ${#expected} -eq 64 ] || cannot_verify 'SHA256SUMS holds a malformed digest'
actual=$(sha256sum < "$work/$ARCHIVE" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || cannot_verify "$ARCHIVE does not match SHA256SUMS"

# 4. Only now unpack, into a staging folder next to the version folders.
staging=$(mktemp -d "$versions/.staging-XXXXXXXX")
tar -xzf "$work/$ARCHIVE" -C "$staging" --no-same-owner || fail 'cannot unpack the archive'

# Checks folder $1 against the manifest $2: every regular file in $1 except its own manifest.json
# must be listed with its SHA-256, and nothing else may exist (no links, devices or pipes).
verify_folder() {
  dir=$1
  manifest=$2
  [ -f "$manifest" ] || return 1
  grep -Fqx "  \"version\": \"$VERSION\"," "$manifest" || return 1
  grep -Fqx '  "platform": "linux-x64",' "$manifest" || return 1
  sed -n 's/^    "\([A-Za-z0-9._/-]*\)": "\([0-9a-f]\{64\}\)",\{0,1\}$/\2  .\/\1/p' \
    "$manifest" > "$work/files.sha256"
  listed=$(wc -l < "$work/files.sha256")
  present=$(cd -- "$dir" && find . -type f ! -path ./manifest.json | wc -l)
  others=$(cd -- "$dir" && find . ! -type f ! -type d | wc -l)
  [ "$listed" -gt 0 ] && [ "$listed" -eq "$present" ] && [ "$others" -eq 0 ] || return 1
  (cd -- "$dir" && sha256sum -c --strict --quiet "$work/files.sha256") > /dev/null 2>&1
}

verify_folder "$staging" "$staging/manifest.json" || fail 'the unpacked files do not match manifest.json'
target="$versions/$VERSION"
if [ -e "$target" ] || [ -L "$target" ]; then
  # The same version is already there. It runs only if it is exactly this signed release: a plain
  # folder, its manifest.json byte for byte the staged one (which the signature covers), and every
  # file checked against the staged manifest. Otherwise stop and leave it as it is: it may be the
  # version a running TTasks uses.
  if [ -L "$target" ] || [ ! -d "$target" ]; then
    problem='it is a link or not a folder'
  elif ! cmp -s "$staging/manifest.json" "$target/manifest.json" 2>/dev/null; then
    problem='its manifest.json is not the signed one'
  elif ! verify_folder "$target" "$staging/manifest.json"; then
    problem='its files do not match the signed manifest'
  else
    problem=''
  fi
  [ -z "$problem" ] || fail "versions/$VERSION already exists but is not this signed release: $problem. It was left as it is and nothing in it ran. Stop TTasks if it runs from that folder, move the folder out of $versions, and run the installer again."
  rm -rf -- "$staging"
else
  mv -T -- "$staging" "$target"
fi
staging=''
rm -rf -- "$work"
work=''

# 5. A separate install (TTASKS_HOME) is marked, so the launcher exports TTASKS_HOME (A2 3.12.3).
: > "$root/home.marker"

# 6. Hand over to the verified version through its own launcher: self-test, current, bin/ttasks.
"$target/bin/ttasks" install --finish || fail 'the new version failed its self-test'
printf 'The stable command is %s/bin/ttasks\n' "$root"
