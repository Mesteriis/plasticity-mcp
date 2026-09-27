#!/usr/bin/env python3
"""Build a small synthetic 3D_JOINT / CZM_TURON Code_Aster acceptance job."""

import importlib.util
import itertools
import json
import sys
from collections import defaultdict
from pathlib import Path


def _load_cohesive_mesh_helper():
    helper_path = Path(__file__).with_name("cohesive-mesh.py")
    spec = importlib.util.spec_from_file_location("cohesive_mesh", helper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the cohesive mesh helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_test_mesh():
    nx = ny = 2
    nodes = {}
    node_by_grid = {}
    next_node = 0
    for k in range(-2, 3):
        for j in range(ny + 1):
            for i in range(nx + 1):
                next_node += 1
                node_by_grid[(i, j, k)] = next_node
                nodes[next_node] = (i * 2.5, j * 2.5, float(k))

    materials = {1: [], 2: []}
    for material_tag, z_cells in ((2, (-2, -1)), (1, (0, 1))):
        for k in z_cells:
            for j in range(ny):
                for i in range(nx):
                    lower = (i, j, k)
                    upper = (i + 1, j + 1, k + 1)
                    for permutation in itertools.permutations((0, 1, 2)):
                        middle_a = list(lower)
                        middle_a[permutation[0]] += 1
                        middle_b = list(middle_a)
                        middle_b[permutation[1]] += 1
                        materials[material_tag].append(tuple(
                            node_by_grid[grid]
                            for grid in (lower, tuple(middle_a), tuple(middle_b), upper)
                        ))

    face_owners = defaultdict(list)
    for material_tag, tetrahedra in materials.items():
        for tetrahedron in tetrahedra:
            for face in (
                (tetrahedron[1], tetrahedron[2], tetrahedron[3]),
                (tetrahedron[0], tetrahedron[3], tetrahedron[2]),
                (tetrahedron[0], tetrahedron[1], tetrahedron[3]),
                (tetrahedron[0], tetrahedron[2], tetrahedron[1]),
            ):
                face_owners[tuple(sorted(face))].append((material_tag, face))

    interface = []
    bottom = []
    top = []
    for owners in face_owners.values():
        if len(owners) == 2 and {owner[0] for owner in owners} == {1, 2}:
            interface.append(next(face for tag, face in owners if tag == 1))
        if len(owners) == 1:
            face = owners[0][1]
            z_values = [nodes[node][2] for node in face]
            if all(z == -2 for z in z_values):
                bottom.append(face)
            elif all(z == 2 for z in z_values):
                top.append(face)

    elements = [(tag, tetrahedron) for tag, tets in materials.items() for tetrahedron in tets]
    elements.extend((tag, face) for tag, faces in ((3, interface), (4, bottom), (5, top)) for face in faces)
    lines = [
        "$MeshFormat", "2.2 0 8", "$EndMeshFormat", "$PhysicalNames", "5",
        '2 3 "INTERFACE"', '2 4 "GM4"', '2 5 "GM5"', '3 1 "GM1"', '3 2 "GM2"',
        "$EndPhysicalNames", "$Nodes", str(len(nodes)),
    ]
    lines.extend(f"{tag} {x:.9g} {y:.9g} {z:.9g}" for tag, (x, y, z) in nodes.items())
    lines.extend(("$EndNodes", "$Elements", str(len(elements))))
    lines.extend(
        f"{tag} {4 if len(connectivity) == 4 else 2} 2 {physical_tag} {physical_tag} "
        + " ".join(map(str, connectivity))
        for tag, (physical_tag, connectivity) in enumerate(elements, start=1)
    )
    lines.append("$EndElements")
    raw_mesh = "\n".join(lines) + "\n"
    mesh_text, summary = _load_cohesive_mesh_helper().insert_cohesive_interface(
        raw_mesh, material_a_tag=1, material_b_tag=2, interface_surface_tag=3, cohesive_volume_tag=6,
    )
    return mesh_text, summary


def write_acceptance_case(output_dir):
    directory = Path(output_dir).resolve()
    if not directory.is_dir():
        raise ValueError("Output directory must already exist")
    mesh_text, summary = build_test_mesh()
    target = directory / "cohesive.msh"
    with target.open("x", encoding="utf-8") as output:
        output.write(mesh_text)
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: turon-3d-acceptance.py OUTPUT_DIRECTORY")
    print(json.dumps(write_acceptance_case(sys.argv[1]), sort_keys=True))
