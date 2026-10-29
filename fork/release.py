#!/usr/bin/env python3
"""Prepare verified, reproducible release assets without rebuilding Firefox."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import struct
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import make_seal

TAG_RE = re.compile(r"firefox-(\d+\.\d+(?:\.\d+)?)-r([1-9]\d*)")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
SHA_RE = re.compile(r"[0-9a-f]{64}")


class ReleaseError(RuntimeError):
    pass


def canonical(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n",
                    encoding="utf-8")


def https_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ReleaseError("archive URL must be HTTPS without embedded credentials")
    return value


def load_manifest(tag: str) -> tuple[dict, Path]:
    match = TAG_RE.fullmatch(tag)
    if not match:
        raise ReleaseError("tag must look like firefox-VERSION-rREVISION")
    path = ROOT / "fork" / "releases" / f"{tag}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != 1 or data.get("tag") != tag:
        raise ReleaseError("manifest schema/tag mismatch")
    if (data.get("upstream_version"), data.get("fork_revision")) != (
            match.group(1), int(match.group(2))):
        raise ReleaseError("manifest product version/revision does not match tag")
    for label, value in (("source_commit", data.get("source_commit")),
                         ("mozilla.commit", data.get("mozilla", {}).get("commit"))):
        if not isinstance(value, str) or not COMMIT_RE.fullmatch(value):
            raise ReleaseError(f"{label} must be a full 40-hex commit")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", data.get("repository", "")):
        raise ReleaseError("invalid repository")
    if (data.get("platform"), data.get("arch")) != ("linux", "x86_64"):
        raise ReleaseError("only the verified Linux x86_64 platform is supported")
    if not re.fullmatch(r"\d{14}", data.get("build_id", "")):
        raise ReleaseError("build_id must contain 14 digits")
    source = data.get("input", {})
    if not SHA_RE.fullmatch(source.get("sha256", "")):
        raise ReleaseError("input.sha256 must be a pinned SHA256")
    filename = source.get("filename", "")
    if not filename or Path(filename).name != filename or not filename.endswith(".tar.xz"):
        raise ReleaseError("input.filename must be a tar.xz basename")
    if source.get("url") is not None:
        https_url(source["url"])
    return data, path


def unpack(package: Path, tree: Path) -> dict[str, str]:
    inventory = {}
    seen = set()
    with tarfile.open(package, "r|xz") as archive:
        for member in archive:
            raw = member.name
            while raw.startswith("./"):
                raw = raw[2:]
            parts = PurePosixPath(raw).parts
            if not parts or parts[0] != "firefox" or ".." in parts or "\\" in raw:
                raise ReleaseError(f"invalid package path: {member.name!r}")
            if len(parts) == 1:
                if not member.isdir():
                    raise ReleaseError("package root must be a directory")
                continue
            relative = PurePosixPath(*parts[1:]).as_posix()
            if relative in seen:
                raise ReleaseError(f"duplicate package path: {relative}")
            seen.add(relative)
            destination = tree / relative
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                destination.chmod(0o755)
            elif member.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                reader = archive.extractfile(member)
                digest = hashlib.sha256()
                with destination.open("xb") as output:
                    for chunk in iter(lambda: reader.read(1 << 20), b""):
                        digest.update(chunk)
                        output.write(chunk)
                destination.chmod(0o755 if member.mode & 0o111 else 0o644)
                inventory[relative] = digest.hexdigest()
            else:
                raise ReleaseError(f"unsupported package member: {member.name!r}")
    return inventory


def verify_tree(tree: Path, manifest: dict) -> None:
    for relative in ("firefox", "libxul.so", "omni.ja", "dependentlibs.list",
                     "application.ini", "platform.ini"):
        if not (tree / relative).is_file():
            raise ReleaseError(f"missing package file: {relative}")
    expected_repository = "https://github.com/" + manifest["repository"]
    for filename, section, version_key in (("application.ini", "App", "Version"),
                                           ("platform.ini", "Build", "Milestone")):
        data = make_seal._parse_ini((tree / filename).read_text(encoding="utf-8"))[section]
        expected = {version_key: manifest["upstream_version"],
                    "BuildID": manifest["build_id"],
                    "SourceStamp": manifest["source_commit"],
                    "SourceRepository": expected_repository}
        for key, value in expected.items():
            if data.get(key) != value:
                raise ReleaseError(f"{filename}: {key} mismatch: {data.get(key)!r} != {value!r}")
    with (tree / "firefox").open("rb") as binary:
        header = binary.read(20)
    if (len(header) != 20 or header[:6] != b"\x7fELF\x02\x01" or
            struct.unpack_from("<H", header, 18)[0] != 62):
        raise ReleaseError("firefox is not a Linux x86_64 ELF executable")
    if not (tree / "firefox").stat().st_mode & 0o111:
        raise ReleaseError("firefox lacks its executable mode")


def repack(tree: Path, output: Path) -> None:
    with output.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0,
                           compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.GNU_FORMAT) as archive:
                for path in sorted(tree.rglob("*"), key=lambda p: p.relative_to(tree).as_posix()):
                    info = tarfile.TarInfo(path.relative_to(tree).as_posix())
                    info.mode = 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644
                    if path.is_dir():
                        info.type = tarfile.DIRTYPE
                        archive.addfile(info)
                    else:
                        info.size = path.stat().st_size
                        with path.open("rb") as source:
                            archive.addfile(info, source)


def download(url: str, output: Path) -> None:
    with urllib.request.urlopen(https_url(url), timeout=120) as response:
        https_url(response.geturl())
        with output.open("xb") as destination:
            shutil.copyfileobj(response, destination)


def prepare(manifest: dict, manifest_path: Path, package: Path | None,
            output: Path, archive_url: str | None = None) -> None:
    if output.exists():
        raise ReleaseError(f"output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".release-", dir=output.parent) as temporary:
        work = Path(temporary)
        if package is None:
            url = archive_url or manifest["input"].get("url")
            if not url:
                raise ReleaseError("supply --package locally or an HTTPS --archive-url")
            package = work / manifest["input"]["filename"]
            download(url, package)
        actual_hash = make_seal.sha256_path(package)
        if actual_hash != manifest["input"]["sha256"]:
            raise ReleaseError(f"input SHA256 mismatch: {actual_hash}")
        tree = work / "tree"
        tree.mkdir()
        inventory = unpack(package, tree)
        verify_tree(tree, manifest)
        assets = work / "assets"
        assets.mkdir()
        asset_name = f"firefox-{manifest['upstream_version']}-stealth-linux-x86_64.tar.gz"
        repack(tree, assets / asset_name)
        lo, hi = make_seal.read_playwright_range(ROOT / make_seal.PW_RANGE_REL)
        seal, rows = make_seal.build_from_assets(
            manifest["tag"], assets, manifest["source_commit"], lo, hi, allow_partial=True)
        if rows[0]["build_id"] != manifest["build_id"]:
            raise ReleaseError("repacked archive BuildID changed")
        make_seal.dump_canonical(seal, assets / "seal.json", rows)
        canonical(assets / "release-manifest.json", manifest)
        canonical(assets / "provenance.json", {
            "schema": 1, "tag": manifest["tag"],
            "upstream_version": manifest["upstream_version"],
            "fork_revision": manifest["fork_revision"],
            "source_commit": manifest["source_commit"], "build_id": manifest["build_id"],
            "repository": manifest["repository"], "mozilla": manifest["mozilla"],
            "platform": manifest["platform"], "arch": manifest["arch"],
            "input": {"filename": manifest["input"]["filename"],
                      "sha256": actual_hash, "size": package.stat().st_size},
            "asset": {"filename": asset_name, **seal["assets"][asset_name]},
            "repack": {"format": "tar.gz", "outer_directory_removed": "firefox/",
                       "mtime": 0, "uid": 0, "gid": 0,
                       "python": sys.version.split()[0], "payload_sha256": inventory},
            "tools_sha256": {str(path.relative_to(ROOT)): make_seal.sha256_path(path)
                             for path in (Path(__file__).resolve(), ROOT / "scripts/make_seal.py",
                                          manifest_path)},
        })
        notes = (f"Firefox {manifest['upstream_version']}, fork revision {manifest['fork_revision']}.\n\n"
                 f"- Platform: Linux x86_64.\n"
                 f"- Engine source: `{manifest['source_commit']}`.\n"
                 f"- BuildID: `{manifest['build_id']}`.\n"
                 f"- Mozilla baseline: `{manifest['mozilla']['tag']}` "
                 f"(`{manifest['mozilla']['commit']}`).\n\n"
                 "The verified Mozilla package was repacked with its outer `firefox/` directory "
                 "removed. File contents, including binary SourceStamp, are unchanged. "
                 "The release tag can point to a later packaging-tools commit.\n\n"
                 "`seal.json` pins the downloadable archive and its supported Playwright range. "
                 "`provenance.json` records the input package and every payload file hash. "
                 "Engine releases and Python package versions are independent.\n")
        (assets / "RELEASE_NOTES.md").write_text(notes, encoding="utf-8")
        checksums = "".join(f"{make_seal.sha256_path(path)}  {path.name}\n"
                            for path in sorted(assets.iterdir()))
        (assets / "SHA256SUMS").write_text(checksums, encoding="utf-8")
        assets.rename(output)
    print(f"release assets: {output}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "prepare"):
        command = commands.add_parser(name)
        command.add_argument("--tag", required=True)
        command.add_argument("--archive-url")
        if name == "plan":
            command.add_argument("--github-output", type=Path)
        else:
            command.add_argument("--package", type=Path)
            command.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        manifest, path = load_manifest(args.tag)
        if args.archive_url:
            https_url(args.archive_url)
        if args.command == "plan":
            ready = bool(args.archive_url or manifest["input"].get("url"))
            print(json.dumps({"tag": args.tag, "ready": ready,
                              "mode": "https-import" if ready else "local-upload"}))
            if args.github_output:
                with args.github_output.open("a", encoding="utf-8") as destination:
                    destination.write(f"ready={str(ready).lower()}\ntag={args.tag}\n")
            if not ready:
                print("No pinned input URL: prepare locally, then upload with gh release create.")
        else:
            prepare(manifest, path, args.package, args.out, args.archive_url)
    except (ReleaseError, make_seal.SealBuildError, OSError, ValueError,
            KeyError, tarfile.TarError) as error:
        print(f"RELEASE ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
