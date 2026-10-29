import copy
import importlib.util
import io
import json
import struct
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("fork_release", Path(__file__).parents[1] / "release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest, self.manifest_path = release.load_manifest("firefox-159.0-r1")
        self.binary = bytearray(20)
        self.binary[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", self.binary, 18, 62)
        omni = io.BytesIO()
        with zipfile.ZipFile(omni, "w") as archive:
            for name in release.make_seal.JUGGLER_ENTRIES:
                archive.writestr(name, b"zoom.stealth")
        identity = (f"BuildID={self.manifest['build_id']}\n"
                    f"SourceStamp={self.manifest['source_commit']}\n"
                    f"SourceRepository=https://github.com/{self.manifest['repository']}\n")
        self.files = {
            "firefox": bytes(self.binary), "libxul.so": b"library",
            "dependentlibs.list": b"libxul.so\n", "omni.ja": omni.getvalue(),
            "application.ini": ("[App]\nVersion=159.0\n" + identity).encode(),
            "platform.ini": ("[Build]\nMilestone=159.0\n" + identity).encode(),
            "browser/data/file": b"unchanged payload",
        }

    def package(self, files=None, extra=None):
        package = self.root / "input.tar.xz"
        with tarfile.open(package, "w:xz") as archive:
            root = tarfile.TarInfo("firefox")
            root.type = tarfile.DIRTYPE
            archive.addfile(root)
            for relative, content in (files or self.files).items():
                member = tarfile.TarInfo("firefox/" + relative)
                member.size = len(content)
                member.mtime = 123456
                member.uid = 1001
                member.uname = "builder"
                member.mode = 0o755 if relative == "firefox" else 0o644
                archive.addfile(member, io.BytesIO(content))
            if extra is not None:
                archive.addfile(extra)
        self.manifest["input"]["sha256"] = release.make_seal.sha256_path(package)
        return package

    def test_prepare_preserves_payload_and_is_deterministic(self):
        package = self.package()
        first, second = self.root / "first", self.root / "second"
        release.prepare(self.manifest, self.manifest_path, package, first)
        release.prepare(self.manifest, self.manifest_path, package, second)
        for path in first.iterdir():
            self.assertEqual(path.read_bytes(), (second / path.name).read_bytes())
        archive_name = "firefox-159.0-stealth-linux-x86_64.tar.gz"
        with tarfile.open(first / archive_name, "r:gz") as archive:
            entries = {member.name: archive.extractfile(member).read()
                       for member in archive if member.isfile()}
            self.assertEqual(entries, self.files)
            for member in archive.getmembers():
                self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
        seal = json.loads((first / "seal.json").read_text())
        self.assertEqual(seal["source_commit"], self.manifest["source_commit"])
        self.assertEqual(seal["assets"][archive_name]["build_id"], self.manifest["build_id"])
        self.assertEqual(seal["assets"][archive_name]["entry_rel"], "firefox")
        provenance = json.loads((first / "provenance.json").read_text())
        for relative, content in self.files.items():
            self.assertEqual(provenance["repack"]["payload_sha256"][relative],
                             release.hashlib.sha256(content).hexdigest())
        for line in (first / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(digest, release.make_seal.sha256_path(first / name))

    def test_wrong_input_hash_creates_no_output(self):
        package = self.package()
        self.manifest["input"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(release.ReleaseError, "SHA256 mismatch"):
            release.prepare(self.manifest, self.manifest_path, package, self.root / "out")
        self.assertFalse((self.root / "out").exists())

    def test_wrong_source_stamp_creates_no_output(self):
        files = self.files.copy()
        files["platform.ini"] = files["platform.ini"].replace(
            self.manifest["source_commit"].encode(), b"a" * 40)
        package = self.package(files)
        with self.assertRaisesRegex(release.ReleaseError, "SourceStamp mismatch"):
            release.prepare(self.manifest, self.manifest_path, package, self.root / "out")
        self.assertFalse((self.root / "out").exists())

    def test_stock_omni_is_not_sealed(self):
        files = self.files.copy()
        omni = io.BytesIO()
        with zipfile.ZipFile(omni, "w") as archive:
            archive.writestr("modules/stock.js", b"stock")
        files["omni.ja"] = omni.getvalue()
        package = self.package(files)
        with self.assertRaises(release.make_seal.SealBuildError):
            release.prepare(self.manifest, self.manifest_path, package, self.root / "out")
        self.assertFalse((self.root / "out").exists())

    def test_path_escape_and_links_are_rejected(self):
        for name, kind in (("firefox/../escape", tarfile.REGTYPE),
                           ("/absolute", tarfile.REGTYPE),
                           ("firefox/link", tarfile.SYMTYPE)):
            with self.subTest(name=name):
                extra = tarfile.TarInfo(name)
                extra.type = kind
                extra.linkname = "../../escape"
                package = self.package(extra=extra)
                tree = self.root / "tree"
                tree.mkdir(exist_ok=True)
                with tempfile.TemporaryDirectory(dir=self.root) as temporary:
                    with self.assertRaises(release.ReleaseError):
                        release.unpack(package, Path(temporary))

    def test_new_tag_matches_product_and_legacy_tags_work(self):
        tree = self.root / "tree"
        tree.mkdir()
        release.unpack(self.package(), tree)
        assets = self.root / "assets"
        assets.mkdir()
        release.repack(tree, assets / "firefox-159.0-stealth-linux-x86_64.tar.gz")
        for tag in ("firefox-53", "firefox-159.0-r1"):
            seal, _ = release.make_seal.build_from_assets(tag, assets, "a" * 40,
                                                         "1.55.0", "1.61.0", True)
            self.assertEqual(seal["tag"], tag)
        with self.assertRaisesRegex(release.make_seal.SealBuildError, "tag/base mismatch"):
            release.make_seal.build_from_assets("firefox-160.0-r1", assets, "a" * 40,
                                                 "1.55.0", "1.61.0", True)

    def test_manifest_validation_and_optional_import_plan(self):
        self.assertEqual(release.main(["plan", "--tag", self.manifest["tag"]]), 0)
        for change in ({"tag": "firefox-160.0-r1"}, {"source_commit": "short"},
                       {"platform": "win32"}, {"fork_revision": 2},
                       {"input": {"filename": "../package.tar.xz", "sha256": "0" * 64}}):
            data = copy.deepcopy(self.manifest)
            data.update(change)
            with self.subTest(change=change), patch.object(Path, "read_text", return_value=json.dumps(data)):
                with self.assertRaises(release.ReleaseError):
                    release.load_manifest(self.manifest["tag"])
        with self.assertRaises(release.ReleaseError):
            release.https_url("http://example.test/package.tar.xz")


if __name__ == "__main__":
    unittest.main()
