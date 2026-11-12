#!/usr/bin/env bash

# Parse the complete block before running any part of a streamed installer.
(
  set -euo pipefail

  fail() {
    printf 'Wald install: %s\n' "$*" >&2
    exit 1
  }

  repository=https://github.com/phillippbertram/wald-worktree
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) platform=darwin-arm64 ;;
    Darwin/x86_64) platform=darwin-x64 ;;
    Linux/aarch64 | Linux/arm64) platform=linux-arm64 ;;
    Linux/x86_64) platform=linux-x64 ;;
    *) fail 'Supported platforms are macOS and Linux (glibc) on x64 and ARM64.' ;;
  esac
  asset="wald-$platform.tar.gz"

  if command -v sha256sum >/dev/null 2>&1; then
    checksum=(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then
    checksum=(shasum -a 256)
  else
    fail 'Install sha256sum or shasum to verify the download.'
  fi

  install_dir=${WALD_INSTALL_DIR:-"${HOME:?Set HOME or WALD_INSTALL_DIR}/.local/bin"}
  [[ $install_dir = /* ]] || fail 'WALD_INSTALL_DIR must be an absolute path.'
  destination="${install_dir%/}/wald"
  curl_options=(-q --fail --silent --show-error --location --proto '=https' --proto-redir '=https')

  release_url=$(curl "${curl_options[@]}" --output /dev/null --write-out '%{url_effective}' \
    "$repository/releases/latest") || fail "Could not find a published release at $repository/releases."
  tag=${release_url#"$repository/releases/tag/"}
  [[ $release_url == "$repository/releases/tag/$tag" && $tag =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || fail "Could not find a stable published release at $repository/releases."
  download_url="$repository/releases/download/$tag"

  work=$(mktemp -d "${TMPDIR:-/tmp}/wald-install.XXXXXX")
  staged_binary=
  cleanup() {
    if [[ -n $staged_binary ]]; then
      rm -f -- "$staged_binary"
    fi
    rm -rf -- "$work"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  curl "${curl_options[@]}" --output "$work/SHA256SUMS" "$download_url/SHA256SUMS" \
    || fail "Could not download checksums for $tag."
  expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$work/SHA256SUMS")
  [[ $expected =~ ^[a-f0-9]{64}$ ]] || fail "Missing or invalid SHA-256 checksum for $asset."

  curl "${curl_options[@]}" --output "$work/$asset" "$download_url/$asset" \
    || fail "Could not download $asset for $tag."
  actual=$("${checksum[@]}" < "$work/$asset")
  [[ ${actual%% *} == "$expected" ]] || fail "SHA-256 checksum mismatch for $asset."

  mkdir -p -- "$install_dir"
  [[ ! -d $destination ]] || fail "Installation path is a directory: $destination"
  staged_binary=$(mktemp "${install_dir%/}/.wald.XXXXXX")
  tar -xOzf "$work/$asset" wald > "$staged_binary" || fail "Could not extract wald from $asset."
  chmod 755 "$staged_binary"
  version=$("$staged_binary" --version) || fail "Could not run Wald $tag on this system."
  [[ $version == "${tag#v}" ]] || fail "Expected Wald ${tag#v}, got $version."
  mv -f -- "$staged_binary" "$destination"
  staged_binary=

  printf 'Installed Wald %s at %s\n' "$version" "$destination"
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) printf 'Add %s to PATH to run wald from your shell.\n' "$install_dir" ;;
  esac
)
