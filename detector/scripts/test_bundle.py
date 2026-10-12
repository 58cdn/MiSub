"""Offline archive validation fixtures; no upstream requests or executable launch."""
import hashlib
import io
import stat
import struct
import unittest
import zipfile

from bundle import verify_asset


def fixture(executable=None, name="mihomo-fixture.exe", mode=stat.S_IFREG | 0o600, extra=False):
    if executable is None:
        executable = bytearray(512)
        executable[:2] = b"MZ"
        struct.pack_into("<I", executable, 60, 128)
        executable[128:132] = b"PE\x00\x00"
        struct.pack_into("<H", executable, 132, 0x8664)
        struct.pack_into("<H", executable, 150, 0x22)
        struct.pack_into("<H", executable, 152, 0x20b)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        info = zipfile.ZipInfo(name)
        info.external_attr = mode << 16
        archive.writestr(info, executable)
        if extra:
            archive.writestr("extra.txt", "unexpected")
    payload = stream.getvalue()
    return payload, {"file": "mihomo-fixture.zip", "sha256": hashlib.sha256(payload).hexdigest(), "entry": "mihomo-fixture.exe", "executableBytes": len(executable), "executableSha256": hashlib.sha256(executable).hexdigest()}


class BundleTests(unittest.TestCase):
    def test_valid_windows_pe(self):
        verify_asset(*fixture())

    def test_archive_paths_types_and_extra_entries(self):
        for options in ({"name": "../mihomo-fixture.exe"}, {"name": "C:/mihomo-fixture.exe"}, {"mode": stat.S_IFLNK | 0o777}, {"extra": True}, {"executable": b"not PE"}):
            with self.subTest(options=options), self.assertRaises((RuntimeError, zipfile.BadZipFile)):
                verify_asset(*fixture(**options))

    def test_both_hashes_and_size(self):
        for key, value in (("sha256", "0" * 64), ("executableSha256", "0" * 64), ("executableBytes", 0), ("executableBytes", 513), ("executableBytes", 129 * 1024 * 1024)):
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                payload, asset = fixture()
                asset[key] = value
                verify_asset(payload, asset)

    def test_gzip_hash_compatibility(self):
        payload = b"gzip hash fixture"
        verify_asset(payload, {"file": "mihomo-fixture.gz", "sha256": hashlib.sha256(payload).hexdigest()})


if __name__ == "__main__":
    unittest.main()
