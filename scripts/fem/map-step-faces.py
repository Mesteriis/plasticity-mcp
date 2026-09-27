#!/usr/bin/env python3
"""Strictly map selected native planar-face signatures to Gmsh STEP surfaces."""
import json
import math
import os
import sys

MAX_LAYERWISE_FEA_LAYERS = 256
MAX_LAYER_INTERFACE_PLANES = MAX_LAYERWISE_FEA_LAYERS - 1


def fail(message):
    raise ValueError(message)


def match_fragmented_face_surfaces(face, surfaces, tolerance):
    """Return every exact coplanar B-Rep patch that partitions one native planar face."""
    face_center = validate_vector(face.get("center"), "native face center")
    face_normal = validate_vector(face.get("normal"), "native face normal")
    face_min = validate_vector(face.get("min"), "native face minimum")
    face_max = validate_vector(face.get("max"), "native face maximum")
    face_area = face.get("areaMm2")
    if not isinstance(face_area, (int, float)) or isinstance(face_area, bool) or not math.isfinite(face_area) or face_area <= 0:
        fail("native face area is required to verify its fragmented STEP surfaces")
    normal_length = math.sqrt(sum(value * value for value in face_normal))
    if normal_length <= 1e-12:
        fail("native face normal must be nonzero")
    face_normal = [value / normal_length for value in face_normal]
    diagonal = math.sqrt(sum((face_max[axis] - face_min[axis]) ** 2 for axis in range(3)))
    candidates = []
    for surface in surfaces:
        center = surface["center"]
        normal = surface["normal"]
        bounds_min = surface["min"]
        bounds_max = surface["max"]
        if abs(sum((center[axis] - face_center[axis]) * face_normal[axis] for axis in range(3))) > tolerance:
            continue
        if sum(face_normal[axis] * normal[axis] for axis in range(3)) < 0.99999:
            continue
        if any(bounds_min[axis] < face_min[axis] - tolerance or bounds_max[axis] > face_max[axis] + tolerance for axis in range(3)):
            continue
        candidates.append(surface)
    if not candidates:
        fail(f"native face {face.get('faceId')} has no exact coplanar fragmented STEP surfaces")
    signatures = set()
    for surface in candidates:
        signature = tuple(round(value / max(tolerance, 1e-9)) for value in (
            *surface["center"], *surface["min"], *surface["max"], float(surface["areaMm2"]),
        ))
        if signature in signatures:
            fail(f"native face {face.get('faceId')} area does not cover unique fragmented STEP surfaces")
        signatures.add(signature)
    total_area = sum(float(surface["areaMm2"]) for surface in candidates)
    area_tolerance = max(tolerance * max(diagonal, 1.0) * 4.0, face_area * 1e-8)
    if abs(total_area - face_area) > area_tolerance:
        fail(f"native face {face.get('faceId')} fragmented STEP surface area does not cover the native face")
    return sorted(int(surface["entityTag"]) for surface in candidates)


def validate_vector(value, name):
    if not isinstance(value, list) or len(value) != 3:
        fail(f"{name} must be a 3-vector")
    if any(not isinstance(component, (int, float)) or not math.isfinite(component) for component in value):
        fail(f"{name} must contain finite numbers")
    return [float(component) for component in value]


def main():
    request = json.load(sys.stdin)
    step_path = request.get("stepPath")
    faces = request.get("faces")
    tolerance = request.get("toleranceMm", 0.0001)
    if not isinstance(step_path, str) or not step_path:
        fail("stepPath is required")
    if not isinstance(faces, list) or not 1 <= len(faces) <= 32:
        fail("faces must contain 1..32 selected native faces")
    if not isinstance(tolerance, (int, float)) or not math.isfinite(tolerance) or not 0 < tolerance <= 0.01:
        fail("toleranceMm must be finite and in (0, 0.01]")
    seen_ids = set()
    expected = []
    for face in faces:
        face_id = face.get("faceId")
        if not isinstance(face_id, str) or not face_id or face_id in seen_ids:
            fail("faceId values must be unique nonempty strings")
        seen_ids.add(face_id)
        if face.get("surfaceType") != "Plane":
            fail(f"face {face_id} is not a supported planar face")
        center = validate_vector(face.get("centerMm"), f"face {face_id} centerMm")
        normal = validate_vector(face.get("normal"), f"face {face_id} normal")
        magnitude = math.sqrt(sum(component * component for component in normal))
        if magnitude < 1e-12:
            fail(f"face {face_id} normal must be nonzero")
        normal = [component / magnitude for component in normal]
        bounds = face.get("boundsMm")
        if not isinstance(bounds, dict):
            fail(f"face {face_id} boundsMm is required")
        minimum = validate_vector(bounds.get("min"), f"face {face_id} boundsMm.min")
        maximum = validate_vector(bounds.get("max"), f"face {face_id} boundsMm.max")
        if any(minimum[index] > maximum[index] for index in range(3)):
            fail(f"face {face_id} has invalid bounds")
        expected.append({"faceId": face_id, "center": center, "normal": normal, "min": minimum, "max": maximum})

    import gmsh

    if not gmsh.__version__.startswith("4.15."):
        fail(f"Gmsh 4.15.x is required; found {gmsh.__version__}")
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("plasticity-step-face-map")
        gmsh.model.occ.importShapes(step_path)
        gmsh.model.occ.synchronize()
        volumes = gmsh.model.getEntities(3)
        if len(volumes) != 1:
            fail(f"expected exactly one imported Solid, found {len(volumes)} volumes")

        surfaces = []
        for dimension, tag in gmsh.model.getEntities(2):
            if gmsh.model.getType(dimension, tag) != "Plane":
                continue
            center = [float(value) for value in gmsh.model.occ.getCenterOfMass(dimension, tag)]
            bounds = gmsh.model.occ.getBoundingBox(dimension, tag)
            uv = gmsh.model.getParametrization(dimension, tag, center)
            normal = [float(value) for value in gmsh.model.getNormal(tag, uv)]
            normal_length = math.sqrt(sum(component * component for component in normal))
            if normal_length < 1e-12:
                continue
            normal = [component / normal_length for component in normal]
            surfaces.append({
                "entityTag": int(tag),
                "center": center,
                "normal": normal,
                "min": [float(value) for value in bounds[:3]],
                "max": [float(value) for value in bounds[3:]],
                "areaMm2": float(gmsh.model.occ.getMass(dimension, tag)),
            })

        mappings = []
        claimed = set()
        cosine_tolerance = 0.99999
        for face in expected:
            candidates = []
            for surface in surfaces:
                linear_error = max(
                    [abs(face["center"][axis] - surface["center"][axis]) for axis in range(3)]
                    + [abs(face["min"][axis] - surface["min"][axis]) for axis in range(3)]
                    + [abs(face["max"][axis] - surface["max"][axis]) for axis in range(3)]
                )
                normal_dot = sum(face["normal"][axis] * surface["normal"][axis] for axis in range(3))
                if linear_error <= tolerance and normal_dot >= cosine_tolerance:
                    candidates.append((surface, linear_error, normal_dot))
            if len(candidates) != 1:
                fail(f"native face {face['faceId']} maps to {len(candidates)} STEP surfaces; refusing ambiguous mapping")
            surface, linear_error, normal_dot = candidates[0]
            if surface["entityTag"] in claimed:
                fail(f"multiple native faces map to STEP surface {surface['entityTag']}")
            claimed.add(surface["entityTag"])
            mappings.append({
                "faceId": face["faceId"],
                "surfaceEntityTag": surface["entityTag"],
                "surfaceType": "Plane",
                "centerMm": surface["center"],
                "normal": surface["normal"],
                "boundsMm": {"min": surface["min"], "max": surface["max"]},
                "areaMm2": surface["areaMm2"],
                "maxSignatureErrorMm": linear_error,
                "normalDot": normal_dot,
            })
        response = {
            "schemaVersion": 1,
            "gmshVersion": gmsh.__version__,
            "volumeCount": len(volumes),
            "surfaceCount": len(gmsh.model.getEntities(2)),
            "toleranceMm": tolerance,
            "mappings": mappings,
        }
        mesh_request = request.get("mesh")
        if mesh_request is not None:
            response["mesh"] = write_calculix_mesh(gmsh, volumes[0][1], [dict(mapping) for mapping in mappings], mesh_request)
        print(json.dumps(response, separators=(",", ":")))
    finally:
        gmsh.finalize()


def cross3(first, second):
    return [
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
    ]


def triangle_barycentric(point, triangle):
    first = [triangle[1][axis] - triangle[0][axis] for axis in range(3)]
    second = [triangle[2][axis] - triangle[0][axis] for axis in range(3)]
    relative = [point[axis] - triangle[0][axis] for axis in range(3)]
    d00 = sum(value * value for value in first)
    d01 = sum(first[axis] * second[axis] for axis in range(3))
    d11 = sum(value * value for value in second)
    d20 = sum(relative[axis] * first[axis] for axis in range(3))
    d21 = sum(relative[axis] * second[axis] for axis in range(3))
    denominator = d00 * d11 - d01 * d01
    if denominator <= 1e-24:
        return [0.0, 0.0, 0.0], math.inf
    second_weight = (d11 * d20 - d01 * d21) / denominator
    third_weight = (d00 * d21 - d01 * d20) / denominator
    weights = [1.0 - second_weight - third_weight, second_weight, third_weight]
    closest = [sum(weights[index] * triangle[index][axis] for index in range(3)) for axis in range(3)]
    distance = math.sqrt(sum((point[axis] - closest[axis]) ** 2 for axis in range(3)))
    return weights, distance


def solve_3x3(matrix, vector):
    augmented = [list(matrix[row]) + [vector[row]] for row in range(3)]
    for column in range(3):
        pivot = max(range(column, 3), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) <= 1e-14:
            fail("selected loaded face mesh is degenerate for the requested free moment")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        scale = augmented[column][column]
        augmented[column] = [value / scale for value in augmented[column]]
        for row in range(3):
            if row == column:
                continue
            scale = augmented[row][column]
            augmented[row] = [augmented[row][index] - scale * augmented[column][index] for index in range(4)]
    return [augmented[row][3] for row in range(3)]


def equivalent_couple_forces(node_ids, node_xyz, moment):
    centroid = [sum(node_xyz[node][axis] for node in node_ids) / len(node_ids) for axis in range(3)]
    levers = [[node_xyz[node][axis] - centroid[axis] for axis in range(3)] for node in node_ids]
    matrix = [[sum((sum(value * value for value in lever) if row == column else 0.0) - lever[row] * lever[column] for lever in levers) for column in range(3)] for row in range(3)]
    couple_vector = solve_3x3(matrix, moment)
    return {node_id: cross3(couple_vector, lever) for node_id, lever in zip(node_ids, levers)}


def assign_code_aster_physical_groups(gmsh, volume_tag, mappings, requested_face_ids):
    mapping_by_id = {item["faceId"]: item for item in mappings}
    if len(set(requested_face_ids)) != len(requested_face_ids):
        fail("Code_Aster face groups must be unique")
    if any(face_id not in mapping_by_id for face_id in requested_face_ids):
        fail("a selected Code_Aster face has no exact STEP mapping")

    groups = []
    volume_tags = volume_tag if isinstance(volume_tag, list) else [volume_tag]
    solid_tag = gmsh.model.addPhysicalGroup(3, volume_tags, 1)
    solid_name = f"GM{solid_tag}"
    gmsh.model.setPhysicalName(3, solid_tag, solid_name)
    groups.append({"dimension": 3, "tag": solid_tag, "name": solid_name, "faceId": None})
    for index, face_id in enumerate(requested_face_ids, start=1):
        # Gmsh physical tags are scoped by dimension; Code_Aster's legacy MSH
        # reader may flatten them, so keep face tags distinct from SOLID's tag.
        physical_tag = 1000 + index
        tag = gmsh.model.addPhysicalGroup(2, mapping_surface_tags(mapping_by_id[face_id]), physical_tag)
        # Code_Aster 15.2's legacy Gmsh reader exposes groups as GM<tag>;
        # it does not preserve Gmsh PhysicalNames as solver group names.
        name = f"GM{physical_tag}"
        gmsh.model.setPhysicalName(2, tag, name)
        groups.append({"dimension": 2, "tag": tag, "name": name, "faceId": face_id})
    return groups


def mapping_surface_tags(mapping):
    tags = mapping.get("surfaceEntityTags")
    if tags is None:
        tags = [mapping["surfaceEntityTag"]]
    if not isinstance(tags, list) or not tags or any(not isinstance(tag, int) or tag <= 0 for tag in tags):
        fail(f"native face {mapping.get('faceId')} has invalid mapped STEP surface tags")
    return tags


def mapped_surface_triangles(gmsh, mapping, face_id):
    triangles = []
    for entity_tag in mapping_surface_tags(mapping):
        element_types, element_tag_blocks, element_node_blocks = gmsh.model.mesh.getElements(2, entity_tag)
        if len(element_types) != 1 or int(element_types[0]) != 2:
            fail(f"mapped face {face_id} must have first-order triangular facets")
        tags = element_tag_blocks[0]
        flat_nodes = element_node_blocks[0]
        if len(flat_nodes) != 3 * len(tags):
            fail(f"mapped face {face_id} has invalid triangular connectivity")
        triangles.extend(tuple(int(flat_nodes[index * 3 + offset]) for offset in range(3)) for index in range(len(tags)))
    if not triangles:
        fail(f"mapped face {face_id} has no triangular facets")
    return triangles


def mapped_surface_node_ids(gmsh, mapping):
    nodes = set()
    for entity_tag in mapping_surface_tags(mapping):
        tags, _, _ = gmsh.model.mesh.getNodes(2, entity_tag, True, False)
        nodes.update(int(tag) for tag in tags)
    return sorted(nodes)


def fragment_volume_into_layer_regions(gmsh, volume_tag, mappings, split_planes, tolerance):
    if not isinstance(split_planes, list) or not 1 <= len(split_planes) <= MAX_LAYER_INTERFACE_PLANES:
        fail(f"layer split planes must contain 1..{MAX_LAYER_INTERFACE_PLANES} planes")
    if not isinstance(tolerance, (int, float)) or isinstance(tolerance, bool) or not math.isfinite(tolerance) or not 0 < tolerance <= 0.01:
        fail("mappingToleranceMm must be finite and in (0, 0.01]")
    planes = []
    for index, plane in enumerate(split_planes):
        if not isinstance(plane, dict):
            fail(f"layer split plane {index} must be an object")
        point = validate_vector(plane.get("pointMm"), f"layer split plane {index} pointMm")
        normal = validate_vector(plane.get("normalGlobal"), f"layer split plane {index} normalGlobal")
        length = math.sqrt(sum(value * value for value in normal))
        if abs(length - 1.0) > 1e-6:
            fail(f"layer split plane {index} normalGlobal must be a unit vector")
        normal = [value / length for value in normal]
        if planes and sum(planes[0]["normalGlobal"][axis] * normal[axis] for axis in range(3)) < 1 - 1e-9:
            fail("layer split planes must have parallel normals pointing in the same direction")
        offset = sum(point[axis] * normal[axis] for axis in range(3))
        if planes and offset <= planes[-1]["offset"] + 1e-9:
            fail("layer split planes must be ordered and separated")
        planes.append({"pointMm": point, "normalGlobal": normal, "offset": offset})

    bounds = gmsh.model.occ.getBoundingBox(3, volume_tag)
    minimum = [float(bounds[axis]) for axis in range(3)]
    maximum = [float(bounds[axis + 3]) for axis in range(3)]
    diagonal = math.sqrt(sum((maximum[axis] - minimum[axis]) ** 2 for axis in range(3)))
    if diagonal <= 1e-12:
        fail("input Solid has degenerate bounds")
    normal = planes[0]["normalGlobal"]
    axes = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    reference = min(axes, key=lambda axis: abs(sum(axis[index] * normal[index] for index in range(3))))
    first_basis = [normal[1] * reference[2] - normal[2] * reference[1], normal[2] * reference[0] - normal[0] * reference[2], normal[0] * reference[1] - normal[1] * reference[0]]
    basis_length = math.sqrt(sum(value * value for value in first_basis))
    first_basis = [value / basis_length for value in first_basis]
    second_basis = [normal[1] * first_basis[2] - normal[2] * first_basis[1], normal[2] * first_basis[0] - normal[0] * first_basis[2], normal[0] * first_basis[1] - normal[1] * first_basis[0]]
    radius = diagonal * 2
    plane_surfaces = []
    for plane in planes:
        corners = []
        for first_sign, second_sign in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            xyz = [plane["pointMm"][axis] + radius * (first_sign * first_basis[axis] + second_sign * second_basis[axis]) for axis in range(3)]
            corners.append(gmsh.model.occ.addPoint(*xyz))
        lines = [gmsh.model.occ.addLine(corners[index], corners[(index + 1) % 4]) for index in range(4)]
        surface = gmsh.model.occ.addPlaneSurface([gmsh.model.occ.addCurveLoop(lines)])
        plane_surfaces.append((2, surface))
    gmsh.model.occ.fragment([(3, volume_tag)], plane_surfaces, removeObject=True, removeTool=True)
    gmsh.model.occ.synchronize()

    volumes = gmsh.model.getEntities(3)
    if len(volumes) != len(planes) + 1:
        fail(f"layer planes must divide the Solid into exactly {len(planes) + 1} regions; found {len(volumes)}")
    signed_centers = [(sum(gmsh.model.occ.getCenterOfMass(*entity)[axis] * normal[axis] for axis in range(3)), entity) for entity in volumes]
    volumes = [entity for _center, entity in sorted(signed_centers, key=lambda item: item[0])]
    centers = [center for center, _entity in sorted(signed_centers, key=lambda item: item[0])]
    if any(not centers[index] < plane["offset"] < centers[index + 1] for index, plane in enumerate(planes)):
        fail("each layer plane must separate adjacent nonzero Solid regions")
    for index in range(len(planes)):
        lower = {tag for dim, tag in gmsh.model.getBoundary([volumes[index]], combined=False, oriented=False) if dim == 2}
        upper = {tag for dim, tag in gmsh.model.getBoundary([volumes[index + 1]], combined=False, oriented=False) if dim == 2}
        if not lower.intersection(upper):
            fail(f"layer plane {index + 1} did not produce a shared conformal interface")

    signatures = []
    for dimension, tag in gmsh.model.getEntities(2):
        if gmsh.model.getType(dimension, tag) != "Plane":
            continue
        center = [float(value) for value in gmsh.model.occ.getCenterOfMass(dimension, tag)]
        surface_bounds = gmsh.model.occ.getBoundingBox(dimension, tag)
        uv = gmsh.model.getParametrization(dimension, tag, center)
        surface_normal = [float(value) for value in gmsh.model.getNormal(tag, uv)]
        length = math.sqrt(sum(value * value for value in surface_normal))
        if length <= 1e-12:
            continue
        signatures.append({
            "entityTag": int(tag), "center": center,
            "normal": [value / length for value in surface_normal],
            "min": [float(value) for value in surface_bounds[:3]],
            "max": [float(value) for value in surface_bounds[3:]],
            "areaMm2": float(gmsh.model.occ.getMass(dimension, tag)),
        })
    claimed = set()
    for mapping in mappings:
        face = {
            "faceId": mapping["faceId"], "center": mapping["centerMm"],
            "normal": mapping["normal"], "min": mapping["boundsMm"]["min"],
            "max": mapping["boundsMm"]["max"], "areaMm2": mapping["areaMm2"],
        }
        tags = match_fragmented_face_surfaces(face, signatures, tolerance)
        if claimed.intersection(tags):
            fail(f"native face {mapping['faceId']} overlaps another mapped native boundary face after layer splitting")
        claimed.update(tags)
        mapping["surfaceEntityTags"] = tags
    return [entity[1] for entity in volumes], [
        {"layerIndex": index + 1, "elsetName": f"LAYER_{index + 1}", "tetrahedronCount": 0}
        for index in range(len(volumes))
    ]


def write_calculix_mesh(gmsh, volume_tag, mappings, mesh_request):
    size_mm = mesh_request.get("meshSizeMm")
    output_path = mesh_request.get("outputPath")
    quality_output_path = mesh_request.get("elementSICNOutputPath")
    code_aster_output_path = mesh_request.get("codeAsterOutputPath")
    requested_face_ids = mesh_request.get("nodeSetFaceIds")
    requested_loads = mesh_request.get("surfaceLoads", [])
    requested_resultants = mesh_request.get("resultantLoads", [])
    if not isinstance(size_mm, (int, float)) or not math.isfinite(size_mm) or not 0 < size_mm <= 100:
        fail("meshSizeMm must be finite and in (0, 100]")
    if not isinstance(output_path, str) or not os.path.isabs(output_path):
        fail("mesh outputPath must be absolute")
    if not isinstance(quality_output_path, str) or not os.path.isabs(quality_output_path):
        fail("elementSICNOutputPath must be absolute")
    if code_aster_output_path is not None and (not isinstance(code_aster_output_path, str)
                                               or not os.path.isabs(code_aster_output_path)
                                               or not code_aster_output_path.lower().endswith(".msh")):
        fail("codeAsterOutputPath must be an absolute .msh path")
    if not isinstance(requested_face_ids, list) or not requested_face_ids:
        fail("nodeSetFaceIds must name at least one mapped face")
    if len(set(requested_face_ids)) != len(requested_face_ids):
        fail("nodeSetFaceIds must be unique")
    if not isinstance(requested_loads, list) or len(requested_loads) > 32:
        fail("surfaceLoads must contain at most 32 face tractions")
    if not isinstance(requested_resultants, list) or len(requested_resultants) > 32:
        fail("resultantLoads must contain at most 32 face force/moment loads")
    mapping_by_id = {item["faceId"]: item for item in mappings}
    if any(face_id not in mapping_by_id for face_id in requested_face_ids):
        fail("every requested face node set must have an exact native-to-STEP mapping")
    seen_resultant_faces = set()
    for load in requested_resultants:
        if not isinstance(load, dict):
            fail("each resultant load must be an object")
        face_id = load.get("faceId")
        if not isinstance(face_id, str) or face_id not in mapping_by_id or face_id not in requested_face_ids or face_id in seen_resultant_faces:
            fail("resultant-load face IDs must be mapped node-set faces and unique")
        force = validate_vector(load.get("forceN"), f"resultant load {face_id} forceN")
        point = validate_vector(load.get("applicationPointMm"), f"resultant load {face_id} applicationPointMm")
        moment = validate_vector(load.get("momentNmm"), f"resultant load {face_id} momentNmm")
        if not any(force) and not any(moment):
            fail("each resultant load must contain a nonzero force or moment")
        seen_resultant_faces.add(face_id)
    if (os.path.exists(output_path) or os.path.exists(quality_output_path)
            or (code_aster_output_path is not None and os.path.exists(code_aster_output_path))):
        fail("mesh or SICN output already exists; refusing overwrite")

    volume_tags = [volume_tag]
    layer_region_groups = []
    split_planes = mesh_request.get("layerSplitPlanes")
    if split_planes is not None:
        volume_tags, layer_region_groups = fragment_volume_into_layer_regions(
            gmsh, volume_tag, mappings, split_planes, mesh_request.get("mappingToleranceMm", 1e-4),
        )

    gmsh.option.setNumber("Mesh.MeshSizeMin", float(size_mm) * 0.5)
    gmsh.option.setNumber("Mesh.MeshSizeMax", float(size_mm))
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.option.setNumber("Mesh.Algorithm3D", 10)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
    gmsh.option.setNumber("Mesh.MaxNumThreads3D", 1)
    gmsh.model.mesh.generate(3)

    node_tags, coordinates, _ = gmsh.model.mesh.getNodes()
    if not 4 <= len(node_tags) <= 1_000_000:
        fail(f"generated mesh node count is outside the supported range: {len(node_tags)}")
    node_xyz = {}
    for index, tag in enumerate(node_tags):
        offset = index * 3
        node_xyz[int(tag)] = [float(coordinates[offset + axis]) for axis in range(3)]

    element_tags = []
    connectivities = []
    layer_element_ids = []
    for region_index, region_volume_tag in enumerate(volume_tags):
        element_types, element_tag_blocks, element_node_blocks = gmsh.model.mesh.getElements(3, region_volume_tag)
        if len(element_types) != 1 or int(element_types[0]) != 4:
            fail(f"expected first-order 4-node tetrahedra (Gmsh type 4), found {list(map(int, element_types))}")
        region_tags = [int(value) for value in element_tag_blocks[0]]
        flat_nodes = element_node_blocks[0]
        if len(flat_nodes) != len(region_tags) * 4:
            fail(f"generated layer {region_index + 1} tetrahedron connectivity is invalid")
        region_connectivities = [tuple(int(flat_nodes[index * 4 + offset]) for offset in range(4)) for index in range(len(region_tags))]
        layer_element_ids.append(region_tags)
        element_tags.extend(region_tags)
        connectivities.extend(region_connectivities)
        if layer_region_groups:
            layer_region_groups[region_index]["tetrahedronCount"] = len(region_tags)
    if not 1 <= len(element_tags) <= 500_000:
        fail(f"generated tetrahedron count is outside the supported range: {len(element_tags)}")
    if any(any(node not in node_xyz for node in nodes) for nodes in connectivities):
        fail("generated tetrahedron references a missing mesh node")
    qualities = [float(value) for value in gmsh.model.mesh.getElementQualities(element_tags, "minSICN")]
    if len(qualities) != len(element_tags) or any(not math.isfinite(value) or value > 1 + 1e-12 for value in qualities):
        fail("Gmsh returned invalid tetrahedron quality values")
    # SICN is bounded by 1; normalize tiny floating-point overshoot from Gmsh.
    qualities = [min(value, 1.0) for value in qualities]
    minimum_quality = min(qualities)
    if minimum_quality <= 0:
        fail(f"generated mesh contains an inverted or degenerate tetrahedron (minSICN={minimum_quality})")
    ordered_qualities = sorted(qualities)
    quality_p05 = ordered_qualities[max(0, math.ceil(0.05 * len(ordered_qualities)) - 1)]
    middle = len(ordered_qualities) // 2
    median_quality = ordered_qualities[middle] if len(ordered_qualities) % 2 else (ordered_qualities[middle - 1] + ordered_qualities[middle]) / 2
    minimum_quality_index = qualities.index(minimum_quality)
    minimum_quality_element_id = element_tags[minimum_quality_index]
    minimum_quality_nodes = connectivities[minimum_quality_index]
    minimum_quality_centroid = [
        sum(node_xyz[node][axis] for node in minimum_quality_nodes) / 4
        for axis in range(3)
    ]

    node_sets = []
    claimed_nodes = {}
    for index, face_id in enumerate(requested_face_ids, start=1):
        ids = set()
        for entity_tag in mapping_surface_tags(mapping_by_id[face_id]):
            face_nodes, _, _ = gmsh.model.mesh.getNodes(2, entity_tag, True, False)
            ids.update(int(value) for value in face_nodes)
        ids = sorted(ids)
        if not ids or any(node not in node_xyz for node in ids):
            fail(f"mapped face {face_id} produced an empty or invalid mesh-node set")
        node_sets.append({"faceId": face_id, "setName": f"FACE_{index}", "nodeIds": ids})
        for node in ids:
            claimed_nodes.setdefault(node, []).append(face_id)

    output_load_path = mesh_request.get("loadOutputPath")
    if requested_loads or requested_resultants:
        if not isinstance(output_load_path, str) or not output_load_path or os.path.exists(output_load_path):
            fail("a new loadOutputPath is required for applied loads")
    elif output_load_path is not None:
        fail("loadOutputPath is only valid when applied loads are requested")
    seen_load_faces = set()
    nodal_forces = {}
    surface_loads = []
    resultant_loads = []
    total_resultant = [0.0, 0.0, 0.0]
    total_resultant_moment = [0.0, 0.0, 0.0]
    for load in requested_loads:
        if not isinstance(load, dict):
            fail("each surface load must be an object")
        face_id = load.get("faceId")
        traction = load.get("tractionNPerMm2")
        if not isinstance(face_id, str) or face_id not in mapping_by_id or face_id in seen_load_faces:
            fail("surface load face IDs must be mapped and unique")
        if not isinstance(traction, list) or len(traction) != 3 or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in traction):
            fail("tractionNPerMm2 must be a finite three-vector")
        if math.sqrt(sum(value * value for value in traction)) <= 0:
            fail("tractionNPerMm2 must be nonzero")
        seen_load_faces.add(face_id)
        triangles = mapped_surface_triangles(gmsh, mapping_by_id[face_id], face_id)
        face_area = 0.0
        face_moment = [0.0, 0.0, 0.0]
        loaded_nodes = set()
        for ids in triangles:
            if any(node not in node_xyz for node in ids):
                fail(f"surface load face {face_id} references a missing volume-mesh node")
            points = [node_xyz[node] for node in ids]
            first = [points[1][axis] - points[0][axis] for axis in range(3)]
            second = [points[2][axis] - points[0][axis] for axis in range(3)]
            cross = [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]]
            area = 0.5 * math.sqrt(sum(value * value for value in cross))
            if not math.isfinite(area) or area <= 0:
                fail(f"surface load face {face_id} contains a degenerate triangle")
            face_area += area
            for node in ids:
                loaded_nodes.add(node)
                forces = nodal_forces.setdefault(node, [0.0, 0.0, 0.0])
                for axis in range(3):
                    forces[axis] += float(traction[axis]) * area / 3.0
            triangle_center = [sum(point[axis] for point in points) / 3.0 for axis in range(3)]
            triangle_resultant = [float(traction[axis]) * area for axis in range(3)]
            triangle_moment = cross3(triangle_center, triangle_resultant)
            for axis in range(3):
                face_moment[axis] += triangle_moment[axis]
        resultant = [float(traction[axis]) * face_area for axis in range(3)]
        for axis in range(3):
            total_resultant[axis] += resultant[axis]
            total_resultant_moment[axis] += face_moment[axis]
        surface_loads.append({"faceId": face_id, "surfaceAreaMm2": face_area, "tractionNPerMm2": [float(value) for value in traction], "resultantN": resultant, "resultantMomentNmm": face_moment, "loadedNodeCount": len(loaded_nodes)})

    for load in requested_resultants:
        face_id = load["faceId"]
        force = load["forceN"]
        point = load["applicationPointMm"]
        moment = load["momentNmm"]
        triangles = mapped_surface_triangles(gmsh, mapping_by_id[face_id], face_id)
        located = None
        for ids in triangles:
            triangle = [node_xyz[node] for node in ids]
            weights, distance = triangle_barycentric(point, triangle)
            if distance <= 1e-6 and min(weights) >= -1e-8 and max(weights) <= 1.0 + 1e-8:
                weights = [max(0.0, value) for value in weights]
                weight_sum = sum(weights)
                located = (ids, [value / weight_sum for value in weights])
                break
        if located is None:
            fail(f"resultant load point for face {face_id} must lie on its triangulated face within 0.000001 mm")
        ids, weights = located
        for node_id, weight in zip(ids, weights):
            nodal = nodal_forces.setdefault(node_id, [0.0, 0.0, 0.0])
            for axis in range(3):
                nodal[axis] += force[axis] * weight

        if any(moment):
            unique_nodes = mapped_surface_node_ids(gmsh, mapping_by_id[face_id])
            for node_id, couple_force in equivalent_couple_forces(unique_nodes, node_xyz, moment).items():
                nodal = nodal_forces.setdefault(node_id, [0.0, 0.0, 0.0])
                for axis in range(3):
                    nodal[axis] += couple_force[axis]

        applied_moment = [left + right for left, right in zip(cross3(point, force), moment)]
        for axis in range(3):
            total_resultant[axis] += force[axis]
            total_resultant_moment[axis] += applied_moment[axis]
        resultant_loads.append({"faceId": face_id, "forceN": force, "applicationPointMm": point, "momentNmm": moment, "appliedMomentAtOriginNmm": applied_moment})

    discrete_resultant = [sum(force[axis] for force in nodal_forces.values()) for axis in range(3)]
    discrete_moment = [sum(cross3(node_xyz[node_id], force)[axis] for node_id, force in nodal_forces.items()) for axis in range(3)]
    if any(abs(discrete_resultant[axis] - total_resultant[axis]) > max(1e-6, abs(total_resultant[axis]) * 1e-9) for axis in range(3)):
        fail("equivalent nodal loads do not preserve the requested total force")
    if any(abs(discrete_moment[axis] - total_resultant_moment[axis]) > max(1e-6, abs(total_resultant_moment[axis]) * 1e-9) for axis in range(3)):
        fail("equivalent nodal loads do not preserve the requested total moment")

    lines = ["*NODE"]
    for node_id in sorted(node_xyz):
        x, y, z = node_xyz[node_id]
        lines.append(f"{node_id}, {x:.15g}, {y:.15g}, {z:.15g}")
    lines.append("*ELEMENT, TYPE=C3D4, ELSET=SOLID")
    for element_id, nodes in zip(element_tags, connectivities):
        lines.append(f"{element_id}, {nodes[0]}, {nodes[1]}, {nodes[2]}, {nodes[3]}")
    for region, region_ids in zip(layer_region_groups, layer_element_ids):
        lines.append(f"*ELSET, ELSET={region['elsetName']}")
        for offset in range(0, len(region_ids), 16):
            lines.append(", ".join(str(element_id) for element_id in region_ids[offset:offset + 16]))
    for item in node_sets:
        lines.append(f"*NSET, NSET={item['setName']}")
        ids = item["nodeIds"]
        for offset in range(0, len(ids), 16):
            lines.append(", ".join(str(node) for node in ids[offset:offset + 16]))
    output_created = False
    quality_output_created = False
    load_output_created = False
    code_aster_output_created = False
    code_aster_groups = []
    try:
        if requested_loads or requested_resultants:
            with open(output_load_path, "x", encoding="ascii") as load_output:
                load_output_created = True
                load_lines = ["*CLOAD"]
                for node in sorted(nodal_forces):
                    for axis, value in enumerate(nodal_forces[node], start=1):
                        if abs(value) > 1e-15:
                            load_lines.append(f"{node}, {axis}, {value:.15g}")
                load_output.write("\n".join(load_lines) + "\n")
        with open(output_path, "x", encoding="ascii") as output:
            output_created = True
            output.write("\n".join(lines) + "\n")
        with open(quality_output_path, "x", encoding="ascii") as quality_output:
            quality_output_created = True
            quality_output.write("elementId,minSICN\n")
            quality_output.writelines(f"{element_id},{quality:.17g}\n" for element_id, quality in zip(element_tags, qualities))
        if code_aster_output_path is not None:
            code_aster_groups = assign_code_aster_physical_groups(gmsh, volume_tags, mappings, requested_face_ids)
            gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
            gmsh.option.setNumber("Mesh.SaveAll", 0)
            code_aster_output_created = True
            gmsh.write(code_aster_output_path)
    except Exception:
        if output_created and os.path.exists(output_path):
            os.unlink(output_path)
        if quality_output_created and os.path.exists(quality_output_path):
            os.unlink(quality_output_path)
        if load_output_created and os.path.exists(output_load_path):
            os.unlink(output_load_path)
        if code_aster_output_created and os.path.exists(code_aster_output_path):
            os.unlink(code_aster_output_path)
        raise

    volume_bounds = [gmsh.model.occ.getBoundingBox(3, tag) for tag in volume_tags]
    bounds = [min(bound[axis] for bound in volume_bounds) for axis in range(3)] + [max(bound[axis + 3] for bound in volume_bounds) for axis in range(3)]
    return {
        "meshFile": output_path,
        **({
            "codeAsterMeshFile": code_aster_output_path,
            "codeAsterMeshFormat": "GMSH-2.2",
            "codeAsterPhysicalGroups": code_aster_groups,
        } if code_aster_output_path is not None else {}),
        "elementSICNFile": quality_output_path,
        "meshSizeMm": float(size_mm),
        "elementFamily": "C3D4",
        "nodeCount": len(node_tags),
        "tetrahedronCount": len(element_tags),
        "minimumScaledInverseConditionNumber": minimum_quality,
        "minimumSICNElementId": minimum_quality_element_id,
        "minimumSICNElementCentroidMm": minimum_quality_centroid,
        "fifthPercentileSampledSICN": quality_p05,
        "medianSampledSICN": median_quality,
        "boundsMm": {"min": [float(value) for value in bounds[:3]], "max": [float(value) for value in bounds[3:]]},
        "nodeSets": [{"faceId": item["faceId"], "setName": item["setName"], "nodeCount": len(item["nodeIds"])} for item in node_sets],
        "sharedSurfaceNodeCount": sum(1 for memberships in claimed_nodes.values() if len(memberships) > 1),
        "loadFile": output_load_path if requested_loads or requested_resultants else None,
        "surfaceLoads": surface_loads,
        "resultantLoads": resultant_loads,
        "totalResultantN": total_resultant,
        "totalResultantMomentNmm": total_resultant_moment,
        **({"layerRegionGroups": layer_region_groups} if layer_region_groups else {}),
    }


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(2)
