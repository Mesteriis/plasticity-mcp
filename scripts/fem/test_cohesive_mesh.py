import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("cohesive-mesh.py")
SPEC = importlib.util.spec_from_file_location("cohesive_mesh", MODULE_PATH)
COHESIVE_MESH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COHESIVE_MESH)


MESH = '''$MeshFormat
2.2 0 8
$EndMeshFormat
$PhysicalNames
5
2 3 "INTERFACE"
2 4 "B_OUTER"
2 5 "A_OUTER"
3 1 "MATERIAL_A"
3 2 "MATERIAL_B"
$EndPhysicalNames
$Nodes
5
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
5 0 0 -1
$EndNodes
$Elements
5
1 4 2 1 1 1 2 3 4
2 4 2 2 2 1 3 2 5
3 2 2 3 3 1 2 3
4 2 2 4 4 1 2 5
5 2 2 5 5 1 2 4
$EndElements
'''


LAYER_STACK_MESH = '''$MeshFormat
2.2 0 8
$EndMeshFormat
$PhysicalNames
5
2 3 "INTERFACE_1"
2 4 "INTERFACE_2"
2 5 "MIDDLE_OUTER"
3 1 "MATERIAL_A"
3 2 "MATERIAL_B"
$EndPhysicalNames
$Nodes
11
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
5 1 0 1
6 0 1 1
7 0 0 2
8 1 0 2
9 0 1 2
10 0.25 0.25 -1
11 0.25 0.25 3
$EndNodes
$Elements
7
1 4 2 1 1 1 3 2 10
2 4 2 2 2 1 2 3 4
3 4 2 2 2 2 3 4 5
4 4 2 2 2 3 4 5 6
5 4 2 1 1 4 5 6 11
6 2 2 3 3 1 2 3
7 2 2 4 4 4 5 6
$EndElements
'''


LAYER_REGION_MESH = '''$MeshFormat
2.2 0 8
$EndMeshFormat
$PhysicalNames
6
2 21 "INTERFACE_1"
2 22 "INTERFACE_2"
2 5 "MIDDLE_OUTER"
3 11 "LAYER_1"
3 12 "LAYER_2"
3 13 "LAYER_3"
$EndPhysicalNames
$Nodes
11
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
5 1 0 1
6 0 1 1
7 0 0 2
8 1 0 2
9 0 1 2
10 0.25 0.25 -1
11 0.25 0.25 3
$EndNodes
$Elements
7
1 4 2 11 11 1 3 2 10
2 4 2 12 12 1 2 3 4
3 4 2 12 12 2 3 4 5
4 4 2 12 12 3 4 5 6
5 4 2 13 13 4 5 6 11
6 2 2 21 21 1 2 3
7 2 2 22 22 4 5 6
$EndElements
'''


class CohesiveMeshTests(unittest.TestCase):
    def test_inserts_cohesive_interfaces_between_distinct_ordered_single_material_layer_regions(self):
        converted, summary = COHESIVE_MESH.insert_cohesive_layer_regions(
            LAYER_REGION_MESH, [11, 12, 13], [21, 22], cohesive_volume_tag=1003,
        )
        parsed = COHESIVE_MESH.parse_msh22(converted)
        volume_nodes = {tag: set() for tag in (11, 12, 13)}
        cohesive = []
        for element in parsed["elements"]:
            physical_tag = element[2][0]
            if physical_tag in volume_nodes:
                volume_nodes[physical_tag].update(element[3])
            elif element[1] == 6:
                cohesive.append(element)

        self.assertEqual(summary["layerRegionTetrahedronCounts"], {"11": 1, "12": 3, "13": 1})
        self.assertEqual(summary["interfaceTriangleCountsByTag"], {"21": 1, "22": 1})
        self.assertEqual(summary["cohesiveElementCount"], 2)
        self.assertEqual(summary["duplicatedNodeCount"], 6)
        self.assertFalse(volume_nodes[11] & volume_nodes[12])
        self.assertFalse(volume_nodes[12] & volume_nodes[13])
        self.assertEqual({(dimension, tag, name) for dimension, tag, name in parsed["physicalNames"] if dimension == 3}, {
            (3, 11, "LAYER_1"), (3, 12, "LAYER_2"), (3, 13, "LAYER_3"), (3, 1003, "GM1003"),
        })
        self.assertEqual([element[2][0] for element in cohesive], [1003, 1003])
        for element in cohesive:
            lower, upper = element[3][:3], element[3][3:]
            self.assertEqual([parsed["nodes"][node] for node in lower], [parsed["nodes"][node] for node in upper])

    def test_layer_region_mesh_requires_every_adjacent_interface(self):
        with self.assertRaisesRegex(ValueError, "exactly one interface"):
            COHESIVE_MESH.insert_cohesive_layer_regions(LAYER_REGION_MESH, [11, 12, 13], [21], 1003)
        with self.assertRaisesRegex(ValueError, "every layer interface group"):
            COHESIVE_MESH.insert_cohesive_layer_regions(LAYER_REGION_MESH.replace("7\n1 4 2 11", "6\n1 4 2 11").replace("7 2 2 22 22 4 5 6\n", ""), [11, 12, 13], [21, 22], 1003)

    def test_allocates_a_cohesive_tag_beyond_the_full_interface_and_boundary_tag_ranges(self):
        boundary_faces = [{"physicalTag": tag} for tag in range(1001, 1033)]
        self.assertEqual(
            COHESIVE_MESH._resolve_cohesive_volume_tag(None, [1, 2], list(range(3, 35)), boundary_faces),
            1033,
        )
        with self.assertRaisesRegex(ValueError, "conflicts"):
            COHESIVE_MESH._resolve_cohesive_volume_tag(6, [1, 2], list(range(3, 7)), boundary_faces[:1])
        self.assertEqual(COHESIVE_MESH._resolve_cohesive_volume_tag(6, [1, 2], [3, 4], []), 6)

    def test_matches_concave_native_planar_face_by_bounds_when_centroids_differ(self):
        native_face = {
            "centerMm": [9.8959435626, 9.3747795414, 0.0],
            "normalGlobal": [0.0, 0.0, -1.0],
            "minMm": [0.0, 0.0, 0.0],
            "maxMm": [29.9999993294, 25.0000003725, 0.0],
        }
        imported_step_surface = {
            "center": [9.8743226495, 9.3956980601, 0.0],
            "normal": [0.0, 0.0, -1.0],
            "min": [-1e-7, -1e-7, -1e-7],
            "max": [30.0000001, 25.0000001, 1e-7],
        }

        self.assertGreater(abs(native_face["centerMm"][0] - imported_step_surface["center"][0]), 0.0001)
        self.assertTrue(COHESIVE_MESH._boundary_face_matches_surface(native_face, imported_step_surface))
        self.assertFalse(COHESIVE_MESH._boundary_face_matches_surface(
            native_face,
            {**imported_step_surface, "normal": [0.0, 0.0, 1.0]},
        ))
        self.assertFalse(COHESIVE_MESH._boundary_face_matches_surface(
            native_face,
            {**imported_step_surface, "max": [30.001, 25.0000001, 1e-7]},
        ))

    def test_validates_a_parallel_ordered_stack_of_split_planes(self):
        planes = COHESIVE_MESH._validate_split_planes([
            {"pointMm": [0, 0, 1], "normalGlobal": [0, 0, 2]},
            {"pointMm": [0, 0, 2], "normalGlobal": [0, 0, 1]},
        ])
        self.assertEqual(planes[0]["normalGlobal"], (0.0, 0.0, 1.0))
        self.assertEqual(planes[1]["pointMm"], (0.0, 0.0, 2.0))
        with self.assertRaisesRegex(ValueError, "parallel normals"):
            COHESIVE_MESH._validate_split_planes([
                {"pointMm": [0, 0, 1], "normalGlobal": [0, 0, 1]},
                {"pointMm": [0, 0, 2], "normalGlobal": [0, 1, 0]},
            ])
        with self.assertRaisesRegex(ValueError, "ordered and separated"):
            COHESIVE_MESH._validate_split_planes([
                {"pointMm": [0, 0, 2], "normalGlobal": [0, 0, 1]},
                {"pointMm": [0, 0, 1], "normalGlobal": [0, 0, 1]},
            ])

    def test_accepts_maximum_supported_layer_interfaces_and_rejects_one_extra(self):
        maximum = [
            {"pointMm": [0, 0, float(index + 1)], "normalGlobal": [0, 0, 1]}
            for index in range(COHESIVE_MESH.MAX_LAYER_INTERFACE_PLANES)
        ]
        self.assertEqual(len(COHESIVE_MESH._validate_split_planes(maximum)), 255)
        with self.assertRaisesRegex(ValueError, "1 and 255 planes"):
            COHESIVE_MESH._validate_split_planes([*maximum, {"pointMm": [0, 0, 256], "normalGlobal": [0, 0, 1]}])

    def test_inserts_penta6_and_duplicates_only_the_second_material_interface_nodes(self):
        converted, summary = COHESIVE_MESH.insert_cohesive_interface(
            MESH, material_a_tag=1, material_b_tag=2, interface_surface_tag=3, cohesive_volume_tag=6
        )
        parsed = COHESIVE_MESH.parse_msh22(converted)
        elements = {element[0]: element for element in parsed["elements"]}

        self.assertEqual(summary["interfaceTriangleCount"], 1)
        self.assertEqual(summary["cohesiveElementCount"], 1)
        self.assertEqual(summary["cohesiveElementIds"], [6])
        self.assertEqual(summary["duplicatedNodeCount"], 3)
        self.assertEqual(len(parsed["nodes"]), 8)
        self.assertEqual(elements[1][3], (1, 2, 3, 4))
        self.assertEqual(elements[2][3], (6, 8, 7, 5))
        self.assertEqual(elements[4][3], (6, 7, 5))
        self.assertEqual(elements[5][3], (1, 2, 4))
        self.assertNotIn(3, elements)
        cohesive = next(element for element in parsed["elements"] if element[1] == 6)
        self.assertEqual(cohesive[2][0], 6)
        self.assertEqual(set(cohesive[3][:3]), {1, 2, 3})
        self.assertEqual(set(cohesive[3][3:]), {6, 7, 8})
        self.assertIn((3, 6, "GM6"), parsed["physicalNames"])
        self.assertEqual(parsed["nodes"][1], parsed["nodes"][6])
        self.assertEqual(parsed["nodes"][2], parsed["nodes"][7])
        self.assertEqual(parsed["nodes"][3], parsed["nodes"][8])

    def test_inserts_cohesive_elements_at_multiple_interfaces_in_one_layer_stack(self):
        converted, summary = COHESIVE_MESH.insert_cohesive_interfaces(
            LAYER_STACK_MESH, material_a_tag=1, material_b_tag=2,
            interface_surface_tags=[3, 4], cohesive_volume_tag=6,
        )
        parsed = COHESIVE_MESH.parse_msh22(converted)
        elements = {element[0]: element for element in parsed["elements"]}
        cohesive = [element for element in parsed["elements"] if element[1] == 6]

        self.assertEqual(summary["interfaceTriangleCount"], 2)
        self.assertEqual(summary["interfaceTriangleCountsByTag"], {"3": 1, "4": 1})
        self.assertEqual(summary["cohesiveElementCount"], 2)
        self.assertEqual(summary["duplicatedNodeCount"], 6)
        self.assertEqual([element[2][0] for element in cohesive], [6, 6])
        self.assertEqual({tuple(sorted(element[3][:3])) for element in cohesive}, {(1, 2, 3), (4, 5, 6)})
        self.assertIn((3, 6, "GM6"), parsed["physicalNames"])
        self.assertNotIn((2, 3, "INTERFACE_1"), parsed["physicalNames"])
        self.assertNotIn((2, 4, "INTERFACE_2"), parsed["physicalNames"])

    def test_rejects_a_missing_or_extra_layer_interface_surface(self):
        with self.assertRaisesRegex(ValueError, "every interface surface"):
            COHESIVE_MESH.insert_cohesive_interfaces(
                LAYER_STACK_MESH.replace('5\n2 3 "INTERFACE_1"', '4\n2 3 "INTERFACE_1"')
                .replace('2 4 "INTERFACE_2"\n', ''), 1, 2, [3, 4], 6,
            )
        with self.assertRaisesRegex(ValueError, "exactly match"):
            COHESIVE_MESH.insert_cohesive_interfaces(LAYER_STACK_MESH, 1, 2, [3], 6)

    def test_rejects_interface_surface_that_does_not_match_both_material_boundaries(self):
        missing_interface = MESH.replace("5\n1 4 2 1 1", "4\n1 4 2 1 1").replace("3 2 2 3 3 1 2 3\n", "")
        with self.assertRaisesRegex(ValueError, "interface surface group"):
            COHESIVE_MESH.insert_cohesive_interface(
                missing_interface, material_a_tag=1, material_b_tag=2, interface_surface_tag=3, cohesive_volume_tag=6
            )

    def test_rejects_non_unique_or_colliding_group_tags(self):
        with self.assertRaisesRegex(ValueError, "distinct"):
            COHESIVE_MESH.insert_cohesive_interface(
                MESH, material_a_tag=1, material_b_tag=1, interface_surface_tag=3, cohesive_volume_tag=6
            )
        with self.assertRaisesRegex(ValueError, "already in use"):
            COHESIVE_MESH.insert_cohesive_interface(
                MESH, material_a_tag=1, material_b_tag=2, interface_surface_tag=3, cohesive_volume_tag=2
            )

    def test_step_mesh_generation_rejects_zero_normal_before_loading_gmsh(self):
        with tempfile.TemporaryDirectory() as directory:
            step_path = Path(directory) / "shape.step"
            output_path = Path(directory) / "cohesive.msh"
            step_path.write_text("test", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "normalGlobal must be nonzero"):
                COHESIVE_MESH.generate_cohesive_mesh_from_step(
                    str(step_path), str(output_path),
                    [{"pointMm": [0, 0, 0], "normalGlobal": [0, 0, 0]}], 1.0
                )

    def test_step_mesh_generation_rejects_boundary_group_tag_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            step_path = Path(directory) / "shape.step"
            output_path = Path(directory) / "cohesive.msh"
            step_path.write_text("test", encoding="utf-8")
            boundary_faces = [{
                "faceId": "bottom", "physicalTag": 3,
                "centerMm": [0, 0, 0], "normalGlobal": [0, 0, 1],
                "boundsMm": {"min": [0, 0, 0], "max": [1, 1, 0]},
            }]
            with self.assertRaisesRegex(ValueError, "globally unique"):
                COHESIVE_MESH.generate_cohesive_mesh_from_step(
                    str(step_path), str(output_path),
                    [{"pointMm": [0, 0, 0], "normalGlobal": [0, 0, 1]}], 1.0,
                    boundary_faces_input=boundary_faces,
                )


if __name__ == "__main__":
    unittest.main()
