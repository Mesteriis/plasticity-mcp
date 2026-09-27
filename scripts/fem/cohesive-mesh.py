#!/usr/bin/env python3
"""Insert zero-thickness PENTA6 cohesive elements into a two-material MSH 2.2 mesh."""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import TypedDict

MAX_LAYERWISE_FEA_LAYERS = 256
MAX_LAYER_INTERFACE_PLANES = MAX_LAYERWISE_FEA_LAYERS - 1


PhysicalName = tuple[int, int, str]
MeshElement = tuple[int, int, tuple[int, ...], tuple[int, ...]]


class ParsedMsh22(TypedDict):
    physicalNames: list[PhysicalName]
    nodes: dict[int, tuple[float, float, float]]
    elements: list[MeshElement]


def fail(message: str) -> None:
    raise ValueError(message)


def _section_lines(text: str, name: str) -> list[str]:
    start_marker = f"${name}"
    end_marker = f"$End{name}"
    lines = text.splitlines()
    try:
        start = lines.index(start_marker) + 1
        end = lines.index(end_marker, start)
    except ValueError as error:
        raise ValueError(f"MSH 2.2 is missing its {name} section") from error
    return lines[start:end]


def parse_msh22(text: str) -> ParsedMsh22:
    supported_sections = {"MeshFormat", "PhysicalNames", "Nodes", "Elements", "Comments"}
    for line in text.splitlines():
        if line.startswith("$") and not line.startswith("$End") and line[1:] not in supported_sections:
            fail(f"MSH section {line} is not supported; refusing to drop mesh data")
    format_lines = _section_lines(text, "MeshFormat")
    if len(format_lines) != 1 or format_lines[0].split() != ["2.2", "0", "8"]:
        fail("input must be ASCII Gmsh MSH 2.2 with 8-byte floating-point coordinates")

    physical_lines = _section_lines(text, "PhysicalNames")
    if not physical_lines:
        fail("MSH 2.2 is missing its physical-name count")
    physical_count = int(physical_lines[0])
    if len(physical_lines) != physical_count + 1:
        fail("MSH 2.2 physical-name count does not match its entries")
    physical_names = []
    for line in physical_lines[1:]:
        values = line.split(maxsplit=2)
        if len(values) != 3:
            fail("MSH 2.2 contains an invalid physical-name entry")
        dimension, tag = int(values[0]), int(values[1])
        name = json.loads(values[2])
        if dimension not in (0, 1, 2, 3) or tag <= 0 or not isinstance(name, str):
            fail("MSH 2.2 contains an invalid physical-name entry")
        physical_names.append((dimension, tag, name))

    node_lines = _section_lines(text, "Nodes")
    if not node_lines:
        fail("MSH 2.2 is missing its node count")
    node_count = int(node_lines[0])
    if len(node_lines) != node_count + 1:
        fail("MSH 2.2 node count does not match its entries")
    nodes: dict[int, tuple[float, float, float]] = {}
    for line in node_lines[1:]:
        values = line.split()
        if len(values) != 4:
            fail("MSH 2.2 contains an invalid node entry")
        node_id = int(values[0])
        xyz = (float(values[1]), float(values[2]), float(values[3]))
        if node_id <= 0 or node_id in nodes or not all(math.isfinite(value) for value in xyz):
            fail("MSH 2.2 contains invalid or duplicate node IDs/coordinates")
        nodes[node_id] = xyz

    element_lines = _section_lines(text, "Elements")
    if not element_lines:
        fail("MSH 2.2 is missing its element count")
    element_count = int(element_lines[0])
    if len(element_lines) != element_count + 1:
        fail("MSH 2.2 element count does not match its entries")
    elements = []
    seen_element_ids = set()
    for line in element_lines[1:]:
        values = [int(value) for value in line.split()]
        if len(values) < 3:
            fail("MSH 2.2 contains an invalid element entry")
        element_id, element_type, tag_count = values[:3]
        tags = tuple(values[3:3 + tag_count])
        connectivity = tuple(values[3 + tag_count:])
        if element_id <= 0 or element_type <= 0 or element_id in seen_element_ids or tag_count < 0 or len(tags) != tag_count:
            fail("MSH 2.2 contains invalid or duplicate element IDs/tags")
        if any(tag < 0 for tag in tags):
            fail("MSH 2.2 contains a negative element tag")
        if not connectivity or any(node_id not in nodes for node_id in connectivity):
            fail(f"MSH 2.2 element {element_id} references a missing node")
        seen_element_ids.add(element_id)
        elements.append((element_id, element_type, tags, connectivity))

    if not nodes or not elements:
        fail("MSH 2.2 must contain nodes and elements")
    return {"physicalNames": physical_names, "nodes": nodes, "elements": elements}


def _tetra_faces(connectivity: tuple[int, ...], nodes: dict[int, tuple[float, float, float]]) -> list[tuple[int, int, int]]:
    if len(connectivity) != 4:
        fail("material volume group must contain only first-order tetrahedra")
    origin, first, second, third = (nodes[node] for node in connectivity)
    edges = [[point[axis] - origin[axis] for axis in range(3)] for point in (first, second, third)]
    determinant = (
        edges[0][0] * (edges[1][1] * edges[2][2] - edges[1][2] * edges[2][1])
        - edges[0][1] * (edges[1][0] * edges[2][2] - edges[1][2] * edges[2][0])
        + edges[0][2] * (edges[1][0] * edges[2][1] - edges[1][1] * edges[2][0])
    )
    if abs(determinant) <= 1e-18:
        fail("material volume group contains a degenerate tetrahedron")
    faces = []
    for opposite_index in range(4):
        face = [node for index, node in enumerate(connectivity) if index != opposite_index]
        opposite = connectivity[opposite_index]
        first, second, third = (nodes[node] for node in face)
        toward_opposite = [nodes[opposite][axis] - first[axis] for axis in range(3)]
        first_edge = [second[axis] - first[axis] for axis in range(3)]
        second_edge = [third[axis] - first[axis] for axis in range(3)]
        normal = (
            first_edge[1] * second_edge[2] - first_edge[2] * second_edge[1],
            first_edge[2] * second_edge[0] - first_edge[0] * second_edge[2],
            first_edge[0] * second_edge[1] - first_edge[1] * second_edge[0],
        )
        if math.sqrt(sum(value * value for value in normal)) <= 1e-15:
            fail("material volume group contains a degenerate tetrahedron")
        if sum(normal[axis] * toward_opposite[axis] for axis in range(3)) > 0:
            face[1], face[2] = face[2], face[1]
        faces.append(tuple(face))
    return faces


def insert_cohesive_interface(
    text: str,
    material_a_tag: int,
    material_b_tag: int,
    interface_surface_tag: int,
    cohesive_volume_tag: int,
) -> tuple[str, dict[str, object]]:
    return insert_cohesive_interfaces(
        text, material_a_tag, material_b_tag, [interface_surface_tag], cohesive_volume_tag
    )


def insert_cohesive_interfaces(
    text: str,
    material_a_tag: int,
    material_b_tag: int,
    interface_surface_tags: list[int],
    cohesive_volume_tag: int,
) -> tuple[str, dict[str, object]]:
    if not isinstance(interface_surface_tags, list) or not interface_surface_tags:
        fail("interface surface tags must contain at least one physical group")
    if any(not isinstance(tag, int) or isinstance(tag, bool) or tag <= 0 for tag in interface_surface_tags):
        fail("interface surface tags must be positive integers")
    if len(set(interface_surface_tags)) != len(interface_surface_tags):
        fail("interface surface tags must be unique")
    tags = (material_a_tag, material_b_tag, *interface_surface_tags, cohesive_volume_tag)
    if any(not isinstance(tag, int) or isinstance(tag, bool) or tag <= 0 for tag in tags):
        fail("all physical group tags must be positive integers")
    if len(set(tags[:-1])) != len(tags[:-1]):
        fail("material and interface physical group tags must be distinct")

    mesh = parse_msh22(text)
    physical_names = mesh["physicalNames"]
    nodes = mesh["nodes"]
    elements = mesh["elements"]
    existing_tags = {tag for _dimension, tag, _name in physical_names}
    if cohesive_volume_tag in existing_tags:
        fail(f"cohesive volume tag {cohesive_volume_tag} is already in use")
    named_dimensions = {tag: dimension for dimension, tag, _name in physical_names}
    if named_dimensions.get(material_a_tag) != 3 or named_dimensions.get(material_b_tag) != 3:
        fail("material tags must name existing dimension-3 physical groups")
    if any(named_dimensions.get(tag) != 2 for tag in interface_surface_tags):
        fail("every interface surface tag must name an existing dimension-2 physical group")
    if len(named_dimensions) != len(physical_names):
        fail("physical group tags must be globally unique for Code_Aster compatibility")

    material_elements: dict[int, list[MeshElement]] = {
        material_a_tag: [], material_b_tag: [],
    }
    interface_elements_by_tag: dict[int, list[MeshElement]] = {
        tag: [] for tag in interface_surface_tags
    }
    for element in elements:
        element_id, element_type, element_tags, connectivity = element
        physical_tag = element_tags[0] if element_tags else None
        if physical_tag in material_elements:
            if element_type != 4:
                fail("material volume group must contain only first-order tetrahedra")
            material_elements[physical_tag].append(element)
        if element_type == 2 and physical_tag in interface_elements_by_tag:
            if len(connectivity) != 3:
                fail("interface surface group must contain only first-order triangles")
            interface_elements_by_tag[physical_tag].append(element)
    if not material_elements[material_a_tag] or not material_elements[material_b_tag]:
        fail("both material physical groups must contain tetrahedra")
    if any(not group for group in interface_elements_by_tag.values()):
        fail("every interface surface group must contain first-order triangles")

    face_owners: dict[tuple[int, int, int], dict[int, list[tuple[int, int, int]]]] = {}
    material_nodes: dict[int, set[int]] = {material_a_tag: set(), material_b_tag: set()}
    for material_tag, tetrahedra in material_elements.items():
        for element_id, _element_type, _element_tags, connectivity in tetrahedra:
            material_nodes[material_tag].update(connectivity)
            for outward_face in _tetra_faces(connectivity, nodes):
                key = tuple(sorted(outward_face))
                face_owners.setdefault(key, {}).setdefault(material_tag, []).append(outward_face)

    shared_faces = {
        key for key, owners in face_owners.items()
        if len(owners.get(material_a_tag, [])) == 1 and len(owners.get(material_b_tag, [])) == 1
    }
    interface_by_key: dict[tuple[int, int, int], MeshElement] = {}
    interface_counts_by_tag: dict[str, int] = {}
    for tag, interface_elements in interface_elements_by_tag.items():
        interface_counts_by_tag[str(tag)] = len(interface_elements)
        for element in interface_elements:
            key = tuple(sorted(element[3]))
            if key in interface_by_key:
                fail("interface surface groups contain duplicate triangles")
            interface_by_key[key] = element
    if set(interface_by_key) != shared_faces:
        fail("interface surface group must exactly match the shared material boundary triangles")
    interface_nodes = {node_id for key in shared_faces for node_id in key}
    if material_nodes[material_a_tag] & material_nodes[material_b_tag] != interface_nodes:
        fail("materials share nodes outside the declared interface; split the CAD/mesh boundary first")

    next_node_id = max(nodes)
    duplicate_node_ids = {node_id: next_node_id + index for index, node_id in enumerate(sorted(interface_nodes), start=1)}
    duplicated_nodes = {new_id: nodes[old_id] for old_id, new_id in duplicate_node_ids.items()}
    next_element_id = max(element[0] for element in elements)
    cohesive_elements = []
    for key in sorted(shared_faces):
        owners = face_owners[key][material_a_tag]
        if len(owners) != 1:
            fail("material A has a non-manifold interface face")
        oriented_a_face = owners[0]
        duplicate_b_face = tuple(duplicate_node_ids[node_id] for node_id in oriented_a_face)
        next_element_id += 1
        cohesive_elements.append((next_element_id, 6, (cohesive_volume_tag, cohesive_volume_tag), oriented_a_face + duplicate_b_face))

    transformed_elements = []
    dropped_interface_count = 0
    for element in elements:
        element_id, element_type, element_tags, connectivity = element
        physical_tag = element_tags[0] if element_tags else None
        if element_type == 2 and physical_tag in interface_elements_by_tag:
            dropped_interface_count += 1
            continue
        if element_type == 4 and physical_tag == material_b_tag:
            connectivity = tuple(duplicate_node_ids.get(node_id, node_id) for node_id in connectivity)
        elif element_type == 2 and len(connectivity) == 3:
            face_key = tuple(sorted(connectivity))
            owners = face_owners.get(face_key, {})
            if material_b_tag in owners and material_a_tag not in owners:
                connectivity = tuple(duplicate_node_ids.get(node_id, node_id) for node_id in connectivity)
        transformed_elements.append((element_id, element_type, element_tags, connectivity))
    if dropped_interface_count != len(shared_faces):
        fail("not all interface triangles were replaced by cohesive elements")
    transformed_elements.extend(cohesive_elements)

    output_physical_names = [
        entry for entry in physical_names
        if not (entry[0] == 2 and entry[1] in interface_elements_by_tag)
    ]
    output_physical_names.append((3, cohesive_volume_tag, f"GM{cohesive_volume_tag}"))
    output_nodes = dict(nodes)
    output_nodes.update(duplicated_nodes)
    output_text = _write_msh22(output_physical_names, output_nodes, transformed_elements)
    return output_text, {
        "materialATetrahedronCount": len(material_elements[material_a_tag]),
        "materialBTetrahedronCount": len(material_elements[material_b_tag]),
        "interfaceTriangleCount": len(shared_faces),
        "interfaceTriangleCountsByTag": interface_counts_by_tag,
        "cohesiveElementCount": len(cohesive_elements),
        "cohesiveElementIds": [element[0] for element in cohesive_elements],
        "duplicatedNodeCount": len(duplicate_node_ids),
    }


def insert_cohesive_layer_regions(
    text: str,
    layer_region_tags: list[int],
    interface_surface_tags: list[int],
    cohesive_volume_tag: int,
) -> tuple[str, dict[str, object]]:
    """Insert cohesive seams between ordered per-layer regions without changing material identity."""
    if not isinstance(layer_region_tags, list) or not 2 <= len(layer_region_tags) <= MAX_LAYERWISE_FEA_LAYERS:
        fail(f"layer region tags must contain between 2 and {MAX_LAYERWISE_FEA_LAYERS} ordered volumes")
    if not isinstance(interface_surface_tags, list) or len(interface_surface_tags) != len(layer_region_tags) - 1:
        fail("provide exactly one interface surface tag between every adjacent layer region")
    tags = [*layer_region_tags, *interface_surface_tags, cohesive_volume_tag]
    if any(not isinstance(tag, int) or isinstance(tag, bool) or tag <= 0 for tag in tags) or len(set(tags)) != len(tags):
        fail("layer region, interface, and cohesive physical group tags must be distinct positive integers")

    mesh = parse_msh22(text)
    nodes = mesh["nodes"]
    elements = mesh["elements"]
    physical_names = mesh["physicalNames"]
    named_dimensions = {tag: dimension for dimension, tag, _name in physical_names}
    if len(named_dimensions) != len(physical_names):
        fail("physical group tags must be globally unique for Code_Aster compatibility")
    if any(named_dimensions.get(tag) != 3 for tag in layer_region_tags):
        fail("every layer region tag must name an existing dimension-3 physical group")
    if any(named_dimensions.get(tag) != 2 for tag in interface_surface_tags):
        fail("every layer interface tag must name an existing dimension-2 physical group")
    if cohesive_volume_tag in named_dimensions:
        fail("cohesive volume tag is already in use")

    region_elements: list[list[MeshElement]] = [[] for _ in layer_region_tags]
    interface_elements: list[list[MeshElement]] = [[] for _ in interface_surface_tags]
    region_by_tag = {tag: index for index, tag in enumerate(layer_region_tags)}
    interface_by_tag = {tag: index for index, tag in enumerate(interface_surface_tags)}
    for element in elements:
        element_id, element_type, element_tags, connectivity = element
        physical_tag = element_tags[0] if element_tags else None
        if physical_tag in region_by_tag:
            if element_type != 4:
                fail("each layer region must contain only first-order tetrahedra")
            region_elements[region_by_tag[physical_tag]].append(element)
        if element_type == 2 and physical_tag in interface_by_tag:
            if len(connectivity) != 3:
                fail("layer interface groups must contain only first-order triangles")
            interface_elements[interface_by_tag[physical_tag]].append(element)
    if any(not group for group in region_elements):
        fail("every layer region must contain at least one tetrahedron")
    if any(not group for group in interface_elements):
        fail("every layer interface group must contain first-order triangles")

    region_faces: list[dict[tuple[int, int, int], list[tuple[int, int, int]]]] = []
    for tetrahedra in region_elements:
        faces: dict[tuple[int, int, int], list[tuple[int, int, int]]] = {}
        for _element_id, _element_type, _element_tags, connectivity in tetrahedra:
            for face in _tetra_faces(connectivity, nodes):
                faces.setdefault(tuple(sorted(face)), []).append(face)
        region_faces.append(faces)

    seam_faces: list[set[tuple[int, int, int]]] = []
    for seam_index in range(len(interface_surface_tags)):
        lower_faces = region_faces[seam_index]
        upper_faces = region_faces[seam_index + 1]
        shared_faces = {
            face for face in lower_faces.keys() & upper_faces.keys()
            if len(lower_faces[face]) == 1 and len(upper_faces[face]) == 1
        }
        supplied_faces: set[tuple[int, int, int]] = set()
        for element in interface_elements[seam_index]:
            key = tuple(sorted(element[3]))
            if key in supplied_faces:
                fail("layer interface surface group contains duplicate triangles")
            supplied_faces.add(key)
        if supplied_faces != shared_faces:
            fail("each layer interface group must exactly match the shared triangles of its adjacent regions")
        seam_faces.append(shared_faces)

    next_node_id = max(nodes)
    duplicate_maps: list[dict[int, int]] = []
    duplicate_nodes: dict[int, tuple[float, float, float]] = {}
    for shared_faces in seam_faces:
        seam_nodes = {node_id for face in shared_faces for node_id in face}
        mapping: dict[int, int] = {}
        for node_id in sorted(seam_nodes):
            next_node_id += 1
            mapping[node_id] = next_node_id
            duplicate_nodes[next_node_id] = nodes[node_id]
        duplicate_maps.append(mapping)

    region_node_remaps: list[dict[int, int]] = [{} for _ in layer_region_tags]
    for region_index in range(1, len(layer_region_tags)):
        region_node_remaps[region_index] = duplicate_maps[region_index - 1]

    next_element_id = max(element[0] for element in elements)
    cohesive_elements: list[MeshElement] = []
    for seam_index, shared_faces in enumerate(seam_faces):
        lower_region_remap = region_node_remaps[seam_index]
        upper_region_remap = duplicate_maps[seam_index]
        lower_face_by_key = region_faces[seam_index]
        for key in sorted(shared_faces):
            lower_face = lower_face_by_key[key][0]
            lower_nodes = tuple(lower_region_remap.get(node_id, node_id) for node_id in lower_face)
            upper_nodes = tuple(upper_region_remap[node_id] for node_id in lower_face)
            next_element_id += 1
            cohesive_elements.append((next_element_id, 6, (cohesive_volume_tag, cohesive_volume_tag), lower_nodes + upper_nodes))

    output_elements: list[MeshElement] = []
    dropped_interfaces = 0
    for element in elements:
        element_id, element_type, element_tags, connectivity = element
        physical_tag = element_tags[0] if element_tags else None
        if element_type == 2 and physical_tag in interface_by_tag:
            dropped_interfaces += 1
            continue
        if element_type == 4 and physical_tag in region_by_tag:
            remap = region_node_remaps[region_by_tag[physical_tag]]
            connectivity = tuple(remap.get(node_id, node_id) for node_id in connectivity)
        elif element_type == 2 and len(connectivity) == 3:
            key = tuple(sorted(connectivity))
            owners = [index for index, faces in enumerate(region_faces) if key in faces]
            if len(owners) == 1:
                remap = region_node_remaps[owners[0]]
                connectivity = tuple(remap.get(node_id, node_id) for node_id in connectivity)
        output_elements.append((element_id, element_type, element_tags, connectivity))
    if dropped_interfaces != sum(len(group) for group in interface_elements):
        fail("not all layer interface triangles were replaced by cohesive elements")
    output_elements.extend(cohesive_elements)

    output_names = [entry for entry in physical_names if not (entry[0] == 2 and entry[1] in interface_by_tag)]
    output_names.append((3, cohesive_volume_tag, f"GM{cohesive_volume_tag}"))
    output_nodes = dict(nodes)
    output_nodes.update(duplicate_nodes)
    return _write_msh22(output_names, output_nodes, output_elements), {
        "layerRegionTetrahedronCounts": {str(tag): len(region_elements[index]) for index, tag in enumerate(layer_region_tags)},
        "interfaceTriangleCountsByTag": {str(tag): len(interface_elements[index]) for index, tag in enumerate(interface_surface_tags)},
        "interfaceTriangleCount": sum(len(faces) for faces in seam_faces),
        "cohesiveElementCount": len(cohesive_elements),
        "cohesiveElementIds": [element[0] for element in cohesive_elements],
        "duplicatedNodeCount": len(duplicate_nodes),
    }


def _write_msh22(
    physical_names: list[PhysicalName],
    nodes: dict[int, tuple[float, float, float]],
    elements: list[MeshElement],
) -> str:
    lines = ["$MeshFormat", "2.2 0 8", "$EndMeshFormat", "$PhysicalNames", str(len(physical_names))]
    lines.extend(f'{dimension} {tag} {json.dumps(name)}' for dimension, tag, name in physical_names)
    lines.extend(["$EndPhysicalNames", "$Nodes", str(len(nodes))])
    lines.extend(f"{node_id} {xyz[0]:.17g} {xyz[1]:.17g} {xyz[2]:.17g}" for node_id, xyz in sorted(nodes.items()))
    lines.extend(["$EndNodes", "$Elements", str(len(elements))])
    lines.extend(
        f"{element_id} {element_type} {len(element_tags)} {' '.join(map(str, element_tags))} {' '.join(map(str, connectivity))}"
        for element_id, element_type, element_tags, connectivity in elements
    )
    lines.extend(["$EndElements", ""])
    return "\n".join(lines)


def _finite_vector(value: object, name: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        fail(f"{name} must be a three-vector")
    if any(not isinstance(component, (int, float)) or isinstance(component, bool) or not math.isfinite(component) for component in value):
        fail(f"{name} must contain finite numbers")
    return (float(value[0]), float(value[1]), float(value[2]))


def _validate_split_planes(value: object) -> list[dict[str, tuple[float, float, float]]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_LAYER_INTERFACE_PLANES:
        fail(f"splitPlanes must contain between 1 and {MAX_LAYER_INTERFACE_PLANES} planes")
    planes = []
    reference_normal = None
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            fail(f"splitPlanes[{index}] must be an object")
        point = _finite_vector(item.get("pointMm"), f"splitPlanes[{index}].pointMm")
        normal = _finite_vector(item.get("normalGlobal"), f"splitPlanes[{index}].normalGlobal")
        length = math.sqrt(sum(component * component for component in normal))
        if length <= 1e-12:
            fail(f"splitPlanes[{index}].normalGlobal must be nonzero")
        normal = tuple(component / length for component in normal)
        if reference_normal is None:
            reference_normal = normal
        elif sum(reference_normal[axis] * normal[axis] for axis in range(3)) < 1.0 - 1e-9:
            fail("all splitPlanes must have parallel normals pointing in the same direction")
        planes.append({"pointMm": point, "normalGlobal": normal})
    normal = planes[0]["normalGlobal"]
    offsets = [sum(plane["pointMm"][axis] * normal[axis] for axis in range(3)) for plane in planes]
    if any(offsets[index] >= offsets[index + 1] - 1e-9 for index in range(len(offsets) - 1)):
        fail("splitPlanes must be ordered and separated along their shared normal")
    return planes


def _validate_boundary_faces(value: object, reserved_tags: set[int]) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > 32:
        fail("boundaryFaces must be an array with at most 32 entries")
    output = []
    seen_ids: set[str] = set()
    seen_tags = set(reserved_tags)
    for face in value:
        if not isinstance(face, dict):
            fail("each boundary face must be an object")
        face_id = face.get("faceId")
        tag = face.get("physicalTag")
        if not isinstance(face_id, str) or not face_id or face_id in seen_ids:
            fail("boundary face IDs must be unique nonempty strings")
        if not isinstance(tag, int) or isinstance(tag, bool) or tag <= 0 or tag in seen_tags:
            fail("boundary face physical tags must be positive and globally unique")
        center = _finite_vector(face.get("centerMm"), f"boundary face {face_id} centerMm")
        normal = _finite_vector(face.get("normalGlobal"), f"boundary face {face_id} normalGlobal")
        normal_length = math.sqrt(sum(component * component for component in normal))
        if normal_length <= 1e-12:
            fail(f"boundary face {face_id} normalGlobal must be nonzero")
        normal = tuple(component / normal_length for component in normal)
        bounds = face.get("boundsMm")
        if not isinstance(bounds, dict):
            fail(f"boundary face {face_id} boundsMm is required")
        minimum = _finite_vector(bounds.get("min"), f"boundary face {face_id} boundsMm.min")
        maximum = _finite_vector(bounds.get("max"), f"boundary face {face_id} boundsMm.max")
        if any(minimum[axis] > maximum[axis] for axis in range(3)):
            fail(f"boundary face {face_id} has invalid boundsMm")
        seen_ids.add(face_id)
        seen_tags.add(tag)
        output.append({"faceId": face_id, "physicalTag": tag, "centerMm": center, "normalGlobal": normal, "minMm": minimum, "maxMm": maximum})
    return output


def _resolve_cohesive_volume_tag(
    requested_tag: object,
    material_tags: list[int],
    interface_tags: list[int],
    boundary_faces: list[dict[str, object]],
) -> int:
    reserved_tags = {*material_tags, *interface_tags, *(int(face["physicalTag"]) for face in boundary_faces)}
    if requested_tag is None:
        return max(reserved_tags) + 1
    if not isinstance(requested_tag, int) or isinstance(requested_tag, bool) or requested_tag <= 0:
        fail("cohesive volume physical group tag must be a positive integer")
    if requested_tag in reserved_tags:
        fail("cohesive volume physical group tag conflicts with another physical group")
    return requested_tag


def _boundary_face_matches_surface(face: dict[str, object], surface: dict[str, object], tolerance: float = 0.0001) -> bool:
    """Match a native planar face to STEP by its normal and axis-aligned bounds.

    Plasticity's reported face center is not necessarily the trimmed surface's
    area centroid. STEP import computes that centroid independently, so center
    equality rejects valid concave planar faces even when their bounds and
    oriented plane match.
    """
    linear_error = max(
        [abs(face["minMm"][axis] - surface["min"][axis]) for axis in range(3)]
        + [abs(face["maxMm"][axis] - surface["max"][axis]) for axis in range(3)]
    )
    normal_dot = sum(face["normalGlobal"][axis] * surface["normal"][axis] for axis in range(3))
    return linear_error <= tolerance and normal_dot >= 0.99999


def generate_cohesive_mesh_from_step(
    step_path: str,
    output_path: str,
    split_planes_input: object,
    mesh_size_mm: float,
    material_a_tag: int = 1,
    material_b_tag: int = 2,
    interface_surface_tag: int = 3,
    cohesive_volume_tag: int | None = None,
    boundary_faces_input: object = None,
    layerwise_regions: bool = False,
) -> dict[str, object]:
    source_path = Path(step_path)
    output_file = Path(output_path)
    if not source_path.is_absolute() or not source_path.is_file():
        fail("stepPath must be an absolute existing STEP file")
    if not output_file.is_absolute() or output_file.suffix.lower() != ".msh":
        fail("outputPath must be an absolute .msh file path")
    if source_path.resolve() == output_file.resolve():
        fail("outputPath must be different from stepPath")
    if output_file.exists():
        fail("outputPath already exists; refusing to overwrite a mesh")
    if not isinstance(mesh_size_mm, (int, float)) or isinstance(mesh_size_mm, bool) or not math.isfinite(mesh_size_mm) or not 0 < mesh_size_mm <= 100:
        fail("meshSizeMm must be finite and in (0, 100]")
    split_planes = _validate_split_planes(split_planes_input)
    if not isinstance(layerwise_regions, bool):
        fail("layerwiseRegions must be boolean")
    volume_count = len(split_planes) + 1
    layer_region_tags = list(range(1, volume_count + 1)) if layerwise_regions else []
    interface_tag_base = max(interface_surface_tag, volume_count + 1) if layerwise_regions else interface_surface_tag
    interface_surface_tags = [interface_tag_base + index for index in range(len(split_planes))]
    physical_tags = tuple(layer_region_tags) + tuple(interface_surface_tags) if layerwise_regions else (material_a_tag, material_b_tag, *interface_surface_tags)
    if any(not isinstance(tag, int) or isinstance(tag, bool) or tag <= 0 for tag in physical_tags):
        fail("all physical group tags must be positive integers")
    if len(set(physical_tags)) != len(physical_tags):
        fail("material, interface, and cohesive physical group tags must be distinct")
    boundary_faces = _validate_boundary_faces(boundary_faces_input if boundary_faces_input is not None else [], set(physical_tags))
    cohesive_volume_tag = _resolve_cohesive_volume_tag(
        cohesive_volume_tag, list(layer_region_tags) if layerwise_regions else [material_a_tag, material_b_tag], interface_surface_tags, boundary_faces,
    )
    normal = split_planes[0]["normalGlobal"]

    import gmsh

    if not gmsh.__version__.startswith("4.15."):
        fail(f"Gmsh 4.15.x is required; found {gmsh.__version__}")
    gmsh_version = gmsh.__version__
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("plasticity-cohesive-layer-stack")
        gmsh.model.occ.importShapes(str(source_path))
        gmsh.model.occ.synchronize()
        volumes = gmsh.model.getEntities(3)
        if len(volumes) != 1:
            fail(f"cohesive split requires exactly one input Solid, found {len(volumes)} volumes")
        bounds = gmsh.model.occ.getBoundingBox(*volumes[0])
        minimum = [float(bounds[axis]) for axis in range(3)]
        maximum = [float(bounds[axis + 3]) for axis in range(3)]
        diagonal = math.sqrt(sum((maximum[axis] - minimum[axis]) ** 2 for axis in range(3)))
        if diagonal <= 1e-12:
            fail("input Solid has degenerate bounds")
        estimated_cells = math.prod(math.ceil((maximum[axis] - minimum[axis]) / (float(mesh_size_mm) * 0.5)) for axis in range(3))
        if estimated_cells > 300_000:
            fail(f"requested mesh is too fine for this Solid's bounding box (estimated cells={estimated_cells})")

        axes = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
        reference = min(axes, key=lambda axis: abs(sum(axis[index] * normal[index] for index in range(3))))
        first_basis = (
            normal[1] * reference[2] - normal[2] * reference[1],
            normal[2] * reference[0] - normal[0] * reference[2],
            normal[0] * reference[1] - normal[1] * reference[0],
        )
        basis_length = math.sqrt(sum(component * component for component in first_basis))
        first_basis = tuple(component / basis_length for component in first_basis)
        second_basis = (
            normal[1] * first_basis[2] - normal[2] * first_basis[1],
            normal[2] * first_basis[0] - normal[0] * first_basis[2],
            normal[0] * first_basis[1] - normal[1] * first_basis[0],
        )
        radius = diagonal * 2.0
        plane_surfaces = []
        for plane in split_planes:
            point = plane["pointMm"]
            plane_points = []
            for first_sign, second_sign in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                coordinates = [point[axis] + radius * (first_sign * first_basis[axis] + second_sign * second_basis[axis]) for axis in range(3)]
                plane_points.append(gmsh.model.occ.addPoint(*coordinates))
            plane_lines = [gmsh.model.occ.addLine(plane_points[index], plane_points[(index + 1) % 4]) for index in range(4)]
            plane_surface = gmsh.model.occ.addPlaneSurface([gmsh.model.occ.addCurveLoop(plane_lines)])
            plane_surfaces.append((2, plane_surface))
        gmsh.model.occ.fragment([volumes[0]], plane_surfaces, removeObject=True, removeTool=True)
        gmsh.model.occ.synchronize()
        split_volumes = gmsh.model.getEntities(3)
        expected_volume_count = len(split_planes) + 1
        if len(split_volumes) != expected_volume_count:
            fail(f"split planes must divide the input Solid into exactly {expected_volume_count} regions, found {len(split_volumes)}")
        signed_centers = [
            sum(gmsh.model.occ.getCenterOfMass(*entity)[axis] * normal[axis] for axis in range(3))
            for entity in split_volumes
        ]
        split_volumes = [entity for _, entity in sorted(zip(signed_centers, split_volumes), key=lambda pair: pair[0])]
        signed_centers = sorted(signed_centers)
        plane_offsets = [sum(plane["pointMm"][axis] * normal[axis] for axis in range(3)) for plane in split_planes]
        if any(not signed_centers[index] < plane_offsets[index] < signed_centers[index + 1] for index in range(len(split_planes))):
            fail("each split plane must separate adjacent nonzero regions in the requested order")
        boundaries = [
            {tag for dimension, tag in gmsh.model.getBoundary([entity], combined=False, oriented=False) if dimension == 2}
            for entity in split_volumes
        ]
        interface_groups = []
        all_interface_surfaces = set()
        for index, plane in enumerate(split_planes):
            point = plane["pointMm"]
            interface_surfaces = sorted(boundaries[index] & boundaries[index + 1])
            if not interface_surfaces:
                fail(f"split plane {index} produced no shared interface surface")
            for surface_tag in interface_surfaces:
                center = gmsh.model.occ.getCenterOfMass(2, surface_tag)
                distance = sum((center[axis] - point[axis]) * normal[axis] for axis in range(3))
                if abs(distance) > max(diagonal * 1e-8, 1e-7):
                    fail(f"shared region boundary for split plane {index} is not on the requested plane")
            if all_interface_surfaces.intersection(interface_surfaces):
                fail("one STEP surface was assigned to multiple split planes")
            all_interface_surfaces.update(interface_surfaces)
            interface_groups.append(interface_surfaces)

        surface_signatures = []
        for dimension, surface_tag in gmsh.model.getEntities(2):
            if gmsh.model.getType(dimension, surface_tag) != "Plane":
                continue
            center = [float(value) for value in gmsh.model.occ.getCenterOfMass(dimension, surface_tag)]
            surface_bounds = gmsh.model.occ.getBoundingBox(dimension, surface_tag)
            uv = gmsh.model.getParametrization(dimension, surface_tag, center)
            surface_normal = [float(value) for value in gmsh.model.getNormal(surface_tag, uv)]
            length = math.sqrt(sum(value * value for value in surface_normal))
            if length <= 1e-12:
                continue
            surface_normal = [value / length for value in surface_normal]
            surface_signatures.append({
                "entityTag": int(surface_tag), "center": center, "normal": surface_normal,
                "min": [float(value) for value in surface_bounds[:3]],
                "max": [float(value) for value in surface_bounds[3:]],
            })
        boundary_groups = []
        claimed_surfaces = set(all_interface_surfaces)
        for face in boundary_faces:
            candidates = []
            for surface in surface_signatures:
                if _boundary_face_matches_surface(face, surface):
                    candidates.append(surface)
            if len(candidates) != 1:
                fail(f"native boundary face {face['faceId']} maps to {len(candidates)} split STEP surfaces; only unsplit exact faces are supported")
            surface_tag = candidates[0]["entityTag"]
            if surface_tag in claimed_surfaces:
                fail(f"native boundary face {face['faceId']} maps to an already grouped split STEP surface")
            claimed_surfaces.add(surface_tag)
            boundary_groups.append({
                "faceId": face["faceId"], "physicalTag": face["physicalTag"],
                "name": f"GM{face['physicalTag']}", "surfaceEntityTag": surface_tag,
            })

        material_a_volumes = [volume[1] for index, volume in enumerate(split_volumes) if index % 2 == 0]
        material_b_volumes = [volume[1] for index, volume in enumerate(split_volumes) if index % 2 == 1]
        if layerwise_regions:
            for region_index, volume in enumerate(split_volumes):
                tag = layer_region_tags[region_index]
                gmsh.model.addPhysicalGroup(3, [volume[1]], tag)
                gmsh.model.setPhysicalName(3, tag, f"GM{tag}")
        else:
            for dimension, entities, tag, name in (
                # Keep names short and unique after Code_Aster's Gmsh group-name normalization.
                (3, material_a_volumes, material_a_tag, f"GM{material_a_tag}"),
                (3, material_b_volumes, material_b_tag, f"GM{material_b_tag}"),
            ):
                gmsh.model.addPhysicalGroup(dimension, entities, tag)
                gmsh.model.setPhysicalName(dimension, tag, name)
        for index, interface_surfaces in enumerate(interface_groups):
            tag = interface_surface_tags[index]
            gmsh.model.addPhysicalGroup(2, interface_surfaces, tag)
            gmsh.model.setPhysicalName(2, tag, f"INTERFACE_{tag}")
        for boundary in boundary_groups:
            gmsh.model.addPhysicalGroup(2, [boundary["surfaceEntityTag"]], boundary["physicalTag"])
            gmsh.model.setPhysicalName(2, boundary["physicalTag"], boundary["name"])

        gmsh.option.setNumber("Mesh.MeshSizeMin", float(mesh_size_mm) * 0.5)
        gmsh.option.setNumber("Mesh.MeshSizeMax", float(mesh_size_mm))
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.option.setNumber("Mesh.Algorithm3D", 10)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        gmsh.option.setNumber("Mesh.MaxNumThreads3D", 1)
        gmsh.model.mesh.generate(3)
        node_tags, _, _ = gmsh.model.mesh.getNodes()
        if not 4 <= len(node_tags) <= 1_000_000:
            fail(f"generated mesh node count is outside the supported range: {len(node_tags)}")
        tetrahedron_count = 0
        region_tetrahedron_counts = []
        for volume in split_volumes:
            element_types, element_tags, _ = gmsh.model.mesh.getElements(3, volume[1])
            if len(element_types) != 1 or int(element_types[0]) != 4:
                fail(f"expected first-order tetrahedra (Gmsh type 4), found {list(map(int, element_types))}")
            count = len(element_tags[0])
            region_tetrahedron_counts.append(count)
            tetrahedron_count += count
        if not 1 <= tetrahedron_count <= 500_000:
            fail(f"generated tetrahedron count is outside the supported range: {tetrahedron_count}")
        bounds_mm = {"min": minimum, "max": maximum}
        with tempfile.TemporaryDirectory(prefix="plasticity-cohesive-") as temp_directory:
            raw_mesh_path = os.path.join(temp_directory, "split.msh")
            gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
            gmsh.option.setNumber("Mesh.SaveAll", 0)
            gmsh.write(raw_mesh_path)
            raw_mesh = Path(raw_mesh_path).read_text(encoding="utf-8")
    finally:
        gmsh.finalize()

    if layerwise_regions:
        converted, summary = insert_cohesive_layer_regions(
            raw_mesh, layer_region_tags, interface_surface_tags, cohesive_volume_tag,
        )
    else:
        converted, summary = insert_cohesive_interfaces(
            raw_mesh, material_a_tag, material_b_tag, interface_surface_tags, cohesive_volume_tag,
        )
    with output_file.open("x", encoding="utf-8") as output:
        output.write(converted)
    layer_region_groups = [
        {"layerIndex": index + 1, "physicalTag": layer_region_tags[index], "name": f"GM{layer_region_tags[index]}", "tetrahedronCount": region_tetrahedron_counts[index]}
        for index in range(len(split_volumes))
    ] if layerwise_regions else None
    return {
        "gmshVersion": gmsh_version,
        "volumeCount": len(split_planes) + 1,
        "interfaceSurfaceCount": sum(len(group) for group in interface_groups),
        "boundsMm": bounds_mm,
        "splitPlanes": split_planes,
        "meshSizeMm": float(mesh_size_mm),
        "materialATag": material_a_tag,
        "materialBTag": material_b_tag,
        "layerwiseRegions": layerwise_regions,
        **({"layerRegionGroups": layer_region_groups} if layer_region_groups is not None else {}),
        "interfaceSurfaceTags": interface_surface_tags,
        "interfaceSurfaceGroups": [
            {
                "planeIndex": index, "physicalTag": interface_surface_tags[index],
                "surfaceEntityTags": group,
                "triangleCount": summary["interfaceTriangleCountsByTag"][str(interface_surface_tags[index])],
            }
            for index, group in enumerate(interface_groups)
        ],
        "cohesiveVolumeTag": cohesive_volume_tag,
        "boundaryGroups": boundary_groups,
        "outputPath": str(output_file),
        **summary,
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            fail("request must be an object")
        output_path = request.get("outputPath")
        if not isinstance(output_path, str) or not Path(output_path).is_absolute() or not output_path.lower().endswith(".msh"):
            fail("outputPath must be an absolute .msh file path")
        if "stepPath" in request:
            split_planes = request.get("splitPlanes")
            result = generate_cohesive_mesh_from_step(
                request.get("stepPath"), output_path, split_planes,
                request.get("meshSizeMm"),
                request.get("materialATag", 1), request.get("materialBTag", 2),
                request.get("interfaceSurfaceTag", 3), request.get("cohesiveVolumeTag"),
                request.get("boundaryFaces", []), request.get("layerwiseRegions", False),
            )
            print(json.dumps({"ok": True, **result}, separators=(",", ":")))
            return 0
        input_path = request.get("inputPath")
        if not isinstance(input_path, str) or not Path(input_path).is_absolute():
            fail("inputPath must be an absolute file path")
        input_file = Path(input_path)
        output_file = Path(output_path)
        if input_file.resolve() == output_file.resolve():
            fail("outputPath must be different from inputPath")
        if output_file.exists():
            fail("outputPath already exists; refusing to overwrite a mesh")
        source = input_file.read_text(encoding="utf-8")
        converted, summary = insert_cohesive_interface(
            source,
            request.get("materialATag"),
            request.get("materialBTag"),
            request.get("interfaceSurfaceTag"),
            request.get("cohesiveVolumeTag"),
        )
        with output_file.open("x", encoding="utf-8") as output:
            output.write(converted)
        print(json.dumps({"ok": True, "outputPath": output_path, **summary}, separators=(",", ":")))
        return 0
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
