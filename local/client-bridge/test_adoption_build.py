import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load('adoption_build', 'adoption_build.py')
abcfile = build.abcfile

PCODE = '''\
            trait method QName(PrivateNamespace("x:Pen"),"onAdoptClick")
               dispid 0
               method
                  name "x:Pen/onAdoptClick"
                  returns QName(PackageNamespace(""),"void")
                  body
                     maxstack 2
                     localcount 2
                     code
                        getlocal0
                        pushscope
                        returnvoid
                     end ; code
                  end ; body
               end ; method
            trait method QName(PrivateNamespace("x:Pen"),"other")
'''


class AdoptionBuildTests(unittest.TestCase):
    def test_the_stub_abc_is_a_valid_empty_project_class(self):
        parsed = abcfile.parse(build.stub_abc())
        self.assertEqual((parsed['bodyCount'], parsed['methodCount']), (3, 3))
        self.assertEqual(parsed['methods'], {}, 'no trait methods until JPEXS compiles ProjectAdoption.as')
        tag = build.do_abc2(build.stub_abc(), build.STUB_TAG_NAME)
        self.assertEqual(int.from_bytes(tag[:2], 'little') >> 6, abcfile.DO_ABC2)
        self.assertEqual(tag[6:10], b'\x01\x00\x00\x00', 'lazily initialized')

    def test_u30_round_trips(self):
        for value in (0, 1, 127, 128, 16383, 16384, 2 ** 28, 2 ** 30 - 1):
            self.assertEqual(abcfile.Reader(build.u30(value)).u30(), value)

    def test_the_prologue_goes_first_and_the_original_body_is_kept_unchanged(self):
        block = build.method_block(PCODE, 'onAdoptClick')
        self.assertEqual(block[0], 'method')
        self.assertEqual(block[-1], 'end ; method')
        patched = build.with_prologue(block, 'adoptClick')
        code = next(index for index, line in enumerate(patched) if line.strip() == 'code')
        self.assertIn('maxstack 3', '\n'.join(patched), 'the hook needs three stack slots')
        self.assertIn('pushstring "adoptClick"', patched[code + 2])
        self.assertEqual(patched[code + 7], 'cpcontinue:')
        self.assertEqual([line.strip() for line in patched[code + 8:code + 11]], ['getlocal0', 'pushscope', 'returnvoid'])
        with self.assertRaises(ValueError):
            build.method_block(PCODE, 'missing')

    def test_patched_bodies_must_be_the_exact_prologue_followed_by_the_original(self):
        original = bytes([0xD0, 0x30, 0x47])
        prologue = bytes([0x60, 0x05, 0x2C, 0x07, 0xD0, 0x46, 0x09, 0x02, 0x12, 0x01, 0x00, 0x00, 0x47])
        self.assertEqual(len(build.prologue_parts(prologue + original, original)), 6)
        with self.assertRaisesRegex(ValueError, 'original bytecode'):
            build.prologue_parts(prologue + bytes([0xD0, 0x30, 0x48]), original)
        with self.assertRaisesRegex(ValueError, 'unexpected prologue'):
            build.prologue_parts(bytes([0x60, 0x05, 0x2C, 0x07, 0xD0, 0x46, 0x09, 0x01, 0x12, 0x01, 0x00, 0x00, 0x47]) + original, original)
        with self.assertRaises(ValueError):
            build.prologue_parts(bytes([0x24, 0x01]) + original, original)

    def test_the_hooked_methods_are_module_only_void_methods(self):
        self.assertEqual(len({(cls, method) for _, cls, method in build.HOOKS}), len(build.HOOKS))
        self.assertTrue(all(cls.split('.')[0] in ('commands', 'mediators', 'model') for _, cls, _ in build.HOOKS))
        source = build.SOURCE.read_text()
        for hook_id, _, _ in build.HOOKS:
            self.assertIn(f'"{hook_id}"', source, f'ProjectAdoption.as handles {hook_id}')

    def test_generated_module_keeps_every_unpatched_body_and_tag(self):
        out = build.OUT / 'puffle_adoption.swf'
        record_path = build.OUT / 'adoption-build.json'
        if not out.exists() or not record_path.exists():
            self.skipTest('Run python3 local/client-bridge/build.py to build the derived adoption module.')
        record = json.loads(record_path.read_text())
        self.assertEqual(record['extensionSha256'], build.bridge_build.digest(build.SOURCE.read_bytes()),
                         'The derived adoption module is stale; run python3 local/client-bridge/build.py')
        final = out.read_bytes()
        self.assertEqual(build.bridge_build.digest(final), record['outputSha256'])
        original = build.bridge_build.checked(build.ROOT / build.MODULE, build.MODULE_SHA256)
        summary = build.verify(original, final)
        self.assertEqual(summary['patchedBodies'], len(build.HOOKS))
        self.assertEqual(summary['unpatchedBodiesUnchanged'], record['unpatchedBodiesUnchanged'])


if __name__ == '__main__':
    unittest.main()
