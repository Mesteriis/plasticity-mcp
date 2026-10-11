# Repeated state-read memory benchmark

Measured on 2026-10-11 with Plasticity 26.1.3, macOS Apple Silicon and 64 GiB
RAM. This compares the runtime from release `v0.2.1` against merged commit
`b210cae5af97e512b811c0682a43efe082bd117b`. Both runs completed 13 state reads.

The contributor's original CAD file was unavailable. This is a synthetic
486-body reproduction of the repeated native-wrapper allocation problem,
not a rerun of that exact model.

## Fixture and method

Create a 40 × 40 × 5 mm box at the origin. Subtract sixteen 4 × 4 × 7 mm
boxes whose origins are `[3 + 9*x, 3 + 9*y, -1]`, for `x,y = 0..3`.
Use a native rectangular body pattern with 27 columns and 18 rows, spaced
45 mm along X and Y. Save a copy and load that same file for both versions.
The resulting scene has 486 bodies, 34,020 faces, 99,144 edges and 66,096
vertices. It deliberately stresses vertex adjacency; its planar surfaces
do not represent every production geometry type.

Saved file: 39,898,035 bytes; SHA-256:
`f403eaa1ecb5eed4e7f5ccfee62237f28ab5884ce1fc04f0dcd038cc433b2608`.

Each run used a dedicated disposable window. Its renderer PID was verified
through the Electron main inspector's `BrowserWindow.webContents.getOSProcessId()`
before collecting process memory. Clear only the MCP topology cache before
the baseline sample. Force `HeapProfiler.collectGarbage` before every sample,
then record `Runtime.getHeapUsage` and macOS `footprint -f bytes` JSON.
State hashes must remain unchanged throughout each run.

`Malloc Small` dirty bytes include swapped bytes; do not add swapped bytes
again. The benchmark stops before another read if footprint reaches 6 GiB.
The first cold read and process startup allocations are excluded from the
repeated-read comparison below. Absolute process footprints should not be
compared: the two windows had different fixture preparation histories.

## Results

| Metric, reads 1 → 13 | v0.2.1 | Patched runtime |
| --- | ---: | ---: |
| Renderer footprint growth | 3,488,565,744 B (3.249 GiB) | 1,687,552 B (1.609 MiB) |
| Malloc Small growth | 3,208,921,088 B (2.989 GiB) | 1,540,096 B (1.469 MiB) |
| Median read time, reads 2–13 | 4.830 s | 1.602 s |
| First cold read time | 4.818 s | 5.018 s |

Warm reads were about 3.02× faster. The old runtime continued accumulating
about 255 MiB of Malloc Small per read; the patched runtime plateaued across
the twelve repeated reads. The patched first cold read still added about
424 MiB of renderer footprint. This is evidence that topology caching avoids
repeated allocation on an unchanged scene, not that the underlying native
wrapper lifecycle is repaired or that arbitrary long editing sessions are bounded.

Machine-independent sample summaries are checked in:
[v0.2.1](evidence/state-memory-2026-10-11/before-square.json) and
[patched](evidence/state-memory-2026-10-11/after-square.json).
Their runtime source hashes identify the exact implementations. Only the
external PID-verification attestation was added to the archived summaries;
the measured values are unchanged. Raw process reports and synthetic CAD
fixtures remain local in `/tmp/plasticity-memory-benchmark-20261011`.

## Repeat a run

Load the disposable fixture and identify its CDP target. Independently verify
the target-to-PID association through the Electron main inspector; a matching
process name alone is insufficient. In multi-window applications, use a unique
window title to associate the renderer target with its BrowserWindow, restoring
the title afterward. Record that evidence privately alongside the raw report.

```sh
PLASTICITY_CDP_URL=http://127.0.0.1:9223 npm run benchmark:native-state-memory -- \
  --target TARGET_ID --renderer-pid VERIFIED_PID --verified-target-pid \
  --output NEW_PRIVATE_DIRECTORY --label patched --reads 13 --cold-cache
```

The attestation flag records an operator-verified prerequisite; the script
does not automatically discover the target's OS PID. Use a fresh process/window
for the baseline, keep the same fixture and sampling policy, and avoid other
workloads while collecting timing. To compare old code, run the same harness
against the old runtime source in a separate checkout and verify its source
hash against the release tag. Geometry is never modified by the harness.
