import type { AnnotationInput } from "../../shared/contracts.ts";
import type { AnnotationTool } from "./annotation-layer.tsx";

const tools: Array<{ id: AnnotationTool; label: string; glyph: string }> = [
  { id: "navigate", label: "Навигация", glyph: "⌖" }, { id: "pen", label: "Перо", glyph: "✎" },
  { id: "highlighter", label: "Маркер", glyph: "▰" }, { id: "arrow", label: "Стрелка", glyph: "↗" }, { id: "marker", label: "Точка", glyph: "●" },
  { id: "note", label: "Заметка", glyph: "T" }, { id: "dimension", label: "Размер", glyph: "↔" },
];

export function AnnotationPanel({ tool, setTool, pending, submitting, onRemoveLast, onSubmit }: { tool: AnnotationTool; setTool(tool: AnnotationTool): void; pending: AnnotationInput[]; submitting: boolean; onRemoveLast(): void; onSubmit(): void }) {
  return <div className="annotation-tools"><div className="tool-row">{tools.map((item) => <button key={item.id} className={tool === item.id ? "active" : ""} aria-label={item.label} title={item.label} onClick={() => setTool(item.id)}>{item.glyph}</button>)}</div>
    {pending.length ? <div className="annotation-actions"><button className="discard-last" disabled={submitting} onClick={onRemoveLast}>Удалить последнюю</button><button className="submit-feedback" disabled={submitting} onClick={onSubmit}>Передать изменения агенту <span>{pending.length}</span></button></div> : null}</div>;
}
