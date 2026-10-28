#!/usr/bin/env bash
set -euo pipefail

task_source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_source_root"
export MOZBUILD_STATE_PATH="${MOZBUILD_STATE_PATH:-$task_source_root/../build-state}"
export MOZCONFIG="${MOZCONFIG:-$task_source_root/fork/mozconfig.linux}"
export MOZ_SOURCE_CHANGESET="$(git rev-parse HEAD)"
if [[ -z "${MOZ_SOURCE_REPO:-}" ]]; then
  MOZ_SOURCE_REPO="$(git remote get-url origin | python3 -c '
import re, sys
remote = sys.stdin.read().strip()
match = re.search(r"github[.]com[/:]([^/]+/[^/]+?)(?:[.]git)?$", remote)
if not match:
    raise SystemExit("Set MOZ_SOURCE_REPO to the engine source URL")
print("https://github.com/" + match.group(1))
')"
  export MOZ_SOURCE_REPO
fi
if [[ $# == 0 ]]; then
  set -- build
fi
exec ./mach "$@"
