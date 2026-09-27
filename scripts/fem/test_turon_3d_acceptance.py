import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("turon-3d-acceptance.py")
SPEC = importlib.util.spec_from_file_location("turon_3d_acceptance", MODULE_PATH)
TURON_ACCEPTANCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TURON_ACCEPTANCE)


class Turon3DAcceptanceTests(unittest.TestCase):
    def test_builds_a_conforming_two_material_mesh_with_linear_3d_joint_elements(self):
        mesh_text, summary = TURON_ACCEPTANCE.build_test_mesh()
        parsed = TURON_ACCEPTANCE._load_cohesive_mesh_helper().parse_msh22(mesh_text)
        penta6 = [element for element in parsed["elements"] if element[1] == 6]

        self.assertEqual(summary["materialATetrahedronCount"], 48)
        self.assertEqual(summary["materialBTetrahedronCount"], 48)
        self.assertEqual(summary["interfaceTriangleCount"], 8)
        self.assertEqual(summary["cohesiveElementCount"], 8)
        self.assertEqual(len(penta6), 8)
        self.assertEqual({element[2][0] for element in penta6}, {6})
        self.assertEqual({name for _dimension, _tag, name in parsed["physicalNames"]}, {"GM1", "GM2", "GM4", "GM5", "GM6"})

    def test_writes_a_non_overwriting_conforming_cohesive_mesh(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = TURON_ACCEPTANCE.write_acceptance_case(directory)
            mesh = (Path(directory) / "cohesive.msh").read_text(encoding="utf-8")
            self.assertEqual(summary["cohesiveElementCount"], 8)
            self.assertIn('3 6 "GM6"', mesh)
            self.assertFalse((Path(directory) / "turon3d.comm").exists())
            with self.assertRaises(FileExistsError):
                TURON_ACCEPTANCE.write_acceptance_case(directory)


if __name__ == "__main__":
    unittest.main()
