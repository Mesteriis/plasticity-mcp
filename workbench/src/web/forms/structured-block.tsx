import { useMemo, useState } from "react";

import type { GeometryRef, StructuredBlock } from "../../shared/contracts.ts";

export interface StructuredChangeBatch {
  blockId: string;
  changes: Array<{ key: string; value: number }>;
}

export function StructuredBlockView({
  block,
  onSubmit,
  activeGeometry,
  onGeometryRequest,
}: {
  block: StructuredBlock;
  onSubmit?: (batch: StructuredChangeBatch) => Promise<void>;
  activeGeometry?: GeometryRef | undefined;
  onGeometryRequest?: (geometry: GeometryRef) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const dimensionChanges = useMemo(() => {
    if (block.type !== "dimensions") return [];
    return block.rows.flatMap((row) => {
      const draft = drafts[row.key];
      if (draft === undefined || draft.trim() === "" || Number(draft) === row.value) return [];
      const value = Number(draft);
      return Number.isFinite(value) ? [{ key: row.key, value }] : [];
    });
  }, [block, drafts]);
  const validationErrors = useMemo(() => {
    if (block.type !== "dimensions") return [];
    return block.rows.flatMap((row) => {
      const draft = drafts[row.key];
      if (draft === undefined) return [];
      const value = Number(draft);
      if (!draft.trim() || !Number.isFinite(value)) return [`${row.label}: введите число`];
      if (row.unit === "count" && !Number.isInteger(value)) return [`${row.label}: требуется целое число`];
      if (row.input?.min !== undefined && value < row.input.min) return [`${row.label}: минимум ${row.input.min}`];
      if (row.input?.max !== undefined && value > row.input.max) return [`${row.label}: максимум ${row.input.max}`];
      if (row.input?.step !== undefined && !isStepAligned(value, row.input.step, row.input.min ?? 0)) return [`${row.label}: шаг ${row.input.step}`];
      return [];
    });
  }, [block, drafts]);

  return <section className="data-card" aria-labelledby={`block-${block.id}`}>
    <header>
      <div>
        <span className="eyebrow">{blockLabel(block.type)}</span>
        <h3 id={`block-${block.id}`}>{block.title}</h3>
      </div>
      <span className="row-count">{block.rows.length}</span>
    </header>
    <div className="table-scroll">
      {block.type === "dimensions" ? <table>
        <thead><tr><th>Параметр</th><th>Задано</th><th>Факт</th><th>Источник</th><th>Статус</th></tr></thead>
        <tbody>{block.rows.map((row) => <tr key={row.key} className={isLinked(row.linkedEntities, activeGeometry) ? "linked-active" : ""}>
          <th scope="row">{row.linkedEntities?.[0] && onGeometryRequest ? <button className="geometry-link" onClick={() => onGeometryRequest(row.linkedEntities![0]!)}>{row.label}</button> : row.label}</th>
          <td><input
            aria-label={row.label}
            aria-invalid={validationErrors.some((message) => message.startsWith(`${row.label}:`))}
            type="number"
            inputMode="decimal"
            min={row.input?.min}
            max={row.input?.max}
            step={row.input?.step ?? (row.unit === "count" ? 1 : "any")}
            required
            value={drafts[row.key] ?? String(row.value)}
            onChange={(event) => setDrafts((current) => ({ ...current, [row.key]: event.target.value }))}
          /><span className="unit">{row.unit}</span></td>
          <td>{row.actual === undefined ? "—" : formatNumber(row.actual)} {row.actual === undefined ? "" : row.unit}</td>
          <td>{sourceLabel(row.source)}</td>
          <td><span className={`status status-${row.status}`}>{statusLabel(row.status)}</span></td>
        </tr>)}</tbody>
      </table> : <GenericRows block={block} activeGeometry={activeGeometry} onGeometryRequest={onGeometryRequest} />}
    </div>
    {block.type === "dimensions" && onSubmit ? <footer>
      <span className={validationErrors.length ? "input-error" : ""}>{validationErrors[0] ?? (dimensionChanges.length ? `Изменено: ${dimensionChanges.length}` : "Нет изменений")}</span>
      <button disabled={submitting || validationErrors.length > 0 || dimensionChanges.length === 0} onClick={() => {
        setSubmitting(true);
        void onSubmit({ blockId: block.id, changes: dimensionChanges })
          .then(() => setDrafts({}))
          .finally(() => setSubmitting(false));
      }}>
        Сохранить размеры
      </button>
    </footer> : null}
  </section>;
}

function GenericRows({ block, activeGeometry, onGeometryRequest }: { block: Exclude<StructuredBlock, { type: "dimensions" }>; activeGeometry: GeometryRef | undefined; onGeometryRequest: ((geometry: GeometryRef) => void) | undefined }) {
  return <table><thead><tr><th>Пункт</th><th>Значение</th><th>Статус</th></tr></thead>
    <tbody>{block.rows.map((row) => <tr key={row.key} className={"linkedEntities" in row && isLinked(row.linkedEntities, activeGeometry) ? "linked-active" : ""}>
      <th scope="row">{"linkedEntities" in row && row.linkedEntities?.[0] && onGeometryRequest ? <button className="geometry-link" onClick={() => onGeometryRequest(row.linkedEntities![0]!)}>{row.label}</button> : row.label}</th>
      <td>{"value" in row ? String(row.value) : "message" in row ? row.message : "after" in row ? String(row.after ?? "—") : "url" in row ? (row.url ?? row.artifactHash) : "—"}</td>
      <td>{"status" in row ? String(row.status) : "—"}</td>
    </tr>)}</tbody></table>;
}

function blockLabel(type: StructuredBlock["type"]): string {
  return ({ dimensions: "Размеры", requirements: "Требования", assumptions: "Допущения", sources: "Источники", validation: "Проверка", comparison: "Изменения" })[type];
}
function sourceLabel(source: string): string { return source === "native-brep" ? "Точная геометрия" : source === "display-mesh" ? "Сетка" : source; }
function statusLabel(status: string): string { return status === "verified" ? "Проверено" : status === "needs-review" ? "Проверить" : status; }
function formatNumber(value: number): string { return String(Number(value.toFixed(6))); }

function isStepAligned(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) <= Number.EPSILON * Math.max(16, Math.abs(steps) * 16);
}

function isLinked(links: GeometryRef[] | undefined, active: GeometryRef | undefined): boolean {
  if (!links || !active) return false;
  return links.some((link) => link.bodyId === active.bodyId
    && (active.faceId === undefined || link.faceId === active.faceId)
    && (active.edgeId === undefined || link.edgeId === active.edgeId));
}
