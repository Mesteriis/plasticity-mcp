// Verified scalar enum contracts. Discovery must find a matching live object.
export const NATIVE_ENUM_CONTRACTS = {
  "CurveType": {
    "0": "Polyline",
    "1": "NURBS",
    "Polyline": 0,
    "NURBS": 1
  },
  "RebuildFaceMethod": {
    "0": "Refit",
    "1": "ExplicitControl",
    "Refit": 0,
    "ExplicitControl": 1
  },
  "TopologyLandmark": {
    "0": "Vertex",
    "1": "EdgeStart",
    "2": "EdgeQuarter",
    "3": "EdgeHalf",
    "4": "EdgeThreeQuarters",
    "5": "EdgeCenter",
    "6": "FaceCenter",
    "7": "Edge",
    "8": "Face",
    "9": "Body",
    "10": "TopAxis",
    "11": "MidAxis",
    "12": "BottomAxis",
    "Vertex": 0,
    "EdgeStart": 1,
    "EdgeQuarter": 2,
    "EdgeHalf": 3,
    "EdgeThreeQuarters": 4,
    "EdgeCenter": 5,
    "FaceCenter": 6,
    "Edge": 7,
    "Face": 8,
    "Body": 9,
    "TopAxis": 10,
    "MidAxis": 11,
    "BottomAxis": 12
  },
  "EvalSurfaceContinuityMeasurements_refresh": {
    "Incremental": 22562,
    "Samples": 100
  }
} as const;
