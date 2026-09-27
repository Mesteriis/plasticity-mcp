# Strength live acceptance

The strength workflow was accepted on 2026-09-21 with Plasticity 26.1.3 on an
Apple Silicon Mac, Node.js 24, the installed Codex App Server API and a real
stdio MCP client. The installed Codex executable launches its JSON-RPC stdio
server; the MCP sends turns through that API rather than invoking shell tasks
or the public OpenAI API. The run used an explicitly selected empty `Untitled`
document. It did not start or use Workbench.

## Safe invocation

The command refuses live work unless all mutation and paid-call flags are
present. The output directory must not exist. Running it without arguments or
with `--help` performs no Plasticity mutation and no Codex call.

```sh
node scripts/verify-strength-live.ts \
  --target EXPLICIT_PLASTICITY_TARGET_ID \
  --allow-disposable-mutations \
  --live-codex \
  --output .plasticity-mcp/strength-live-NEW-RUN
```

Add `--image /absolute/path/to/sketch.png` to stage one explicit PNG/JPEG/HEIC/HEIF in
the isolated output directory and include it in the live Codex analysis. The
staged copy is private (`0600`) and bounded to 20 MiB; its path is not written
to sanitized evidence. A repeatable synthetic fixture is available at
[`scripts/fixtures/unscaled-bracket-sketch.png`](../scripts/fixtures/unscaled-bracket-sketch.png).

The selected document must contain no bodies, Regions, instances, reference
meshes, measurements or section analyses; all groups must also be empty, and
both Undo and Redo history must be clean. If any scene object or history entry
exists, the verifier refuses before its first snapshot or mutation. Evidence
files are created with mode `0600` below the new output directory. They contain
bounded outcomes, IDs and measured values, without credentials or full model
prompts. A failure writes `failure.json`. A complete run writes `evidence.json`.

## Verified evidence

The successful run completed from `2026-09-21T08:39:38.392Z` to
`2026-09-21T08:40:48.103Z` and proved the following behavior:

- Isolated Codex analysis returned a strict structured response for an
  unscaled synthetic sketch, preserved unknown scale and dimensions, selected
  `cantilever-tip-rectangle-v1`, and asked five bounded questions.
- Cancelling a second analysis stored it as `interrupted`; no owned Codex
  process survived.
- The deterministic candidate set 7, 8, 9 and 10 mm returned 10 mm as a
  `conditional` recommendation. The 9 mm candidate produced
  0.7407407407 MPa and 1.09739369 mm; the 10 mm candidate produced 0.6 MPa and
  0.8 mm.
- Native Plasticity created and exactly re-read a rectangular B-rep member as
  200 × 20 × 10 mm. The bound result was `conditional`, because the benchmark
  material and manufacturing profile were intentionally synthetic.
- Scaling the height to 8 mm made the old report stale with
  `CAD_REVISION_CHANGED`. Fresh native measurement produced 0.9375 MPa,
  1.5625 mm and `fail` for the 1 mm displacement limit.
- Undo, Redo and Undo re-read exact heights 10, 8 and 10 mm respectively.
- Subtracting a through cylinder without changing the outer bounds caused the
  exact topology gate to return `unsupported`; a mesh bounding box was not
  accepted as rectangular-member proof.
- Cleanup removed all disposable bodies and restored the original scene
  content. Plasticity retained a newer history revision, as expected after
  native mutations and Undo.
- Terminating the test MCP during an analysis left the persisted request
  `interrupted`. Replaying the same request ID after restart did not launch a
  new Codex process. The persisted CAD-bound report was `unverified` until a
  Plasticity session could revalidate it.

These results validate software behavior and nominal formulas. They are not a
physical load test, material certification, structural-code check or print
authorization. Static FEA and deterministic ideal-member methods are software
capabilities, not physical validation. The Euler column tool has also passed
the real stdio MCP/Plasticity acceptance below; no physical column test was
performed.

## Euler column live acceptance

On 2026-09-23, the real stdio MCP connected to the explicitly selected empty
Plasticity 26.1.3 document, created and measured a native 200 × 20 × 10 mm
Solid, and called `plasticity_verify_member_strength` with the
`euler-column-buckling-v1` method. The bound report retained the synthetic
material as `conditional` and read the weak-axis second moment as
1666.6666666666667 mm⁴, Euler critical load as 822.4670334241134 N, critical
stress as 4.112335167120567 MPa, buckling utilization as 0.24317084074161058
and crushing utilization as 0.03333333333333333. The Euler report was `current`
against its original B-rep and became `stale` with `CAD_REVISION_CHANGED` after
the native Solid changed. The acceptance completed undo/redo and recovery,
then restored the original empty scene. Evidence:
`[local acceptance artifact omitted]`. This confirms
software and native geometry integration, not material qualification or
physical buckling strength.

## Full live acceptance rerun

On 2026-09-23, the full acceptance script completed again in the explicitly
selected empty Plasticity 26.1.3 document. A real Codex turn returned a
structured result for a synthetic unscaled-sketch description, preserved
unknown scale, selected the cantilever method and asked five questions. A
separate turn was cancelled without leaving an owned Codex process. The
deterministic benchmark selected 10 mm conditionally; the exact native B-rep
read back as 200 × 20 × 10 mm and produced 0.6 MPa nominal stress and 0.8 mm
deflection. Changing the section to 8 mm made the previous report stale and
produced 0.9375 MPa / 1.5625 mm with a failing displacement result. Undo/Redo,
same-bounds holed-body rejection, MCP restart, interrupted-request non-replay
and CAD-report revalidation all passed. Cleanup restored the same document to
zero bodies; a follow-up read confirmed it remained empty.

The run began at `2026-09-23T15:51:56.059Z` and completed at
`2026-09-23T15:52:33.937Z`. Sanitized evidence:
`[local acceptance artifact omitted]`.

This acceptance uses a synthetic text description with no attached image. It
proves structured unknown-scale handling, not image interpretation. The
synthetic material remains unconfirmed and the run is not a physical load test.

## Image-backed live analysis

On 2026-09-23, the same live acceptance ran with the explicit PNG fixture
`scripts/fixtures/unscaled-bracket-sketch.png`. Codex identified the L-shaped
bracket, diagonal gusset and three visible circular features, marked exact
scale and dimensions unknown, and left the method unset because the gusseted
shape was not established as a constant rectangular member. It asked five
focused questions covering the load, mounting/load path, missing 3D geometry,
material/process, and displacement criteria. The image remained within the
isolated acceptance directory; the staged copy was 4,669 bytes with mode
`0600`. Native geometry/history/restart checks passed and the original
Plasticity document was restored to zero bodies.

Sanitized evidence:
`[local acceptance artifact omitted]`. The Codex
analysis record in that temporary acceptance store contains the structured
observations and questions; it is local test state and is not committed. This
validates image input and conservative interpretation for a synthetic sketch,
not arbitrary photos or physical material properties.

## One-question interview and follow-up

After constraining the response schema to one question package, a new live run
used the same image and a second stateless Codex turn. The first turn asked
what the bracket supports, its expected load/use, and which features mount it.
The simulated user answered that the load, object, and mounting were unknown,
but that use was stationary indoors. The follow-up, supplied with the full
prior question and answer, asked only where the bracket would be installed and
which host surfaces contact it. Both turns returned exactly one question;
material, section dimensions, and displacement were deferred. The model still
left the method unset and explicitly excluded the gusseted shape from the
constant-rectangle method. CAD mutation, history, restart, and empty-scene
recovery also passed.

Evidence: `[local acceptance artifact omitted]`.
The follow-up MCP input now requires each answer to include the full previous
question text, so a new isolated Codex turn has enough context to adapt rather
than repeat or list every unknown.

## Failure recovery

The live script automatically undoes disposable geometry only while it can
prove that the same document remains selected and the construction journal has
no manual or uncertain edit. Otherwise it stops and records why cleanup was not
safe. A timed-out or interrupted analysis is terminal and is never retried with
the same request ID.
