"""Tests for the patch generator, audit and Python reference applier. Offline; no media needed."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import random
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


lib = load('patchlib', 'patchlib.py')
generate = load('patch_generate', 'patch_generate.py')
audit = load('patch_audit', 'patch_audit.py')


def tag(code, payload):
    if len(payload) < 63:
        return struct.pack('<H', (code << 6) | len(payload)) + payload
    return struct.pack('<HI', (code << 6) | 63, len(payload)) + payload


def noise(seed, size):
    rng = random.Random(seed)
    return bytes(rng.randrange(256) for _ in range(size))


def swf(body, signature='CWS', version=8):
    return lib.build_swf(signature, version, body)


def fixture(extra=b''):
    """(original body, extended body): a synthetic SWF with a project tag inserted before ShowFrame."""
    head = b'\x08\x00\x00\x0c\x01\x00'          # RECT, frame rate, frame count
    tags = tag(82, noise(1, 3000)) + tag(82, noise(2, 5000)) + tag(12, noise(3, 90))
    original = head + tags + tag(1, b'') + tag(0, b'')
    project = tag(12, b'PROJECT-OWNED-CODE:' + noise(99, 200) + extra)
    changed = head + tags + project + tag(1, b'') + tag(0, b'')
    return original, changed


def make(original_body, changed_body, **kwargs):
    original, changed = swf(original_body), swf(changed_body)
    patch = generate.make_patch(original, changed, target='engine.swf', original_path='media/play/v2/client/engine.swf',
                                record_file='build.json', record={'version': 1, 'originalTagsUnchanged': True}, **kwargs)
    return original, changed, patch


class GeneratorTests(unittest.TestCase):
    def test_round_trip_and_literals_hold_only_project_bytes(self):
        original_body, changed_body = fixture()
        original, changed, patch = make(original_body, changed_body)
        body, rebuilt = lib.apply_patch(original, patch)
        self.assertEqual(body, changed_body)
        self.assertEqual(lib.split_swf(rebuilt)[2], changed_body)
        runs = lib.literal_runs(lib.validate_patch(patch))
        self.assertEqual(len(runs), 1)
        self.assertLessEqual(len(runs[0]), len(changed_body) - len(original_body) + 16)
        self.assertNotIn(runs[0], original_body)
        problems, stats = audit.audit_patch(patch, original, changed, strict=True)
        self.assertEqual(problems, [])
        self.assertEqual(stats['literalBytes'], len(runs[0]))

    def test_any_run_of_k_bytes_found_anywhere_becomes_a_copy(self):
        # The new bytes repeat material from far away in the original, in a different order.
        original_body, _ = fixture()
        piece_a, piece_b = original_body[4000:4300], original_body[500:900]
        changed_body = original_body[:100] + piece_b + b'\xfe' * 7 + piece_a + original_body[100:]
        original, changed, patch = make(original_body, changed_body)
        runs = lib.literal_runs(lib.validate_patch(patch))
        self.assertTrue(all(len(run) <= 16 for run in runs), [len(run) for run in runs])
        self.assertEqual(lib.apply_patch(original, patch)[0], changed_body)
        problems, _ = audit.audit_patch(patch, original, changed, strict=True)
        self.assertEqual(problems, [])

    def test_small_k_and_empty_edge_cases(self):
        original_body, changed_body = fixture()
        for k in (4, 8, 16):
            original, changed, patch = make(original_body, changed_body, k=k)
            self.assertEqual(lib.apply_patch(original, patch)[0], changed_body)
        # Nothing in common: a pure insert. Identical: a single copy.
        _, _, fresh = make(original_body, noise(7, 500))
        self.assertEqual([op[0] for op in fresh['ops']], ['insert'])
        _, _, same = make(original_body, original_body)
        self.assertEqual(len(same['ops']), 1)
        self.assertEqual(same['ops'][0], ['copy', 0, len(original_body)])

    def test_deterministic_across_runs_and_hash_seeds(self):
        original_body, changed_body = fixture()
        texts = {lib.dump_patch(make(original_body, changed_body)[2]) for _ in range(3)}
        self.assertEqual(len(texts), 1)
        script = (
            "import sys, importlib.util\n"
            "sys.path.insert(0, %r)\n"
            "import test_patch as t\n"
            "o, c = t.fixture()\n"
            "sys.stdout.write(t.lib.dump_patch(t.make(o, c)[2]))\n" % str(HERE)
        )
        outputs = set()
        for seed in ('1', '2', '12345'):
            result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True,
                                    env={'PYTHONHASHSEED': seed, 'PATH': '/usr/bin:/bin'})
            self.assertEqual(result.returncode, 0, result.stderr)
            outputs.add(result.stdout)
        self.assertEqual(outputs, texts)

    def test_larger_input_runs_in_reasonable_time(self):
        import time
        rng = random.Random(5)
        original_body = bytes(rng.randrange(256) for _ in range(1_500_000))
        changed_body = original_body[:700_000] + noise(8, 3000) + original_body[700_000:1_200_000] + original_body[:1000] + original_body[1_200_000:]
        started = time.time()
        original, changed, patch = make(original_body, changed_body)
        self.assertLess(time.time() - started, 60)
        self.assertLess(sum(len(r) for r in lib.literal_runs(lib.validate_patch(patch))), 3200)

    def test_uncompressed_swf_round_trip(self):
        original_body, changed_body = fixture()
        original, changed = swf(original_body, 'FWS', 9), swf(changed_body, 'FWS', 9)
        patch = generate.make_patch(original, changed, target='a.swf', original_path='x/a.swf', record_file='a.json')
        self.assertEqual(patch['result']['compression'], 'none')
        self.assertEqual(lib.apply_patch(original, patch)[1], changed)


class AuditTests(unittest.TestCase):
    def test_a_literal_copied_from_the_original_fails(self):
        original_body, changed_body = fixture()
        original, changed, patch = make(original_body, changed_body)
        planted = original_body[1000:1100]
        bad = copy.deepcopy(patch)
        # Replace the first copy that covers the planted range with: copy, literal copy of original bytes, copy.
        position = next(i for i, op in enumerate(bad['ops']) if op[0] == 'copy' and op[1] <= 1000 and op[1] + op[2] >= 1100)
        _, start, length = bad['ops'][position]
        bad['ops'][position:position + 1] = [['copy', start, 1000 - start],
                                             ['insert', base64.b64encode(planted).decode()],
                                             ['copy', 1100, start + length - 1100]]
        bad['ops'] = [op for op in bad['ops'] if not (op[0] == 'copy' and op[2] == 0)]
        problems, _ = audit.audit_patch(bad, original, changed)
        self.assertEqual(len(problems), 1)
        self.assertIn('also occurs in the original', problems[0])

    def test_a_short_original_literal_is_allowed_but_strict_catches_embedded_windows(self):
        original_body, changed_body = fixture()
        original, changed, patch = make(original_body, changed_body)
        short = copy.deepcopy(patch)
        short['ops'][0] = ['copy', 0, 10]
        short['ops'].insert(1, ['insert', base64.b64encode(original_body[10:26]).decode()])
        short['ops'].insert(2, ['copy', 26, patch['ops'][0][2] - 26])
        problems, _ = audit.audit_patch(short, original, changed)
        self.assertEqual(problems, [], '16 bytes is within the allowance')
        run = original_body[10:57] + b'\xff\xfe\xfd'
        mixed_body = original_body[:10] + run + original_body[60:]
        mixed_original, mixed_changed, mixed = make(original_body, mixed_body)
        long_mixed = copy.deepcopy(mixed)
        long_mixed['ops'] = [['copy', 0, 10], ['insert', base64.b64encode(run).decode()], ['copy', 60, len(original_body) - 60]]
        # The 50-byte run as a whole is not in the original, so only --strict notices.
        self.assertEqual(audit.audit_patch(long_mixed, original, mixed_changed)[0], [])
        strict, _ = audit.audit_patch(long_mixed, original, mixed_changed, strict=True)
        self.assertTrue(strict and 'window' in strict[0])

    def test_result_that_differs_from_the_reference_fails(self):
        original_body, changed_body = fixture()
        original, changed, patch = make(original_body, changed_body)
        other = swf(changed_body + b'\x00')
        problems, _ = audit.audit_patch(patch, original, other)
        self.assertTrue(any('differs from the reference' in p for p in problems))

    def test_generate_and_audit_a_whole_set_on_disk(self):
        original_body, changed_body = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            media, reference, sources, out = tmp / 'media', tmp / 'ref', tmp / 'src', tmp / 'patches'
            (media / 'media/play/v2/client').mkdir(parents=True)
            reference.mkdir(); sources.mkdir()
            for target, original_path, ref_name, record_name, extension in generate.PAIRS:
                other_body = original_body + noise(len(target), 700)
                original, result = swf(other_body), swf(other_body[:300] + b'NEW-BYTES-' * 30 + other_body[300:])
                (media / original_path).write_bytes(original)
                (reference / ref_name).write_bytes(result)
                (sources / extension).write_text('source ' + extension)
                (reference / record_name).write_text(json.dumps({
                    'sourceSha256': lib.sha256(original), 'outputSha256': lib.sha256(result),
                    'extensionSha256': lib.sha256(('source ' + extension).encode()), 'originalTagsUnchanged': True}))
            manifest = generate.generate(media, reference, out, sources, log=lambda *_: None)
            problems, report = audit.audit_set(media, reference, out, strict=True, log=lambda *_: None)
            self.assertEqual(problems, [])
            self.assertEqual(report['id'], manifest['id'])
            self.assertEqual(set(report['patches']), {'engine.swf', 'puffle_adoption.swf'})
            self.assertEqual(report['totalLiteralBytes'], sum(p['literalBytes'] for p in report['patches'].values()))
            # A corrupted patch file no longer matches the manifest.
            path = out / 'engine.swf.patch.json'
            path.write_text(path.read_text().replace('"copy"', '"copy" ', 1))
            problems, _ = audit.audit_set(media, reference, out, log=lambda *_: None)
            self.assertTrue(any('manifest hash' in p for p in problems))
            # A stale reference build is rejected by the generator.
            (sources / 'bridge.as').write_text('changed')
            with self.assertRaisesRegex(lib.PatchError, 'stale'):
                generate.generate(media, reference, tmp / 'again', sources, log=lambda *_: None)


class FormatTests(unittest.TestCase):
    def setUp(self):
        self.original_body, self.changed_body = fixture()
        self.original, self.changed, self.patch = make(self.original_body, self.changed_body)

    def assertCode(self, code, call, *args):
        with self.assertRaises(lib.PatchError) as context:
            call(*args)
        self.assertEqual(context.exception.code, code, str(context.exception))

    def test_wrong_original_and_bad_headers(self):
        self.assertCode('ORIGINAL_HASH', lib.apply_patch, self.original + b'x', self.patch)
        bad_length = self.original[:4] + struct.pack('<I', 12345) + self.original[8:]
        self.assertCode('LENGTH', lib.split_swf, bad_length)
        self.assertCode('HEADER', lib.split_swf, b'ZWS' + self.original[3:])
        self.assertCode('HEADER', lib.split_swf, b'CWS\x05' + self.original[4:])

    def test_corrupt_patch_structure(self):
        for mutate in (
            lambda p: p['ops'].append(['copy', 0, 1]),                       # length no longer adds up
            lambda p: p['ops'].__setitem__(0, ['copy', 0, 10 ** 9]),         # outside the original
            lambda p: p['ops'].append(['bogus', 1]),
            lambda p: p['ops'].append(['insert', '!!!']),
            lambda p: p.update(format='other'),
            lambda p: p.update(extra=1),
            lambda p: p.update(target='../evil.swf'),
            lambda p: p['original'].update(path='../../etc/passwd'),
        ):
            bad = copy.deepcopy(self.patch)
            mutate(bad)
            self.assertCode('PATCH', lib.apply_patch, self.original, bad)

    def test_wrong_result_hash(self):
        bad = copy.deepcopy(self.patch)
        bad['result']['decompressedSha256'] = '0' * 64
        self.assertCode('RESULT_HASH', lib.apply_patch, self.original, bad)


if __name__ == '__main__':
    unittest.main()
