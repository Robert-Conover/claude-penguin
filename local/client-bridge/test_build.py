import importlib.util
from pathlib import Path
import struct
import unittest
import zlib


spec = importlib.util.spec_from_file_location('bridge_build', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def swf(body):
    return b'CWS\x08' + struct.pack('<I', len(body) + 8) + zlib.compress(body)


class OverlayTests(unittest.TestCase):
    def test_preserves_original_tags_and_places_extension_before_first_frame(self):
        # RECT + frame rate/count + existing DoAction + ShowFrame + End.
        # The existing action includes bytes resembling a ShowFrame tag.
        body = b'\x08\x00\x00\x0c\x01\x00' + struct.pack('<H', (12 << 6) | 3) + b'\x40\x00\x00' + b'\x40\x00\x00\x00'
        original = swf(body)
        changed, offset, size = build.overlay(original, b'\x96\x00\x00\x00')
        decoded = zlib.decompress(changed[8:])
        self.assertEqual(decoded[:offset] + decoded[offset + size:], body)
        self.assertEqual(decoded[offset + size:offset + size + 2], b'\x40\x00')
        self.assertEqual(struct.unpack_from('<H', decoded, offset)[0] >> 6, 12)
        self.assertEqual(struct.unpack_from('<I', changed, 4)[0], len(decoded) + 8)
        self.assertEqual(changed[:4], original[:4])

    def test_long_tags_and_later_frames_are_preserved_with_a_large_extension(self):
        # A long-form original tag hides ShowFrame-like bytes; only the first
        # real ShowFrame receives the extension, and later frames stay intact.
        payload = bytes([0x40, 0x00]) * 50
        long_action = struct.pack('<HI', (12 << 6) | 63, len(payload)) + payload
        background = struct.pack('<H', (9 << 6) | 3) + b'\x01\x02\x03'
        frames = b'\x40\x00' + background + b'\x40\x00' + b'\x00\x00'
        body = b'\x08\x00\x00\x0c\x02\x00' + background + long_action + frames
        extension = bytes(range(256)) * 4
        changed, offset, size = build.overlay(swf(body), extension)
        decoded = zlib.decompress(changed[8:])
        self.assertEqual(offset, 6 + len(background) + len(long_action))
        self.assertEqual(size, 6 + len(extension))
        self.assertEqual(decoded[:offset] + decoded[offset + size:], body)
        header, length = struct.unpack_from('<HI', decoded, offset)
        self.assertEqual((header >> 6, header & 63, length), (12, 63, len(extension)))
        self.assertEqual(decoded[offset + 6:offset + size], extension)
        self.assertEqual(decoded[offset + size:], frames)

    def test_rejects_incorrect_declared_length(self):
        original = swf(b'\x08\x00\x00\x0c\x01\x00\x40\x00\x00\x00')
        with self.assertRaisesRegex(ValueError, 'length'):
            build.overlay(original[:4] + b'\x00' * 4 + original[8:], b'\x00')

    def test_rejects_unexpected_swf_format(self):
        with self.assertRaisesRegex(ValueError, 'compressed'):
            build.overlay(b'FWS\x08' + b'\x00' * 10, b'\x00')

    def test_rejects_missing_frame(self):
        with self.assertRaisesRegex(ValueError, 'ShowFrame'):
            build.overlay(swf(b'\x08\x00\x00\x0c\x01\x00\x00\x00'), b'\x00')

    def test_generated_overlay_preserves_all_pinned_engine_bytes(self):
        output = build.OUT / 'engine.swf'
        metadata = build.OUT / 'build.json'
        if not output.exists() or not metadata.exists():
            self.skipTest('Run build.py to validate the generated overlay')
        import json
        record = json.loads(metadata.read_text())
        original = build.checked(build.ROOT / record['source'], build.ENGINE_SHA256)
        changed = output.read_bytes()
        self.assertEqual(build.digest(changed), record['outputSha256'])
        body = zlib.decompress(changed[8:])
        start = record['injectedTagOffset']
        end = start + record['injectedTagBytes']
        self.assertEqual(body[:start] + body[end:], zlib.decompress(original[8:]))


if __name__ == '__main__':
    unittest.main()
