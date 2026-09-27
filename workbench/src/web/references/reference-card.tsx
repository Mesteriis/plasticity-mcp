import type { ReferenceRecord } from "../../shared/contracts.ts";

export function ReferenceCard({ reference }: { reference: ReferenceRecord }) {
  const missing = reference.dimensions.filter((dimension) => dimension.confidence === "measurement-required");
  return <section className="data-card" aria-labelledby={`reference-${reference.id}`}>
    <header>
      <div>
        <span className="eyebrow">Референс · {sourceKindLabel(reference.sourceKind)}</span>
        <h3 id={`reference-${reference.id}`}>{reference.label}</h3>
      </div>
      <span className={`status status-${missing.some((item) => item.critical) ? "needs-review" : "verified"}`}>
        {missing.some((item) => item.critical) ? "Нужны размеры" : confidenceLabel(reference.overallConfidence)}
      </span>
    </header>
    <div className="reference-meta">
      <span>{reference.format.toUpperCase()}</span>
      <span>{reference.sceneRole === "locked-reference" ? "Заблокированная геометрия" : "Функциональный габарит"}</span>
      {reference.license ? <span>Лицензия: {reference.license}</span> : null}
      {reference.sourceUrl ? <a href={reference.sourceUrl} target="_blank" rel="noreferrer">Открыть источник</a> : null}
      {reference.artifactHash ? <code title={reference.artifactHash}>SHA-256 {reference.artifactHash.slice(0, 12)}…</code> : null}
    </div>
    <div className="table-scroll">
      <table>
        <thead><tr><th>Размер</th><th>Значение</th><th>Уверенность</th><th>Источник</th><th>Критичный</th></tr></thead>
        <tbody>{reference.dimensions.length ? reference.dimensions.map((dimension) => <tr key={dimension.key}>
          <th scope="row">{dimension.label}</th>
          <td>{dimension.value === undefined ? "Требуется измерение" : `${dimension.value} ${dimension.unit}`}</td>
          <td>{confidenceLabel(dimension.confidence)}</td>
          <td>{dimension.sourceLocator ?? dimension.note ?? "—"}</td>
          <td>{dimension.critical ? "Да" : "Нет"}</td>
        </tr>) : <tr><td colSpan={5}>Размеры ещё не извлечены</td></tr>}</tbody>
      </table>
    </div>
  </section>;
}

function sourceKindLabel(kind: ReferenceRecord["sourceKind"]): string {
  return ({
    "official-manufacturer-cad": "официальная CAD-модель",
    "official-documentation": "официальный документ",
    "official-distributor-cad": "CAD поставщика",
    "established-cad-library": "CAD-библиотека",
    "verified-community-cad": "проверенная модель сообщества",
    "functional-envelope": "функциональный габарит",
    "scaled-image": "масштабированное изображение",
  })[kind];
}

function confidenceLabel(confidence: ReferenceRecord["overallConfidence"]): string {
  return ({
    verified: "Проверено",
    probable: "Вероятно",
    approximate: "Приблизительно",
    assumed: "Допущение",
    "measurement-required": "Требуется измерение",
  })[confidence];
}
