// This factory executes in the renderer. Keep it independent of host imports.
const accessFactory = `function(editor) {
  if (!editor.geo?.read?.geometryModel || editor.geo.geometryModel) {
    return { db: editor.db, geo: editor.geo, selection: editor.selection?.selected,
      bridgeVertex(_wire, vertex) { return vertex; },
      initializeBridge(factory, first, second, kind) {
        if (kind === 'vertex') { factory.vertex1 = first; factory.vertex2 = second; }
        else { factory.edge1 = first; factory.edge2 = second; factory.pickClosestVertices(); }
      },
      flipBridgeEnd(factory, end) { const key = 'side' + end; factory[key] = !factory[key]; },
      slideDirection(direction) { return direction; },
      slideDirections(factory) { return factory.orientation; },
      setCurveControlPoints(factory, vertices, cvs) {
        if (vertices.length) factory.vertices = vertices;
        if (cvs.length) factory.cvs = cvs;
      }
    };
  }
  const geometry = editor.geo;
  const selected = editor.selection?.selected;
  const selection = {};
  for (const name of ['addGroup', 'addEmpty', 'addCurve', 'addFace', 'addEdge', 'addCurveCV', 'addVertex', 'addMeasurement']) {
    selection[name] = item => selected.add(item);
  }
  return {
    selection,
    bridgeVertex(wire, vertex) {
      const expected = geometry.lookupTopologyItem(vertex).GetPoint();
      const matches = [];
      for (const segment of wire.segments) {
        const edge = geometry.lookupTopologyItem(segment);
        for (const t of [0, 1]) {
          const point = edge.GetPointAndTangent(t).position;
          if ((point.x - expected.x) ** 2 + (point.y - expected.y) ** 2 + (point.z - expected.z) ** 2 <= 1e-18) matches.push({ segment, t });
        }
      }
      if (matches.length !== 1) throw new Error('Native bridge vertex has no unique adjacent segment');
      return matches[0];
    },
    initializeBridge(factory, first, second, kind) {
      factory.start = kind === 'vertex' ? first.segment : first;
      factory.end = kind === 'vertex' ? second.segment : second;
      factory.trim = false;
      if (kind === 'vertex') { factory.t1 = first.t; factory.t2 = second.t; }
      else factory.pickClosestEnds();
      factory.pickClosestSenses();
    },
    flipBridgeEnd(factory, end) { const key = 't' + end; factory[key] = 1 - factory[key]; },
    // Live 26.2 native DirectionKind enum: PosU = 0, NegU = 1.
    slideDirection(direction) {
      if (direction === 'posU') return 0;
      if (direction === 'negU') return 1;
      throw new Error('Unsupported native slide direction');
    },
    slideDirections(factory) {
      const orientation = factory.orientation;
      return {
        posU: orientation.directions[orientation.directionKinds.indexOf(0)],
        negU: orientation.directions[orientation.directionKinds.indexOf(1)],
      };
    },
    setCurveControlPoints(factory, vertices, cvs) { factory.controlPoints = [...vertices, ...cvs]; },
    geo: {
      get geometryModel() { return geometry.read.geometryModel; },
      get automatics() { return geometry.read.automatics; },
      get primaryPartition() { return geometry.primaryPartition; },
      makeTemporary(...args) { return geometry.makeTemporary(...args); },
    },
    db: {
      get version() { return editor.db.version; },
      nodes: editor.nodes,
      groups: editor.groups,
      empties: editor.empties,
      materials: editor.materials,
      lookupStableId(...args) { return geometry.lookupStableId(...args); },
      lookupTopologyItem(...args) { return geometry.lookupTopologyItem(...args); },
      lookupBodyCollection(...args) { return geometry.lookupBodyCollection(...args); },
      lookupFaceCollection(...args) { return geometry.lookupFaceCollection(...args); },
      lookupEmptyById(...args) { return editor.empties.lookupById(...args); },
      makeTransaction(...args) { return editor.db.makeTransaction(...args); },
      commit: editor.db.commit.bind(editor.db),
    },
  };
}`;

/** A call-local API view; factories and commands still receive the real editor. */
export function nativeFunction(parts: TemplateStringsArray, ...values: unknown[]): string {
  const source = parts.reduce((text, part, index) => text + part + (index < values.length ? String(values[index]) : ""), "");
  return `function (...args) {
    const nativeApi = (${accessFactory})(this);
    return (${source}).apply(this, args);
  }`;
}
