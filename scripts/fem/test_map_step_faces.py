import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("map-step-faces.py")
SPEC = importlib.util.spec_from_file_location("map_step_faces", MODULE_PATH)
MAPPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MAPPER)


class EquivalentLoadTests(unittest.TestCase):
    def test_point_force_barycentric_weights_preserve_force_and_moment(self):
        triangle = [[0.0, 0.0, 2.0], [4.0, 0.0, 2.0], [0.0, 3.0, 2.0]]
        point = [1.0, 1.0, 2.0]
        force = [10.0, -20.0, 30.0]
        weights, distance = MAPPER.triangle_barycentric(point, triangle)
        self.assertLessEqual(distance, 1e-12)
        self.assertAlmostEqual(sum(weights), 1.0)

        nodal_forces = [[weight * component for component in force] for weight in weights]
        total_force = [sum(row[axis] for row in nodal_forces) for axis in range(3)]
        total_moment = [
            sum(MAPPER.cross3(triangle[index], nodal_forces[index])[axis] for index in range(3))
            for axis in range(3)
        ]
        self.assertEqual(total_force, force)
        for actual, expected in zip(total_moment, MAPPER.cross3(point, force)):
            self.assertAlmostEqual(actual, expected, places=12)

    def test_equivalent_nodal_couple_preserves_zero_force_and_all_moment_axes(self):
        node_xyz = {
            1: [0.0, 0.0, 0.0],
            2: [4.0, 0.0, 0.0],
            3: [4.0, 3.0, 0.0],
            4: [0.0, 3.0, 0.0],
            5: [1.0, 1.0, 0.0],
        }
        requested_moment = [17.0, -23.0, 41.0]
        forces = MAPPER.equivalent_couple_forces(list(node_xyz), node_xyz, requested_moment)
        total_force = [sum(force[axis] for force in forces.values()) for axis in range(3)]
        total_moment = [
            sum(MAPPER.cross3(node_xyz[node], force)[axis] for node, force in forces.items())
            for axis in range(3)
        ]
        for actual in total_force:
            self.assertAlmostEqual(actual, 0.0, places=12)
        for actual, expected in zip(total_moment, requested_moment):
            self.assertAlmostEqual(actual, expected, places=12)


class CodeAsterPhysicalGroupTests(unittest.TestCase):
    def test_assigns_volume_and_selected_face_groups_with_stable_names(self):
        class FakeModel:
            def __init__(self):
                self.groups = []
                self.names = []

            def addPhysicalGroup(self, dimension, entities, tag):
                self.groups.append((dimension, entities, tag))
                return tag

            def setPhysicalName(self, dimension, tag, name):
                self.names.append((dimension, tag, name))

        class FakeGmsh:
            def __init__(self):
                self.model = FakeModel()

        gmsh = FakeGmsh()
        groups = MAPPER.assign_code_aster_physical_groups(
            gmsh,
            volume_tag=7,
            mappings=[
                {"faceId": "native-a", "surfaceEntityTag": 11},
                {"faceId": "native-b", "surfaceEntityTag": 12},
            ],
            requested_face_ids=["native-b", "native-a"],
        )

        self.assertEqual(groups, [
            {"dimension": 3, "tag": 1, "name": "GM1", "faceId": None},
            {"dimension": 2, "tag": 1001, "name": "GM1001", "faceId": "native-b"},
            {"dimension": 2, "tag": 1002, "name": "GM1002", "faceId": "native-a"},
        ])
        self.assertEqual(gmsh.model.groups, [(3, [7], 1), (2, [12], 1001), (2, [11], 1002)])
        self.assertEqual(gmsh.model.names, [(3, 1, "GM1"), (2, 1001, "GM1001"), (2, 1002, "GM1002")])

    def test_rejects_a_selected_face_without_a_verified_step_mapping(self):
        class FakeModel:
            def addPhysicalGroup(self, dimension, entities, tag):
                return tag

            def setPhysicalName(self, dimension, tag, name):
                pass

        class FakeGmsh:
            model = FakeModel()

        with self.assertRaisesRegex(ValueError, "no exact STEP mapping"):
            MAPPER.assign_code_aster_physical_groups(
                FakeGmsh(), 7, [{"faceId": "known", "surfaceEntityTag": 11}], ["missing"]
            )


class FragmentedFaceMappingTests(unittest.TestCase):
    def test_layer_fragmentation_accepts_the_shared_interface_limit(self):
        too_many_planes = [
            {"pointMm": [0.0, 0.0, float(index + 1)], "normalGlobal": [0.0, 0.0, 1.0]}
            for index in range(MAPPER.MAX_LAYER_INTERFACE_PLANES + 1)
        ]
        with self.assertRaisesRegex(ValueError, "1..255 planes"):
            MAPPER.fragment_volume_into_layer_regions(None, 1, [], too_many_planes, 0.001)

    def test_maps_all_exact_coplanar_fragments_of_a_selected_native_face(self):
        face = {
            "faceId": "side", "center": [5.0, 0.0, 2.0], "normal": [0.0, -1.0, 0.0],
            "min": [0.0, 0.0, 0.0], "max": [10.0, 0.0, 4.0], "areaMm2": 40.0,
        }
        surfaces = [
            {"entityTag": 11, "center": [5.0, 0.0, 1.0], "normal": [0.0, -1.0, 0.0], "min": [0.0, 0.0, 0.0], "max": [10.0, 0.0, 2.0], "areaMm2": 20.0},
            {"entityTag": 12, "center": [5.0, 0.0, 3.0], "normal": [0.0, -1.0, 0.0], "min": [0.0, 0.0, 2.0], "max": [10.0, 0.0, 4.0], "areaMm2": 20.0},
            {"entityTag": 13, "center": [15.0, 0.0, 2.0], "normal": [0.0, -1.0, 0.0], "min": [10.0, 0.0, 0.0], "max": [20.0, 0.0, 4.0], "areaMm2": 40.0},
            {"entityTag": 14, "center": [5.0, 0.0, 2.0], "normal": [0.0, 1.0, 0.0], "min": [0.0, 0.0, 0.0], "max": [10.0, 0.0, 4.0], "areaMm2": 40.0},
        ]
        self.assertEqual(MAPPER.match_fragmented_face_surfaces(face, surfaces, 1e-4), [11, 12])

    def test_rejects_incomplete_or_overlapping_fragment_area(self):
        face = {
            "faceId": "side", "center": [5.0, 0.0, 2.0], "normal": [0.0, -1.0, 0.0],
            "min": [0.0, 0.0, 0.0], "max": [10.0, 0.0, 4.0], "areaMm2": 40.0,
        }
        half = {"entityTag": 11, "center": [5.0, 0.0, 1.0], "normal": [0.0, -1.0, 0.0], "min": [0.0, 0.0, 0.0], "max": [10.0, 0.0, 2.0], "areaMm2": 20.0}
        with self.assertRaisesRegex(ValueError, "area does not cover"):
            MAPPER.match_fragmented_face_surfaces(face, [half], 1e-4)
        with self.assertRaisesRegex(ValueError, "area does not cover"):
            MAPPER.match_fragmented_face_surfaces(face, [half, {**half, "entityTag": 12}], 1e-4)


if __name__ == "__main__":
    unittest.main()
