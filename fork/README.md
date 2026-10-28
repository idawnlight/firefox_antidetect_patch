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

Keep the stable implementation on `reproduce/firefox-159` while verifying it.
For each new Mozilla release, start from its release tag, retain the functional
commit groups and adapt their native entry points. Run the original author
tests against the paired core, wrapper and engine, including the native
`StealthCanvasProjection` and `TestStartupCache` tests and Juggler's Node tests.
