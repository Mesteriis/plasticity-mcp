import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { CameraSnapshot, GeometryRef, ModelVersion } from "../../shared/contracts.ts";
import { buildSceneFromOcct, type ModelScene, type OcctResult } from "./model-scene.ts";
import { pickModel, type ModelPick } from "./picking.ts";
import { applySectionPlane } from "./section-plane.ts";
import { localUuid } from "../uuid.ts";

export type StepImporter = (version: ModelVersion) => Promise<OcctResult>;

export function ModelViewer({
  initial,
  versions = initial ? [initial] : [],
  importer = importVersion,
  onCameraChange,
  onPickReady,
  onVersionChange,
  focusGeometry,
  onSelectionChange,
}: {
  initial?: ModelVersion;
  versions?: ModelVersion[];
  importer?: StepImporter;
  onCameraChange?: (camera: CameraSnapshot) => void;
  onPickReady?: (picker: ((clientX: number, clientY: number) => ModelPick | undefined) | undefined) => void;
  onVersionChange?: (version: ModelVersion) => void;
  focusGeometry?: GeometryRef | undefined;
  onSelectionChange?: (selection: GeometryRef | undefined) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<ModelVersion | undefined>(initial);
  const [model, setModel] = useState<ModelScene>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<"isometric" | "front" | "top">("isometric");
  const [fitRequest, setFitRequest] = useState(0);
  const [sectionEnabled, setSectionEnabled] = useState(false);
  const [hiddenBodies, setHiddenBodies] = useState<Set<number>>(() => new Set());
  const [transparentBodies, setTransparentBodies] = useState<Set<number>>(() => new Set());
  const [selectedPick, setSelectedPick] = useState<ModelPick>();

  useEffect(() => {
    setSelected(initial);
    setHiddenBodies(new Set());
    setTransparentBodies(new Set());
    setSelectedPick(undefined);
    setSectionEnabled(false);
    setView("isometric");
  }, [initial?.id]);

  useEffect(() => {
    if (selected) onVersionChange?.(selected);
  }, [onVersionChange, selected]);

  useEffect(() => {
    if (!model || !focusGeometry) return;
    const body = model.bodies.find((candidate) => candidate.bodyId === focusGeometry.bodyId);
    if (!body) return;
    setSelectedPick({
      modelVersionId: selected?.id ?? "",
      meshIndex: body.meshIndex,
      bodyId: focusGeometry.bodyId,
      ...(focusGeometry.faceId ? { faceId: focusGeometry.faceId } : {}),
      pointMm: new THREE.Box3().setFromObject(body.mesh).getCenter(new THREE.Vector3()).toArray(),
    });
    setFitRequest((current) => current + 1);
  }, [focusGeometry, model, selected?.id]);

  useEffect(() => {
    if (selectedPick?.bodyId === undefined) { onSelectionChange?.(undefined); return; }
    onSelectionChange?.({
      bodyId: selectedPick.bodyId,
      ...(selectedPick.faceId ? { faceId: selectedPick.faceId } : {}),
    });
  }, [onSelectionChange, selectedPick]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void importer(selected).then((result) => {
      const next = buildSceneFromOcct(result, selected);
      if (cancelled) { next.dispose(); return; }
      setModel((current) => { current?.dispose(); return next; });
      setError(undefined);
    }).catch((cause: unknown) => { if (!cancelled) setError(`Не удалось подготовить 3D-представление: ${String(cause)}`); });
    return () => { cancelled = true; };
  }, [selected, importer]);

  useEffect(() => {
    if (!model) return;
    for (const body of model.bodies) {
      body.mesh.visible = !hiddenBodies.has(body.meshIndex);
      const materials = Array.isArray(body.mesh.material) ? body.mesh.material : [body.mesh.material];
      for (const material of materials) {
        material.transparent = transparentBodies.has(body.meshIndex);
        material.opacity = transparentBodies.has(body.meshIndex) ? 0.28 : 1;
        material.depthWrite = !transparentBodies.has(body.meshIndex);
        material.needsUpdate = true;
      }
    }
  }, [model, hiddenBodies, transparentBodies]);

  useEffect(() => {
    if (!model) return;
    const center = model.bounds.getCenter(new THREE.Vector3());
    applySectionPlane(model.root, sectionEnabled ? new THREE.Plane(new THREE.Vector3(0, 0, -1), center.z) : undefined);
  }, [model, sectionEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model || typeof WebGLRenderingContext === "undefined") return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    const scene = new THREE.Scene();
    scene.add(model.root, new THREE.HemisphereLight(0xdde9ef, 0x283038, 2.3));
    const light = new THREE.DirectionalLight(0xffffff, 2.2); light.position.set(2, -3, 4); scene.add(light);
    const selectedBody = selectedPick ? model.bodies.find((body) => body.meshIndex === selectedPick.meshIndex) : undefined;
    const framingBounds = selectedBody ? new THREE.Box3().setFromObject(selectedBody.mesh) : model.bounds;
    const size = framingBounds.getSize(new THREE.Vector3());
    const center = framingBounds.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length(), 1);
    const aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 500);
    const halfHeight = Math.max(size.x / Math.max(aspect, .01), size.y, size.z, 1) * .65;
    const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = view === "isometric"
      ? new THREE.PerspectiveCamera(38, aspect, 0.01, 1_000_000)
      : new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.01, 1_000_000);
    const offset = view === "front" ? new THREE.Vector3(0, -radius * 2, 0)
      : view === "top" ? new THREE.Vector3(0, 0, radius * 2)
      : new THREE.Vector3(radius, -radius, radius * .8);
    camera.position.copy(center).add(offset);
    camera.up.set(0, view === "top" ? 1 : 0, view === "top" ? 0 : 1);
    camera.lookAt(center);
    const controls = new OrbitControls(camera, canvas); controls.target.copy(center); controls.update();
    const cameraId = localUuid();
    const publishCamera = () => {
      const width = canvas.clientWidth || 800; const height = canvas.clientHeight || 500;
      camera.updateMatrixWorld();
      onCameraChange?.({ id: cameraId, projection: camera instanceof THREE.OrthographicCamera ? "orthographic" : "perspective", positionMm: [camera.position.x, camera.position.y, camera.position.z], targetMm: [controls.target.x, controls.target.y, controls.target.z], up: [camera.up.x, camera.up.y, camera.up.z], viewMatrix: camera.matrixWorldInverse.toArray(), projectionMatrix: camera.projectionMatrix.toArray(), viewport: [width, height] });
    };
    controls.addEventListener("change", publishCamera);
    const resize = () => {
      const width = canvas.clientWidth || 800; const height = canvas.clientHeight || 500;
      renderer.setSize(width, height, false);
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = width / height;
      else {
        const nextAspect = width / height;
        camera.left = -halfHeight * nextAspect; camera.right = halfHeight * nextAspect;
      }
      camera.updateProjectionMatrix(); publishCamera();
    };
    resize();
    const pickAt = (clientX: number, clientY: number) => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return undefined;
      return pickModel(model, camera, new THREE.Vector2(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        -(((clientY - bounds.top) / bounds.height) * 2 - 1),
      ));
    };
    const select = (event: PointerEvent) => setSelectedPick(pickAt(event.clientX, event.clientY));
    canvas.addEventListener("pointerup", select);
    onPickReady?.(pickAt);
    let frame = 0;
    const draw = () => { renderer.render(scene, camera); frame = requestAnimationFrame(draw); };
    draw();
    return () => { cancelAnimationFrame(frame); canvas.removeEventListener("pointerup", select); onPickReady?.(undefined); controls.removeEventListener("change", publishCamera); controls.dispose(); renderer.dispose(); scene.remove(model.root); };
  }, [model, onCameraChange, onPickReady, view, fitRequest]);

  useEffect(() => () => model?.dispose(), [model]);

  return <section className="model-viewer" aria-label="3D-модель">
    <canvas ref={canvasRef} />
    <div className="viewport-toolbar" aria-label="Управление 3D-видом">
      <button className={view === "isometric" ? "active" : ""} onClick={() => setView("isometric")}>Изометрия</button>
      <button className={view === "front" ? "active" : ""} onClick={() => setView("front")}>Спереди</button>
      <button className={view === "top" ? "active" : ""} onClick={() => setView("top")}>Сверху</button>
      <span />
      <button aria-pressed={sectionEnabled} className={sectionEnabled ? "active" : ""} onClick={() => setSectionEnabled((current) => !current)}>Сечение Z</button>
      <button onClick={() => setFitRequest((current) => current + 1)}>Вписать</button>
    </div>
    <div className="version-switcher">{versions.map((version) => <button key={version.id} className={selected?.id === version.id ? "active" : ""} onClick={() => setSelected(version)}>Версия {version.number}</button>)}</div>
    {error ? <div role="alert" className="viewer-error">{error}</div> : null}
    <aside className="body-tree"><span className="eyebrow">Тела · сетка для просмотра</span>{model?.bodies.map((body) => <div key={body.mesh.uuid} className={selectedPick?.meshIndex === body.meshIndex ? "selected" : ""}>
      <button aria-label={`Выбрать ${body.mesh.name}`} onClick={() => setSelectedPick({ modelVersionId: selected?.id ?? "", meshIndex: body.meshIndex, ...(body.bodyId === undefined ? {} : { bodyId: body.bodyId }), pointMm: new THREE.Box3().setFromObject(body.mesh).getCenter(new THREE.Vector3()).toArray() })}>{body.mesh.name}</button>
      <button aria-label={`${hiddenBodies.has(body.meshIndex) ? "Показать" : "Скрыть"} ${body.mesh.name}`} onClick={() => setHiddenBodies(toggleSet(hiddenBodies, body.meshIndex))}>{hiddenBodies.has(body.meshIndex) ? "○" : "◉"}</button>
      <button aria-label={`Изолировать ${body.mesh.name}`} onClick={() => setHiddenBodies(new Set(model.bodies.filter((candidate) => candidate.meshIndex !== body.meshIndex).map((candidate) => candidate.meshIndex)))}>I</button>
      <button aria-label={`Прозрачность ${body.mesh.name}`} aria-pressed={transparentBodies.has(body.meshIndex)} onClick={() => setTransparentBodies(toggleSet(transparentBodies, body.meshIndex))}>T</button>
    </div>)}</aside>
    {selectedPick ? <div className="selection-chip">{selectedPick.bodyId === undefined ? `Сетка ${selectedPick.meshIndex + 1}` : `Тело ${selectedPick.bodyId}`}{selectedPick.faceId ? ` · грань ${selectedPick.faceId}` : ""}</div> : null}
    <div className="mesh-disclaimer">Измерения курсором приблизительные · display mesh</div>
  </section>;
}

function toggleSet(current: Set<number>, value: number): Set<number> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

async function importVersion(version: ModelVersion): Promise<OcctResult> {
  const response = await fetch(`/api/projects/${encodeURIComponent(version.projectId)}/assets/${version.stepArtifactHash}`);
  if (!response.ok) throw new Error(`STEP download failed with HTTP ${response.status}`);
  return await runWorker(await response.arrayBuffer());
}

function runWorker(bytes: ArrayBuffer): Promise<OcctResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./step-worker.ts", import.meta.url), { type: "module" });
    const id = localUuid();
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("STEP conversion timed out")); }, 60_000);
    worker.onmessage = (event: MessageEvent<{ id: string; result?: OcctResult; error?: string }>) => {
      if (event.data.id !== id) return;
      clearTimeout(timer); worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result) resolve(event.data.result);
      else reject(new Error("STEP worker returned no result"));
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id, bytes }, [bytes]);
  });
}
