import importlib.util
from pathlib import Path
import sys
import types
import unittest


MODULE_PATH = Path(__file__).with_name("verify-turon-damage-med.py")
MED = types.ModuleType("MEDLoader")
sys.modules["MEDLoader"] = MED
SPEC = importlib.util.spec_from_file_location("verify_turon_damage_med", MODULE_PATH)
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class Array:
    def __init__(self, values):
        self.values = values

    def getInfoOnComponents(self):
        return ["V3", "V5"]

    def getValues(self):
        return self.values

    def getNumberOfComponents(self):
        return 2


class Field:
    def __init__(self, values):
        self.values = values

    def getArray(self):
        return Array(self.values)


class TuronDamageMedTests(unittest.TestCase):
    def test_reports_final_interface_damage_and_damage_state(self):
        MED.GetAllFieldNames = lambda _path: ("RESU____VARI_ELGA",)
        MED.GetAllFieldIterations = lambda _path, _field: [(4, 4, 1.0)]
        MED.GetMeshNamesOnField = lambda _path, _field: ("mesh",)
        MED.ReadFieldGauss = lambda *_args: Field([0.7, 1.0, 0.0, 0.0])

        self.assertEqual(VERIFIER.read_damage("result.med"), {
            "instant": 1.0,
            "maxDamageV3": 0.7,
            "maxStateV5": 1.0,
            "damageHistory": [{"order": 4, "time": 1.0, "maxDamageV3": 0.7, "maxStateV5": 1.0}],
        })

    def test_rejects_a_solver_result_without_cohesive_damage(self):
        MED.GetAllFieldNames = lambda _path: ("RESU____VARI_ELGA",)
        MED.GetAllFieldIterations = lambda _path, _field: [(4, 4, 1.0)]
        MED.GetMeshNamesOnField = lambda _path, _field: ("mesh",)
        MED.ReadFieldGauss = lambda *_args: Field([0.0, 0.0])

        with self.assertRaisesRegex(ValueError, "did not reach a damaged state"):
            VERIFIER.read_damage("result.med")


if __name__ == "__main__":
    unittest.main()
