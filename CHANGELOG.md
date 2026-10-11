# Changelog

## 0.2.2 — Unreleased

- Cache serialized body topology to avoid repeated native-wrapper allocation when reading an unchanged scene; retain live names, visibility and materials and invalidate on geometry/history changes (#2, #3).
- Return native mass-property centroids for solids and faces instead of bounding-box centers (#1, #4, #5, #6).
- Add native asymmetric-centroid and topology-invalidation regression acceptance, plus a reproducible [486-body state-memory benchmark](docs/state-memory-benchmark.md).

## 0.2.1 — 2026-09-28

- Show a compact core tool catalog by default in `npm start` and the Codex plugin. All operations remain searchable and callable through `plasticity_call`; `npm run start:full` exposes every operation directly.
- First GitHub release of the local preview for Plasticity 26.1.3 on macOS Apple Silicon. See the [acceptance matrix](docs/acceptance-matrix.md) for verified operations and remaining limitations.
