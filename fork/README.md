# Firefox 159 implementation

Mozilla baseline: `FIREFOX_159_0_RELEASE`, commit
`9a2dc53c369c7ae5172018b35988e1d2ffeff402`.

The implementation reproduces the source changes in the published `firefox-53`
engine on Firefox 159's interfaces. Juggler is part of this source tree.
The Python pair is `invisible_core 159.49.0` and
`invisible_playwright 0.43.1.dev0`; the vendored Playwright client remains 1.61.

Build on Linux:

```sh
./fork/build.sh
XZ_OPT=-T0 ./fork/build.sh package
```

The build configuration enables Mozilla's release settings, bundled fonts and
native tests. The packaged binary is
`../build/obj-firefox-stable-159/dist/firefox/firefox`, and the distributable
archive is in the same `dist` directory. Engine updates are supplied through
the fork's releases.
The build entry records the current Git commit in the application metadata.
`scripts/make_seal.py` generates the matching core seal from the built tree or
release archives. Record the engine commit with `--source-commit-file` and use
`browser/config/stealth_playwright_range.txt` for the supported client range.

For a local build, install the paired Python repositories and pass the binary
through `InvisiblePlaywright(binary_path=...)`. The core's packaged local seal
records that build's version and BuildID. Release downloads use the GitHub
`owner/repository` selected by `INVISIBLE_FIREFOX_RELEASE_REPOSITORY`.

## Maintenance

Maintain Firefox 159 on `release/159` in
`idawnlight/firefox_antidetect_patch`. Apply Mozilla 159 point releases and
fork fixes on this branch. Start `release/160` from its Mozilla release tag,
then reproduce the functional commit groups against that version's native
interfaces. Carry shared fixes to each maintained release branch as needed.

`invisible_core` and `invisible_playwright` each use `main`. Their Python API
versions and release cycles are maintained separately from Gecko branches.
The pair above identifies the tested 159 checkpoint. Engine releases use
`firefox-VERSION-rREVISION` tags: `VERSION` is Mozilla's product version, and
`REVISION` increases for fork fixes or packaging changes. Python API releases
have their own versions; publishing an engine does not require publishing
another Python package.

Run the original author tests against an exact core, wrapper and engine
combination, including the native `StealthCanvasProjection` and
`TestStartupCache` tests and Juggler's Node tests. Record the source commit,
BuildID, archive hash and Python versions for each tested combination.

The Linux checkpoint was built from
`358357508394bb2ac288ece425ba2e7e68b94957`, with BuildID `20261029033851`.
Its original author browser suite completed with 407 passed and 3 skipped.

## Prepare and publish a prebuilt release

`fork/releases/firefox-159.0-r1.json` pins the already verified Linux x86_64
package, its SHA256, source commit, BuildID and Mozilla baseline. This release
contains only that platform. Add separate verified platform support before
claiming another platform.

Prepare the distributable from the existing package without rebuilding or
starting Firefox:

```sh
python3 fork/release.py prepare --tag firefox-159.0-r1 \
  --package ../build/obj-firefox-stable-159/dist/firefox-159.0.en-US.linux-x86_64.tar.xz \
  --out ../build/releases/firefox-159.0-r1
cd ../build/releases/firefox-159.0-r1
sha256sum --check SHA256SUMS
```

The output directory must not already exist. Preparation verifies the pinned
input checksum, both INI identities and the executable's architecture. It
removes the Mozilla archive's outer `firefox/` directory, normalizes archive
metadata and compression timestamps, and preserves every file's bytes. The
flat `.tar.gz` layout matches the core downloader's `entry_rel=firefox`.
Repeated preparation with the same input and tool/runtime produces identical
assets.

The generated `seal.json` has the downloadable archive's SHA256, size,
per-platform BuildID, omni.ja hash and supported Playwright range.
`provenance.json` records the original package, packaging-tool hashes and every
payload file hash; `release-manifest.json` copies the committed release plan.
`SHA256SUMS` covers the archive and all accompanying release files. The source
commit in the package, seal and provenance stays the tested engine commit even
when the release tag points to a later commit adding packaging tools.

After the packaging changes and manifest are committed and pushed, create and
push the release tag using the chosen packaging commit, then publish the
prepared files from the native repository checkout:

```sh
git tag firefox-159.0-r1
git push origin firefox-159.0-r1
gh release create firefox-159.0-r1 \
  --repo idawnlight/firefox_antidetect_patch --verify-tag \
  --title 'Firefox 159.0 r1' \
  --notes-file ../build/releases/firefox-159.0-r1/RELEASE_NOTES.md \
  ../build/releases/firefox-159.0-r1/*
```

The `gh` command uses the operator's existing GitHub authentication. These
commands do not overwrite existing release assets. Give `seal.json` to the
core repository when selecting this engine as its default download; the
Python package's own version remains independent.

## Optional CI import

`.github/workflows/fork-release.yml` runs for explicit fork release tags and
manual dispatches. It only repacks prebuilt archives. It never builds or runs
Firefox. With no `input.url` in the committed manifest, a tag push reports
local upload mode and leaves publication to the commands above.

For a future CI import, set `input.url` to an HTTPS archive location in the
committed manifest, retaining its expected SHA256. A manual dispatch can also
supply an HTTPS `archive_url`; the committed expected checksum still applies.
The workflow downloads that input, verifies it, prepares all release files,
retains a CI artifact and creates the GitHub Release with `GITHUB_TOKEN`.
The release tag must already exist, and an existing release is not clobbered.

Release-tool checks use only synthetic packages and static archive inspection:

```sh
python3 -m unittest discover -s fork/tests -v
python3 scripts/test_make_seal.py
```
