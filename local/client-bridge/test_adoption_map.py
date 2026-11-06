import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location('adoption_map', Path(__file__).with_name('adoption_map.py'))
adoption_map = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adoption_map)

PCODE = '''\
   trait method QName(PackageNamespace(""),"adoptPuffle")
      method
         body
            maxstack 2
            code
               getlocal0
               newfunction 3533
            end ; code
         end ; body
      end ; method
   trait getter QName(PrivateNamespace("x:Y"),"adoptPuffle")
      method
         body
            code
               returnvoid
            end ; code
         end ; body
      end ; method
'''


class AdoptionMapTests(unittest.TestCase):
    def test_reads_each_trait_body_and_normalizes_closure_indices(self):
        found = list(adoption_map.bodies(PCODE))
        self.assertEqual([(kind, name) for kind, name, _ in found],
                         [('method', 'adoptPuffle'), ('getter', 'adoptPuffle')])
        self.assertIn('newfunction <closure>', found[0][2])
        self.assertNotIn('end ; body', found[0][2])
        renumbered = list(adoption_map.bodies(PCODE.replace('3533', '3487')))
        self.assertEqual(found, renumbered)

    def test_body_change_changes_hash_input(self):
        changed = list(adoption_map.bodies(PCODE.replace('getlocal0', 'getlocal1')))
        self.assertNotEqual(list(adoption_map.bodies(PCODE))[0][2], changed[0][2])

    def test_mapped_methods_are_unique_and_module_only(self):
        keys = [(cls, kind, name) for _, cls, kind, name, _ in adoption_map.METHODS]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(adoption_map.PKG.startswith('com.clubpenguin.puffles.adoption.'))


if __name__ == '__main__':
    unittest.main()
