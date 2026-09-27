import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { AnnotationAnchor, AnnotationInput, CameraSnapshot, GeometryRef, PairingGrant, Project } from "../shared/contracts.ts";
import { AnnotationLayer, type AnnotationTool } from "./annotations/annotation-layer.tsx";
import { AnnotationPanel } from "./annotations/annotation-panel.tsx";
import { loadAnnotationDraft, saveAnnotationDraft } from "./annotations/draft-store.ts";
import { BrowserApi } from "./api.ts";
import { StructuredBlockView } from "./forms/structured-block.tsx";
import { ModelViewer } from "./model/model-viewer.tsx";
import type { ModelPick } from "./model/picking.ts";
import { ManufacturingPanel } from "./manufacturing/manufacturing-panel.tsx";
import { initialWorkbenchState, reduceWorkbenchState } from "./state.ts";
import { ReferenceCard } from "./references/reference-card.tsx";

const api = new BrowserApi();

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(location.search).get("project"));
  const [state, dispatch] = useReducer(reduceWorkbenchState, initialWorkbenchState);
  const [error, setError] = useState<string>();
  const [tool, setTool] = useState<AnnotationTool>("navigate");
  const [pending, setPending] = useState<AnnotationInput[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pairing, setPairing] = useState<{ id: string; url: string; qrDataUrl: string; grants: PairingGrant[] }>();
  const [camera, setCamera] = useState<CameraSnapshot>();
  const [draftOwner, setDraftOwner] = useState<string>();
  const [selectedGeometry, setSelectedGeometry] = useState<GeometryRef>();
  const [focusGeometry, setFocusGeometry] = useState<GeometryRef>();
  const [viewedVersionId, setViewedVersionId] = useState<string>();
  const picker = useRef<((clientX: number, clientY: number) => ModelPick | undefined) | undefined>(undefined);
  const registerPicker = useCallback((next: ((clientX: number, clientY: number) => ModelPick | undefined) | undefined) => {
    picker.current = next;
  }, []);
  const pickAnchor = useCallback((clientX: number, clientY: number): AnnotationAnchor | undefined => {
    const picked = picker.current?.(clientX, clientY);
    if (!picked) return undefined;
    if (picked.bodyId !== undefined && picked.faceId !== undefined) {
      return { kind: "face", bodyId: picked.bodyId, faceId: picked.faceId, pointMm: picked.pointMm };
    }
    if (picked.bodyId !== undefined) return { kind: "body", bodyId: picked.bodyId, pointMm: picked.pointMm };
    return { kind: "world", pointMm: picked.pointMm };
  }, []);

  useEffect(() => {
    if (new URLSearchParams(location.search).has("code")) return;
    void api.projects().then((items) => {
    setProjects(items);
    if (!selectedId && items[0]) setSelectedId(items[0].id);
  }).catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(() => {
    const url = new URL(location.href);
    const code = url.searchParams.get("code");
    if (!code) return;
    void api.exchangePairing(code).then((session) => {
      url.searchParams.delete("code"); history.replaceState({}, "", url);
      setSelectedId(session.projectId);
    }).catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await api.snapshot(selectedId);
        if (!cancelled) dispatch({ type: "snapshot", ...snapshot });
      } catch (cause) { if (!cancelled) setError(String(cause)); }
    };
    void load();
    const timer = setInterval(() => void load(), 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedId]);

  const latestVersion = state.versions.at(-1);
  const viewedVersion = state.versions.find((version) => version.id === viewedVersionId) ?? latestVersion;
  useEffect(() => {
    if (!state.project || !viewedVersion) return;
    const owner = `${state.project.id}:${viewedVersion.id}`;
    let current = true;
    setDraftOwner(undefined);
    setPending([]);
    void loadAnnotationDraft(state.project.id, viewedVersion.id).then((annotations) => {
      if (!current) return;
      setPending(annotations);
      setDraftOwner(owner);
    });
    return () => { current = false; };
  }, [state.project?.id, viewedVersion?.id]);

  useEffect(() => {
    if (!state.project || !viewedVersion) return;
    if (draftOwner !== `${state.project.id}:${viewedVersion.id}`) return;
    void saveAnnotationDraft(state.project.id, viewedVersion.id, pending);
  }, [state.project?.id, viewedVersion?.id, draftOwner, pending]);

  return <main className="workbench-shell">
    <nav className="project-nav">
      <div className="brand"><span className="brand-mark">P</span><div><strong>Workbench</strong><small>Plasticity + Codex</small></div></div>
      <div className="nav-label">Проекты</div>
      <div className="project-list">{projects.map((project) => <button key={project.id} className={selectedId === project.id ? "active" : ""} onClick={() => setSelectedId(project.id)}>
        <span className="project-icon">◇</span><span><strong>{project.name}</strong><small>rev {project.revision}</small></span>
      </button>)}</div>
      <button className="new-project" onClick={() => void createProject(setProjects, setSelectedId)}>＋ Новый проект</button>
      <div className="connection"><span className="signal" /> Локальное соединение</div>
    </nav>
    <section className="review-space">
      <header className="topbar"><div><span className="eyebrow">Текущий проект</span><h1>{state.project?.name ?? "Выберите проект"}</h1></div><div className="top-actions"><span className="revision">REV {state.project?.revision ?? 0}</span><button onClick={() => void shareProject()}>Поделиться</button></div></header>
      {error ? <div role="alert" className="error-banner">{error}</div> : null}
      <section className="model-stage">
        {state.versions.length ? <ModelViewer initial={state.versions[state.versions.length - 1]!} versions={state.versions} onVersionChange={(version) => setViewedVersionId(version.id)} onCameraChange={setCamera} onPickReady={registerPicker} focusGeometry={focusGeometry} onSelectionChange={setSelectedGeometry} /> : <div className="model-empty"><div className="model-glyph">⬡</div><strong>Модель ещё не опубликована</strong><p>STEP-представление появится после публикации агентом.</p></div>}
        {state.versions.length && camera ? <AnnotationLayer tool={tool} camera={camera} annotations={[...state.annotations.filter((annotation) => annotation.modelVersionId === viewedVersion?.id), ...pending]} pickAnchor={pickAnchor} onComplete={(annotation) => setPending((current) => [...current, annotation])} /> : null}
        {state.versions.length ? <AnnotationPanel tool={tool} setTool={setTool} pending={pending} submitting={submitting} onRemoveLast={() => setPending((current) => current.slice(0, -1))} onSubmit={() => void submitFeedback()} /> : null}
        <div className="stage-footer"><span>Миллиметры</span><span>Точные размеры берутся из B-Rep Plasticity</span></div>
      </section>
      <section className="review-data">
        <header><div><span className="eyebrow">Проверка</span><h2>Данные модели</h2></div><span>{state.blocks.length + state.references.length} блоков</span></header>
        <div className="cards">{state.blocks.length || state.references.length ? <>{state.references.map((reference) => <ReferenceCard key={reference.id} reference={reference} />)}{state.blocks.map((block) => <StructuredBlockView key={block.id} block={block} activeGeometry={selectedGeometry} onGeometryRequest={setFocusGeometry} onSubmit={async (batch) => {
          if (!state.project) return;
          try {
            await api.submitDimensionChanges(state.project.id, { expectedRevision: state.project.revision, ...batch });
            dispatch({ type: "snapshot", ...(await api.snapshot(state.project.id)) });
          } catch (cause) { setError(String(cause)); throw cause; }
        }} />)}</> : <div className="empty-card">Агент опубликует здесь размеры, допущения и результаты проверки.</div>}</div>
      </section>
      {state.project ? <ManufacturingPanel api={api} projectId={state.project.id} jobs={state.manufacturingJobs} onError={setError} onRefresh={async () => dispatch({ type: "snapshot", ...(await api.snapshot(state.project!.id)) })} /> : null}
    </section>
    {pairing ? <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Ссылка для планшета"><div className="pairing-card"><span className="eyebrow">Планшет · право аннотации</span><h2>Откройте в той же Wi‑Fi сети</h2><img src={pairing.qrDataUrl} alt="QR-код ссылки Workbench" /><input readOnly value={pairing.url} onFocus={(event) => event.currentTarget.select()} /><section className="pairing-sessions"><strong>Активные ссылки и планшеты</strong>{pairing.grants.map((grant) => <div key={grant.id}><span>{grant.kind === "session" ? "Планшет" : "Ссылка"} · {grant.role}<small>до {new Date(grant.expiresAt).toLocaleString()}</small></span><button className="revoke-pairing" onClick={() => void revokePairing(grant.id)}>Отозвать</button></div>)}</section><button onClick={() => setPairing(undefined)}>Готово</button></div></div> : null}
  </main>;

  async function submitFeedback(): Promise<void> {
    const project = state.project; const version = viewedVersion;
    if (!project || !version || pending.length === 0) return;
    setSubmitting(true);
    try {
      await api.submitAnnotations(project.id, { expectedRevision: project.revision, modelVersionId: version.id, annotations: pending });
      setPending([]);
      dispatch({ type: "snapshot", ...(await api.snapshot(project.id)) });
    } catch (cause) { setError(String(cause)); }
    finally { setSubmitting(false); }
  }

  async function shareProject(): Promise<void> {
    if (!state.project) return;
    try {
      const issued = await api.createPairing(state.project.id);
      setPairing({ ...issued, grants: await api.pairings(state.project.id) });
    } catch (cause) { setError(String(cause)); }
  }

  async function revokePairing(pairingId: string): Promise<void> {
    if (!state.project) return;
    try {
      await api.revokePairing(state.project.id, pairingId);
      setPairing((current) => current?.id === pairingId ? undefined : current ? { ...current, grants: current.grants.filter((grant) => grant.id !== pairingId) } : current);
    } catch (cause) { setError(String(cause)); }
  }
}

async function createProject(setProjects: (value: Project[]) => void, select: (id: string) => void): Promise<void> {
  const name = window.prompt("Название проекта", "Новая деталь")?.trim();
  if (!name) return;
  const project = await api.createProject(name);
  const projects = await api.projects();
  setProjects(projects);
  select(project.id);
}
