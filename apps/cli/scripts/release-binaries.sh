#!/usr/bin/env bash
set -euo pipefail

archives=(
  wald-darwin-arm64.tar.gz
  wald-darwin-x64.tar.gz
  wald-linux-arm64.tar.gz
  wald-linux-x64.tar.gz
)

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

check_tag() {
  [[ $1 =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || fail "Expected a stable version tag (vX.Y.Z), got $1."
}

case "$1" in
  check-version)
    package_version=$(node -p 'require("./apps/cli/package.json").version')
    if [[ $# == 3 ]]; then
      check_tag "$3"
      [[ $3 == "v$package_version" ]] || fail "Tag $3 does not match CLI version $package_version."
    fi
    binary_version=$("$2" --version)
    [[ $binary_version == "$package_version" ]] \
      || fail "Binary version $binary_version does not match CLI version $package_version."
    ;;
  prepare)
    cd -- "$2"
    shopt -s nullglob dotglob
    files=(*)
    [[ ${#files[@]} == ${#archives[@]} ]] || fail 'Expected exactly four platform archives.'
    for archive in "${archives[@]}"; do
      [[ -f $archive && -s $archive ]] || fail "Missing or empty archive: $archive"
    done
    sha256sum "${archives[@]}" > SHA256SUMS
    ;;
  draft)
    cd -- "$2"
    repository=$3
    tag=$4
    check_tag "$tag"
    sha256sum --check --strict SHA256SUMS
    # The authenticated release list includes drafts as well as published releases.
    tags=$(gh api --paginate "repos/$repository/releases?per_page=100" --jq '.[].tag_name')
    if grep -Fxq -- "$tag" <<< "$tags"; then
      fail "A release for $tag already exists. Review it at https://github.com/$repository/releases."
    fi
    gh release create "$tag" --repo "$repository" --verify-tag --draft --generate-notes \
      "${archives[@]}" SHA256SUMS
    ;;
  *) fail 'Expected check-version, prepare, or draft.' ;;
esac
