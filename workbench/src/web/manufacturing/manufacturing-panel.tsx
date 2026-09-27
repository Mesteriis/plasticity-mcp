import { useEffect, useState } from "react";

import type { ManufacturingProfile, PrinterStatus, SliceJob } from "../../shared/contracts.ts";
import type { BrowserApi } from "../api.ts";
import { GcodePreview } from "./gcode-preview.tsx";

export function ManufacturingPanel({
  api, projectId, jobs, onRefresh, onError,
}: {
  api: BrowserApi;
  projectId: string;
  jobs: SliceJob[];
  onRefresh(): Promise<void>;
  onError(error: string): void;
}) {
  const [profiles, setProfiles] = useState<ManufacturingProfile[]>([]);
  const [status, setStatus] = useState<PrinterStatus>();
  const [busy, setBusy] = useState(false);
  const latestJob = jobs.at(-1);
  useEffect(() => {
    let active = true;
    void api.manufacturingProfiles(projectId).then((catalog) => {
      if (!active) return;
      setProfiles(catalog.profiles);
      const profile = catalog.profiles[0];
      if (profile?.printer.connection?.host) {
        void api.printerStatus(projectId, profile).then((value) => { if (active) setStatus(value); }).catch(() => undefined);
      }
    }).catch((cause: unknown) => onError(String(cause)));
    return () => { active = false; };
  }, [projectId]);
  const profile = latestJob?.profile ?? profiles[0];
  return <section className="manufacturing-panel">
    <header><div><span className="eyebrow">Производство</span><h2>Подготовка к печати</h2></div><span className={`printer-state ${status && ["standby", "complete", "cancelled"].includes(status.state.toLowerCase()) ? "ready" : ""}`}>{status ? `${status.identity.model} · ${status.state}` : profile ? profile.printer.model : "Профиль не найден"}</span></header>
    {jobs.length === 0 ? <div className="empty-card">После нарезки агентом здесь появятся траектории, параметры и кнопка подтверждения.</div> : <div className="manufacturing-job-list">
      {[...jobs].reverse().map((job, index) => <article className="manufacturing-job" key={job.id}>
        <header className="manufacturing-job-heading">
          <h3>Задание {jobs.length - index} · {job.profile.printer.model} · {job.profile.material.type}</h3>
          <span className={`job-state state-${job.state}`}>{stateLabel(job.state)}</span>
        </header>
        <div className="manufacturing-grid">
          <div className="print-summary data-card">
            <dl>
              <div><dt>Слой</dt><dd>{job.profile.slicer.layerHeightMm} мм</dd></div>
              <div><dt>Слоёв</dt><dd>{job.summary?.layers ?? "—"}</dd></div>
              <div><dt>Время</dt><dd>{formatTime(job.summary?.estimatedSeconds)}</dd></div>
              <div><dt>Пластик</dt><dd>{job.summary?.filamentMassG?.toFixed(1) ?? "—"} г</dd></div>
              <div><dt>G-code</dt><dd title={job.gcodeArtifactHash}>{job.gcodeArtifactHash?.slice(0, 16) ?? "—"}</dd></div>
              <div><dt>Модель</dt><dd title={job.sourceArtifactHash}>{job.sourceArtifactHash.slice(0, 16)}</dd></div>
            </dl>
            <div className="dfm-findings">{job.dfmReport.findings.map((finding) => <p key={finding.code} className={`finding-${finding.severity}`}>{finding.message}</p>)}</div>
            {job.failure ? <p className="print-failure">{job.failure}</p> : null}
            {job.state === "ready" ? <button className="approve-print" disabled={busy} onClick={() => void approve(job)}>Подтвердить отправку на печать</button> : null}
            {job.state === "approved" ? <p className="approval-notice">Подтверждено. Агент может отправить только этот G-code на указанный принтер.</p> : null}
            {job.state === "unknown" ? <p className="print-failure">Исход отправки неизвестен. Проверьте очередь принтера; повтор заблокирован.</p> : null}
          </div>
          <div className="data-card toolpath-card"><header><h3>Просмотр слоёв</h3><span>G-code</span></header>{job.gcodeArtifactHash ? <GcodePreview projectId={projectId} hash={job.gcodeArtifactHash} /> : <div>G-code ещё не готов</div>}</div>
        </div>
      </article>)}
    </div>}
  </section>;

  async function approve(target: SliceJob): Promise<void> {
    const hash = target.gcodeArtifactHash;
    if (!hash) return;
    const confirmed = window.confirm(printApprovalMessage(target));
    if (!confirmed) return;
    setBusy(true);
    try { await api.approvePrint(projectId, target.id); await onRefresh(); }
    catch (cause) { onError(String(cause)); }
    finally { setBusy(false); }
  }
}

export function printApprovalMessage(job: SliceJob): string {
  const findings = job.dfmReport.findings.map((finding) => `• [${finding.severity}] ${finding.message}`).join("\n") || "• Нет";
  return [
    `Разрешить агенту отправить на ${job.profile.printer.model} файл G-code ${job.gcodeArtifactHash}?`,
    `Модель: ${job.sourceArtifactHash}`,
    `Ревизия проекта: ${job.projectRevision}`,
    `Профиль: ${job.profile.slicer.name}`,
    `Материал: ${job.profile.material.name}`,
    `Время: ${formatTime(job.summary?.estimatedSeconds)}`,
    `Пластик: ${job.summary?.filamentMassG?.toFixed(1) ?? "—"} г`,
    `DFM-проверки:\n${findings}`,
    "После любых изменений потребуется новое подтверждение.",
  ].join("\n\n");
}

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

function stateLabel(state: SliceJob["state"]): string {
  return ({ slicing: "Нарезка", ready: "Готово к проверке", failed: "Ошибка", approved: "Подтверждено", submitting: "Отправка", submitted: "Печать запущена", unknown: "Нужно проверить" })[state];
}
