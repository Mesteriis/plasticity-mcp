# Retained catalog failure dispositions

All original failed fixtures stay in the machine-readable audit. A later passing
variant does not rewrite the original input/result. This table reconciles their
meaning against the completed continuations; it is not an acceptance waiver.

| Retained category | Current disposition and evidence |
| --- | --- |
| `ascii-stl-multiple-solids-rejected` | Fixed parser defect. Sequential complete solid blocks now pass the guarded network import on both versions; malformed blocks remain rejected. [Qualification](network-reference-qualification.md). |
| `public-interface-failure-location-mapping` | Fixed public enum mapping. All five failure-location variants now retain their public labels; stresses/counts unchanged. [Qualification](joint-test-qualification.md). |
| `mmb-arm-thickness-halved` | Fixed calculation version 2. Independent numeric oracle, synthetic old-record read/list/match and immutable-source preservation pass on both versions. [Qualification](fracture-energy-qualification.md). |
| `cantilever-method-deflection-limit` | Correct out-of-method refusal. No calculation report outside the deflection/slenderness bounds. Valid conditional cases and explicit negative guards pass on both versions. [Qualification](material-coupon-qualification.md). |
| `unsupported-fractional-turns`, `thread-envelope-and-fractional-helix-gate` | Fractional helix/recipe inputs explicitly reject before geometry; no silent pitch/length adjustment. Whole-turn cases, original-envelope controls, pair and calibration variants pass on both versions. The original fractional inputs remain unsupported. [Bounds/helix constraints](native-bounds-and-helix.md), catalog thread continuation. |
| `step-import-nominal-bounds-gate`, `pipe-channel-nominal-bounds-gate` | Strict legacy nominal bbox fixtures remain unaccepted because 26.1.3 returns conservative native boxes. Independent B-Rep geometry/provenance and containment controls pass; no tight-box claim or altered tolerance. Strict modern bounds pass. [Qualification](legacy-bounds-qualification.md). |
| `circular-imprint-nominal-measurement-gate` | Native vector projection remains unaccepted against the strict analytic-circle/volume gates on both versions. Explicit normal projection passes the ordinary/rotated planar cases; it is a separately selected method. [Qualification](curve-imprint-projection.md). |
| `viewport-unavailable` | Original default full-window capture in a hidden renderer remains unaccepted. Explicit WebGL viewport capture passes fresh-frame, group visibility, section clipping and restoration checks on both versions. It does not prove OS-window visibility or HTML glyphs. [Qualification](viewport-screenshots.md). |
| `stale-window-html-pixels` | Initial captures remain failed. A separate user-focused foreground three-phase external-window workflow passes on both versions with inspected glyph pixels/hashes. Background/default Chromium window freshness remains unaccepted. [Qualification](html-measurement-labels.md). |
| `interactive-gesture-required` | Unattended manual-UI-edit fixture remains unaccepted; the verifier rejects noninteractive stdin before mutation. Focus/return is now automated, but manual one-move acceptance is still pending. [Current UI qualification](direct-ui-edit-qualification.md). |
| `ui-fixture-interrupted-user-edits` | User-confirmed extra selections/Fillet Shell steps were preserved; verifier interrupted without Undo. This is not a completed controlled fixture. [Current UI qualification](direct-ui-edit-qualification.md). |
| `ui-move-not-committed` | CUA selection/gizmo attempts committed no geometric move. Exact reconciliation and backup/open restored the owned empty scene; no UI pass is inferred. A separate pointer diagnostic observed no held-button motion. [Current UI qualification](direct-ui-edit-qualification.md). |
| `reference-search-timeout` | Original broad three-candidate 120-second request remains failed. Restricted one-source 180-second discovery succeeds on both versions. This is limited discovery evidence, not a cure for arbitrary query latency. [Qualification](reference-discovery-qualification.md). |
| `authored-fixture-contract-mismatch` | Old bracket fixture omitted current test-axis/process/layer-plan requirements. Inputs now follow the public contracts; validators were not weakened. The subsequent valid-input solver failure is retained separately. [Qualification](strength-fem-catalog-qualification.md). |
| `cohesive-two-interface-nonlinear-cpu-limit` | Unresolved. Full brackets on both versions and a byte-identical diagnostic replay of the modern solver input exhaust CPU near pseudo-time 0.97 with Newton oscillation/subdivision. One-interface passing coverage does not accept this case. Legacy guarded four-step cleanup passes and both scenes reconcile empty/idle. [Qualification](strength-fem-catalog-qualification.md). |

These dispositions bound what is known. Known unsupported projection, fractional
turns, conservative bounds, window freshness and query latency are not fixed by
catalog coverage. Physical manufacturing/material validation is outside these
synthetic software fixtures. The original native open-document timeout was fixed
by save-before-open with an exclusive backup; completed legacy reopen/cache and
rational STEP/SVG scenarios provide its separate regression evidence.

PR #35 is merged with both checks green. The full goal remains active while direct mouse-edit acceptance and the focus-helper/disposition continuation review are pending. The installed applications and their security
settings are unchanged.
