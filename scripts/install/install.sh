#!/bin/sh
# @@PRODUCT_NAME@@ install script for Linux, version @@VERSION@@ (A2 3.12.4).
# Rendered from scripts/install/install.sh by scripts/install/render.ts (@@BUILD_KIND@@ build).
# Do not edit it: the release keys below are what it trusts.
#
# Usage: sh install-@@VERSION@@.sh --source <folder> [--root <folder>] [--verifier <tool>]
#
#   --source <folder>  the release files, in one local folder: @@PRODUCT@@-@@VERSION@@-<platform>.tar.gz,
#                      SHA256SUMS, SHA256SUMS.sig and SHA256SUMS.sshsig.
#   --root <folder>    the install root, an absolute path whose parent folder exists. Default:
#                      $@@HOME_VAR@@. The whole install lives in it (a separate install, A2 3.2.2
#                      rule 3): versions/, current, bin/@@PRODUCT@@, config/, state/, cache/ and
#                      home.marker. This installer makes separate installs only. It writes nothing
#                      outside the root: no PATH entry, no shell profile, no desktop entry.
#   --verifier <tool>  ssh-keygen or openssl: the tool that checks the signature. Default:
#                      ssh-keygen (OpenSSH 8.1 or later) when it is there, else openssl (3.0 or
#                      later). Each accepts only a signature by a key pinned below.
#
# What it needs, all part of a usual Linux: a POSIX sh, uname, getconf, id, mkdir, mktemp, cp, mv
# (GNU, for -T), rm, rmdir, cat, wc, cut, tail, tr, sed, awk, grep, find, cmp, readlink, flock
# (util-linux), sha256sum, base64, gzip and tar; and ssh-keygen or openssl. Each is checked first, with a message naming what is
# missing.
#
# The order is the point (A2 3.12.4, review SL-13). Nothing from the archive is unpacked, run,
# sourced or loaded until the Ed25519 signature of SHA256SUMS verifies against a pinned key and
# the archive's SHA-256 matches its line in SHA256SUMS. Then its entries are checked (plain files
# and folders, relative names without . or .. segments), it is unpacked into a staging folder
# inside the install root, every file is checked against manifest.json, and the folder is renamed
# into versions/. Only then does the new version run: its own version-local launcher runs
# `@@PRODUCT@@ install --finish`, which runs the self-test (doctor's integrity, runtime and candidate
# rows) and, only once that passed, switches `current`. A failure at any point leaves the previous
# install as it was and removes what this run created, and nothing else.

# A clean start (review M1.14): no function a parent shell exported may stand in for a tool or a
# builtin (bash, which is sh on some systems, imports them even in POSIX mode), and no option or
# loader variable may change what GNU tar, gzip, grep or OpenSSL read and write, or what cd prints.
unset -f printf command cd pwd read test [ echo umask readlink uname getconf id mkdir mktemp cp \
  mv rm rmdir cat wc cut tail tr sed awk grep find cmp flock sha256sum base64 gzip tar ssh \
  ssh-keygen openssl 2> /dev/null || true
unset TAR_OPTIONS GZIP GREP_OPTIONS GREP_COLOR GREP_COLORS POSIXLY_CORRECT CDPATH ENV BASH_ENV \
  OPENSSL_CONF OPENSSL_CONF_INCLUDE OPENSSL_MODULES OPENSSL_ENGINES 2> /dev/null || true
set -eu
umask 077
LC_ALL=C
export LC_ALL

PRODUCT='@@PRODUCT@@'
PRODUCT_NAME='@@PRODUCT_NAME@@'
VERSION='@@VERSION@@'
BUILD_KIND='@@BUILD_KIND@@'
NAMESPACE="$PRODUCT-release"
# A2 3.12.3, path length: the Windows launchers' longest path below the root must stay under
# MAX_PATH. The same limit holds here, in bytes, so a root works on both systems alike.
MAX_ROOT=168

# ---- The pinned release keys (A2 3.12.5) -------------------------------------------------------
# One per line: the current key and, during a rotation, the next one. Written by render.ts from
# packages/service/src/version/release-keys.ts; a release build refuses that file's placeholder.
RELEASE_KEYS='@@RELEASE_KEYS@@'
# -------------------------------------------------------------------------------------------------

NL='
'
work=''
staging=''
target_new=''
marker_new=''
versions_new=''
root_made=''
root_new=''
root=''

# Whether current names this version. The finish puts current back when it fails, so only a crash
# or a signal after its switch leaves it so.
current_is_new() {
  [ -L "$root/current" ] && [ "$(readlink -- "$root/current" 2> /dev/null)" = "versions/$VERSION" ]
}

# Whether the root has a current at all, naming any version (a link, even a dangling one).
has_current() {
  [ -e "$root/current" ] || [ -L "$root/current" ]
}

# Removes what this run created, and nothing else: the download and staging folders, a version
# folder it renamed into place, home.marker and versions/ when it made them, and the root when it
# made the root and holds the install lock (then everything in it came from this run; before the
# lock, only while it is still empty). Called on every failure.
# Once the root has a current, it is an install that works, and only the download and staging
# folders go: current names this version (a crash or a signal after the finish's switch), the
# version an earlier install made current, or one an update made current after the finish let go
# of update.lock. An update may also use, meanwhile, a version folder this run renamed into place
# (it takes an equal folder that is there, A2 3.12.4 step 7, and holds update.lock, not this
# script's lock), so that folder stays too, verified and unused.
cleanup() {
  if [ -n "$root_new$target_new$marker_new$versions_new" ] && has_current; then
    [ -z "$work" ] || rm -rf -- "$work"
    [ -z "$staging" ] || rm -rf -- "$staging"
    if current_is_new; then
      printf '%s install: current names %s now, so it stays installed.\n' "$PRODUCT" "$VERSION" >&2
    fi
  elif [ -n "$root_new" ]; then
    rm -rf -- "$root_new"
  elif [ -n "$root_made" ]; then
    rmdir -- "$root_made" 2> /dev/null || true
  else
    [ -z "$work" ] || rm -rf -- "$work"
    [ -z "$staging" ] || rm -rf -- "$staging"
    [ -z "$target_new" ] || rm -rf -- "$target_new"
    [ -z "$marker_new" ] || rm -f -- "$marker_new"
    [ -z "$versions_new" ] || rmdir -- "$versions_new" 2> /dev/null || true
  fi
  work=''
  staging=''
  target_new=''
  marker_new=''
  versions_new=''
  root_made=''
  root_new=''
}
trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT TERM HUP

fail() {
  printf '%s install: %s\n' "$PRODUCT" "$1" >&2
  cleanup
  exit 1
}

cannot_verify() {
  fail "Cannot verify this download ($1). Stopped before anything from the archive ran."
}

need() {
  for tool in "$@"; do
    command -v "$tool" > /dev/null 2>&1 ||
      fail "This installer needs $tool, which is not installed. Install it, then run the installer again."
  done
}

if [ "$BUILD_KIND" = test ]; then
  printf '%s install: this installer was made by a test and trusts a throwaway key. Never use it for a real install.\n' "$PRODUCT" >&2
fi

# ---- Arguments ---------------------------------------------------------------------------------
source_dir=''
root=${@@HOME_VAR@@:-}
verifier=''
while [ $# -gt 0 ]; do
  case $1 in
    --source | --root | --verifier)
      [ $# -ge 2 ] || fail "$1 needs a value"
      case $1 in
        --source) source_dir=$2 ;;
        --root) root=$2 ;;
        --verifier) verifier=$2 ;;
      esac
      shift 2
      ;;
    *) fail "unknown argument (usage: sh install-$VERSION.sh --source <folder> [--root <folder>] [--verifier ssh-keygen|openssl])" ;;
  esac
done
[ -n "$source_dir" ] || fail '--source <folder> is required: the folder with the release files.'
case $verifier in '' | ssh-keygen | openssl) ;; *) fail '--verifier is ssh-keygen or openssl.' ;; esac

# ---- The keys this script trusts ---------------------------------------------------------------
keys=0
saved_ifs=$IFS
IFS=$NL
set -f
for key in $RELEASE_KEYS; do
  case $key in
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI'*) ;;
    *) fail 'This install script pins no valid release key: it is a template or damaged, not a release. Nothing was installed.' ;;
  esac
  [ ${#key} -eq 80 ] || fail 'This install script pins a damaged release key. Nothing was installed.'
  keys=$((keys + 1))
done
set +f
IFS=$saved_ifs
[ "$keys" -ge 1 ] && [ "$keys" -le 2 ] || fail 'This install script pins no release key. Nothing was installed.'

# ---- The machine -------------------------------------------------------------------------------
need uname getconf id mkdir mktemp cp mv rm rmdir cat wc cut tail tr sed awk grep find cmp \
  readlink flock sha256sum base64 gzip tar
[ "$(uname -s)" = Linux ] || fail 'This installer is for Linux.'
case $(uname -m) in
  x86_64 | amd64) PLATFORM=linux-x64 ;;
  aarch64 | arm64) PLATFORM=linux-arm64 ;;
  *) fail "There is no $PRODUCT_NAME build for this processor ($(uname -m))." ;;
esac
case $(getconf GNU_LIBC_VERSION 2> /dev/null || true) in
  'glibc '*) ;;
  *) fail "This build needs glibc. Systems with musl, such as Alpine, are not supported." ;;
esac
[ "$(id -u)" != 0 ] || fail "Run the installer as yourself, not as root: $PRODUCT_NAME installs per user."
ARCHIVE="$PRODUCT-$VERSION-$PLATFORM.tar.gz"

# ---- The install root (A2 3.2.2 rules 3 and 5, A2 3.12.4) --------------------------------------
[ -n "$root" ] || fail "Set @@HOME_VAR@@ or pass --root <folder>. This installer makes separate installs only, into a folder you name."
case $root in
  /*) ;;
  *) fail 'The install root must be an absolute path.' ;;
esac
case $root in
  *"$NL"*) fail 'The install root may not hold a line break.' ;;
esac
while [ "$root" != / ] && [ "${root%/}" != "$root" ]; do root=${root%/}; done
case "$root/" in
  */./* | */../*) fail 'The install root may not hold . or .. as a folder name.' ;;
esac
[ "$root" != / ] || fail 'The install root cannot be / itself.'

# Its length: A2 3.12.3, path length.
too_long() {
  length=$(printf '%s' "$1" | wc -c | tr -d ' ')
  [ "$length" -gt "$MAX_ROOT" ]
}
too_long "$root" &&
  fail "The install root is $length bytes long. At most $MAX_ROOT are allowed, so every path the launchers use below it stays short enough."

# Safe for code (A2 3.2.2 rule 5, A2 3.12.4): nothing from the archive may run from, or write
# to, a folder that another user can change. The root and the folders the install uses in it
# (versions, bin, state, config, cache) must be this user's plain folders, writable by no one else;
# every folder above the root must belong to this user or to root and be writable by no one else,
# unless it is sticky (/tmp), where nobody can rename or remove what another user made. A version
# folder that is already there is checked whole before it is used (step 5).
me=$(id -u)
unsafe_root() {
  [ -z "$(find "$1" -prune ! -user "$me" -print)" ] || return 0
  [ -z "$(find "$1" -prune -perm -0002 -print)" ] || return 0
  [ -z "$(find "$1" -prune -perm -0020 -print)" ] || return 0
  return 1
}
unsafe_above() {
  [ -z "$(find "$1" -prune ! -user "$me" ! -user 0 -print)" ] || return 0
  [ -z "$(find "$1" -prune \( -perm -0002 -o -perm -0020 \) ! -perm -1000 -print)" ] || return 0
  return 1
}
check_safe() {
  unsafe_root "$1" && fail "Another user can change the install root $1. Use a folder that is yours alone (chmod 700)."
  for inner in "$1/versions" "$1/bin" "$1/state" "$1/config" "$1/cache"; do
    if [ -e "$inner" ] || [ -L "$inner" ]; then
      [ -d "$inner" ] && [ ! -L "$inner" ] || fail "$inner is not a plain folder. Nothing was installed."
      unsafe_root "$inner" && fail "Another user can change $inner. Make it yours alone (chmod 700)."
    fi
  done
  # What the new version writes while it installs, deeper down: the candidate's checks in
  # state/tmp, its compile cache in cache, the receipt and update.lock. A link there would take
  # those writes out of the root.
  for inner in "$1/state/tmp" "$1/cache"; do
    if [ -e "$inner" ] || [ -L "$inner" ]; then
      [ -d "$inner" ] && [ ! -L "$inner" ] || fail "$inner is not a plain folder. Nothing was installed."
      [ -z "$(find "$inner" -type l -print)" ] ||
        fail "$inner holds a link, which would take the install's writes out of the root. Nothing was installed."
    fi
  done
  for inner in "$1/state/install.json" "$1/state/update.lock"; do
    [ ! -L "$inner" ] || fail "$inner is a link. Nothing was installed."
  done
  above=${1%/*}
  while :; do
    [ -n "$above" ] || above=/
    unsafe_above "$above" && fail "Another user can change $above, a folder above the install root. Choose a root inside your own folders."
    [ "$above" != / ] || break
    above=${above%/*}
  done
}

parent=${root%/*}
[ -n "$parent" ] || parent=/
if [ ! -e "$root" ] && [ ! -L "$root" ]; then
  [ -d "$parent" ] || fail "The install root's parent folder $parent does not exist. Create it first."
  mkdir -- "$root" || fail "Cannot create the install root $root."
  root_made=$root
fi
[ -d "$root" ] && [ ! -L "$root" ] || fail "The install root $root is not a folder (or is a link). Nothing was installed."
# From here on the root is its real path, as the launchers resolve it (readlink -f) and the install
# ID is computed from it (A2 3.2.1). Its length and the folders above it are checked again.
real=$(cd -- "$root" && pwd -P) || fail "Cannot read the install root $root."
if [ "$real" != "$root" ]; then
  [ -z "$root_made" ] || root_made=$real
  root=$real
  too_long "$root" &&
    fail "The install root's real path is $length bytes long. At most $MAX_ROOT are allowed."
fi

# One install into a root at a time, from here to the end of the clean-up (A2 3.2.3 holds
# update.lock for a whole install; a script cannot take a SQLite lock). flock on the root folder
# itself, which the system lets go when this script ends, however it ends. Only while it holds the
# lock may a failure remove the root it made: until then another install may be using it.
exec 9< "$root" || fail "Cannot open the install root $root."
if ! flock -n 9; then
  root_made=''
  fail "Another install into $root is running. Run the installer again once it has finished."
fi
# A root this run made stays its own only while it is still empty: between the mkdir and the lock
# another install may have taken it, installed and let go.
if [ -n "$root_made" ] && [ -n "$(find "$root" -mindepth 1 -maxdepth 1 -print)" ]; then
  root_made=''
fi
root_new=$root_made
root_made=''
check_safe "$root"
versions="$root/versions"
target="$versions/$VERSION"

# ---- 1. A private copy of the release files: what is verified is what gets unpacked ------------
[ -d "$source_dir" ] || cannot_verify "the folder $source_dir does not exist"
if [ ! -d "$versions" ]; then
  mkdir -- "$versions" || fail "Cannot create $versions."
  versions_new=$versions
fi
work=$(mktemp -d "$versions/.download-XXXXXXXX") || fail "Cannot create a folder in $versions."
for name in "$ARCHIVE" SHA256SUMS SHA256SUMS.sig SHA256SUMS.sshsig; do
  if [ -f "$source_dir/$name" ]; then
    cp -- "$source_dir/$name" "$work/$name" || cannot_verify "$name cannot be read"
  fi
done
[ -f "$work/SHA256SUMS" ] || cannot_verify 'SHA256SUMS is missing'
[ -f "$work/$ARCHIVE" ] || cannot_verify "$ARCHIVE is missing"

# ---- 2. The signature of SHA256SUMS, by a pinned key ---------------------------------------------
keygen_can_verify() {
  # ssh-keygen -Y came with OpenSSH 8.1. ssh -V names the version of the same package.
  command -v ssh-keygen > /dev/null 2>&1 || return 1
  openssh=$(ssh -V 2>&1) || return 0
  case $openssh in
    OpenSSH_[1-7].* | OpenSSH_8.0*) return 1 ;;
  esac
  return 0
}
if [ -z "$verifier" ]; then
  if keygen_can_verify; then
    verifier=ssh-keygen
  elif command -v openssl > /dev/null 2>&1; then
    verifier=openssl
  else
    cannot_verify 'there is no ssh-keygen (OpenSSH 8.1 or later) and no openssl. Install openssh-client, then run the installer again'
  fi
fi
need "$verifier"

verify_with_ssh_keygen() {
  [ -f "$work/SHA256SUMS.sshsig" ] || cannot_verify 'SHA256SUMS.sshsig is missing'
  printf '%s\n' "$RELEASE_KEYS" | while IFS= read -r line; do
    printf '%s namespaces="%s" %s\n' "$NAMESPACE" "$NAMESPACE" "$line"
  done > "$work/allowed_signers"
  if ! verdict=$(ssh-keygen -Y verify -f "$work/allowed_signers" -I "$NAMESPACE" -n "$NAMESPACE" \
    -s "$work/SHA256SUMS.sshsig" < "$work/SHA256SUMS" 2>&1); then
    printf '%s\n' "$verdict" >&2
    cannot_verify 'the signature of SHA256SUMS does not verify (ssh-keygen)'
  fi
}

verify_with_openssl() {
  [ -f "$work/SHA256SUMS.sig" ] || cannot_verify 'SHA256SUMS.sig is missing'
  [ "$(wc -c < "$work/SHA256SUMS.sig" | tr -d ' ')" -eq 64 ] ||
    cannot_verify 'the signature of SHA256SUMS does not verify (openssl): SHA256SUMS.sig is not an Ed25519 signature'
  verified=no
  n=0
  saved_ifs=$IFS
  IFS=$NL
  set -f
  for line in $RELEASE_KEYS; do
    n=$((n + 1))
    # The key's 32 bytes, from the end of its OpenSSH blob, behind the fixed DER prefix of an
    # Ed25519 SubjectPublicKeyInfo (RFC 8410): a PEM public key for openssl.
    {
      printf -- '-----BEGIN PUBLIC KEY-----\n'
      {
        printf '\060\052\060\005\006\003\053\145\160\003\041\000'
        printf '%s' "${line#ssh-ed25519 }" | base64 -d | tail -c 32
      } | base64 | tr -d '\n'
      printf -- '\n-----END PUBLIC KEY-----\n'
    } > "$work/key-$n.pem"
    if openssl pkeyutl -verify -pubin -inkey "$work/key-$n.pem" -rawin -in "$work/SHA256SUMS" \
      -sigfile "$work/SHA256SUMS.sig" > /dev/null 2>&1; then
      verified=yes
    fi
  done
  set +f
  IFS=$saved_ifs
  [ "$verified" = yes ] || cannot_verify 'the signature of SHA256SUMS does not verify (openssl)'
}

case $verifier in
  ssh-keygen) verify_with_ssh_keygen ;;
  openssl) verify_with_openssl ;;
esac

# ---- 3. The archive's SHA-256 against its one line in the signed SHA256SUMS -------------------
expected=$(awk -v name="$ARCHIVE" '
  NF == 2 && ($2 == name || $2 == ("*" name)) { print $1; n++ }
  END { if (n != 1) exit 1 }' "$work/SHA256SUMS") ||
  cannot_verify "SHA256SUMS does not list $ARCHIVE exactly once"
case $expected in
  *[!0-9a-f]* | '') cannot_verify 'SHA256SUMS holds a malformed digest' ;;
esac
[ ${#expected} -eq 64 ] || cannot_verify 'SHA256SUMS holds a malformed digest'
actual=$(sha256sum < "$work/$ARCHIVE" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || cannot_verify "$ARCHIVE does not match SHA256SUMS"

# ---- 4. The archive's entries, then unpacking into a staging folder in the root ----------------
# The archive is authentic now; these checks keep even a signed archive inside its folder. Every
# entry must be a plain file or folder (no link, hard link or device) with a relative name of
# plain segments, none of them . or ..
tar -tzf "$work/$ARCHIVE" > "$work/names" 2> /dev/null || fail 'The archive cannot be read.'
tar -tvzf "$work/$ARCHIVE" > "$work/entries" 2> /dev/null || fail 'The archive cannot be read.'
[ "$(wc -l < "$work/names")" -eq "$(wc -l < "$work/entries")" ] ||
  fail 'The archive lists its entries inconsistently. Nothing was unpacked.'
if grep -qv '^[-d]' "$work/entries"; then
  fail 'The archive holds an entry that is not a plain file or folder (a link or a device). Nothing was unpacked.'
fi
if grep -Evq '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/?$' "$work/names" ||
  grep -Eq '(^|/)\.\.?(/|$)' "$work/names"; then
  fail 'The archive holds a name that could leave its folder. Nothing was unpacked.'
fi
staging=$(mktemp -d "$versions/.staging-XXXXXXXX") || fail "Cannot create a folder in $versions."
tar -xzf "$work/$ARCHIVE" -C "$staging" --no-same-owner --no-same-permissions ||
  fail 'The archive cannot be unpacked.'

# Checks folder $1 against the manifest $2: its format, product, version and platform, and every
# file in $1 but its own manifest.json listed with its SHA-256, and nothing else in it: no link,
# device or pipe. manifest.json lists one `"<path>": "<hex>"` per line (folder.ts in
# packages/service/src/version owns the format).
verify_folder() {
  dir=$1
  manifest=$2
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  grep -Fqx '  "format": 1,' "$manifest" || return 1
  grep -Fqx "  \"name\": \"$PRODUCT\"," "$manifest" || return 1
  grep -Fqx "  \"version\": \"$VERSION\"," "$manifest" || return 1
  grep -Fqx "  \"platform\": \"$PLATFORM\"," "$manifest" || return 1
  sed -n 's/^    "\([A-Za-z0-9._/-]*\)": "\([0-9a-f]\{64\}\)",\{0,1\}$/\2  .\/\1/p' \
    "$manifest" > "$work/files.sha256"
  listed=$(wc -l < "$work/files.sha256")
  present=$(cd -- "$dir" && find . -type f ! -path ./manifest.json | wc -l)
  others=$(cd -- "$dir" && find . ! -type f ! -type d | wc -l)
  [ "$listed" -gt 0 ] && [ "$listed" -eq "$present" ] && [ "$others" -eq 0 ] || return 1
  (cd -- "$dir" && sha256sum -c --strict --quiet "$work/files.sha256") > /dev/null 2>&1
}

verify_folder "$staging" "$staging/manifest.json" ||
  fail 'The unpacked files do not match manifest.json. Nothing from them ran.'

# ---- 5. Into versions/<version> ------------------------------------------------------------------
if [ -e "$target" ] || [ -L "$target" ]; then
  # The same version is already there (A2 3.12.4 step 7). It runs only if it is exactly this signed
  # release: a plain folder that only this user can change, all through (checked before its files
  # are, so none can change after), its manifest.json byte for byte the staged one, every file
  # checked against that. Otherwise it is left as it is: a running Tasks may use it.
  if [ -L "$target" ] || [ ! -d "$target" ]; then
    problem='it is a link or not a folder'
  elif [ -n "$(find "$target" \( ! -user "$me" -o -perm -0002 -o -perm -0020 \) -print)" ]; then
    problem='another user can change something in it'
  elif ! cmp -s "$staging/manifest.json" "$target/manifest.json" 2> /dev/null; then
    problem='its manifest.json is not the signed one'
  elif ! verify_folder "$target" "$staging/manifest.json"; then
    problem='its files do not match the signed manifest'
  else
    problem=''
  fi
  [ -z "$problem" ] ||
    fail "versions/$VERSION already exists but is not this signed release: $problem. It was left as it is and nothing in it ran. Stop $PRODUCT_NAME if it runs from that folder, move the folder out of $versions, and run the installer again."
  rm -rf -- "$staging"
else
  mv -T -- "$staging" "$target" || fail "Cannot move the new version into $target."
  target_new=$target
fi
staging=''
rm -rf -- "$work"
work=''

# ---- 6. home.marker: the launchers set @@HOME_VAR@@ to the root (A2 3.2.2 rule 3) --------------
if [ ! -e "$root/home.marker" ]; then
  : > "$root/home.marker" || fail "Cannot write $root/home.marker."
  marker_new="$root/home.marker"
fi

# ---- 7. The new version's own launcher: self-test, then current (A2 3.12.4 step 4) ---------------
set -- install --finish
[ -z "$root_new" ] || set -- "$@" --created .
[ -z "$versions_new" ] || set -- "$@" --created versions
[ -z "$target_new" ] || set -- "$@" --created "versions/$VERSION"
[ -z "$marker_new" ] || set -- "$@" --created home.marker
if "$target/bin/$PRODUCT" "$@" 9<&-; then
  :
else
  code=$?
  fail "The new version did not finish the install (exit $code): see above."
fi
# Done: nothing of this run is removed any more.
target_new=''
marker_new=''
versions_new=''
root_new=''
