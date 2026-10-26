import assert from "node:assert/strict";
import test from "node:test";
import { verifyNativeBoxGeometry } from "./native-box-geometry.ts";
import type { RuntimeState } from "../src/plasticity/runtime.ts";

function box() {
  const size = [10,20,30];
  const vertices = Array.from({length:8},(_,id) => ({ id, positionMm: size.map((value,axis) => id & (1<<axis) ? value : 0) }));
  const edges = [];
  for (let a=0;a<8;a++) for(let axis=0;axis<3;axis++) {
    const b=a^(1<<axis); if(b>a) edges.push({id:`e${edges.length}`,curveType:"Line",vertexIds:[a,b],lengthMm:size[axis]});
  }
  const faces: Array<{id:string;planar:boolean;surfaceType:string;normal:number[];centerMm:number[];edgeIds:string[]}> = [];
  for(let axis=0;axis<3;axis++) for(const sign of [-1,1]) {
    const coordinate=sign<0?0:size[axis]!;
    faces.push({ id:`f${faces.length}`, planar:true, surfaceType:"Plane", normal:size.map((_,i)=>i===axis?sign:0), centerMm:size.map((v,i)=>i===axis?coordinate:v/2), edgeIds:edges.filter(edge=>edge.vertexIds.every(id=>vertices[id]!.positionMm[axis]===coordinate)).map(edge=>edge.id) });
  }
  const describedEdges=edges.map(edge=>({ ...edge, line:true, centerMm:vertices[edge.vertexIds[0]!]!.positionMm.map((v,i)=>(v+vertices[edge.vertexIds[1]!]!.positionMm[i]!)/2), tangent:size.map((_,i)=>vertices[edge.vertexIds[0]!]!.positionMm[i]===vertices[edge.vertexIds[1]!]!.positionMm[i]?0:1), faceIds:faces.filter(face=>face.edgeIds.includes(edge.id)).map(face=>face.id) }));
  return {type:"Solid",vertices,edges:describedEdges,faces,boundsMm:{min:[-100,-100,-100],max:[100,100,100]}} as unknown as RuntimeState["bodies"][number];
}

test("analytic box verification ignores a loose native box and checks its topology", () => {
  const result=verifyNativeBoxGeometry(box(),[0,0,0],[10,20,30]);
  assert.equal(result.method,"native-planar-topology"); assert.equal(result.vertexCount,8);
});

test("displaced corners, curved edges, duplicate boundaries and wrong planes cannot qualify as a box", () => {
  for (const change of [
    (b: ReturnType<typeof box>) => { b.vertices![0]!.positionMm[0] += 0.001; },
    (b: ReturnType<typeof box>) => { b.edges[0]!.curveType = "BCurve"; },
    (b: ReturnType<typeof box>) => { b.edges[0]!.lengthMm += 0.1; },
    (b: ReturnType<typeof box>) => { b.edges[0]!.vertexIds = [...b.edges[1]!.vertexIds]; b.edges[0]!.lengthMm=b.edges[1]!.lengthMm; },
    (b: ReturnType<typeof box>) => { b.faces[0]!.centerMm[0] += 0.001; },
    (b: ReturnType<typeof box>) => { b.faces[0]!.edgeIds = b.faces[0]!.edgeIds.slice(0,3); },
    (b: ReturnType<typeof box>) => { b.faces[0]!.edgeIds.push(b.faces[0]!.edgeIds[0]!); },
  ]) { const b=box(); change(b); assert.throws(()=>verifyNativeBoxGeometry(b,[0,0,0],[10,20,30])); }
});


test("SPCurve edges qualify only with nonparallel planar supports and matching geometry", () => {
  const b=box(); for(const edge of b.edges) { edge.curveType="SPCurve";edge.line=false; }
  assert.equal(verifyNativeBoxGeometry(b,[0,0,0],[10,20,30]).nativeLineEdgeCount,0);
  b.edges[0]!.faceIds=[b.edges[0]!.faceIds[0]!,b.edges[0]!.faceIds[0]!];
  assert.throws(()=>verifyNativeBoxGeometry(b,[0,0,0],[10,20,30]));
});
