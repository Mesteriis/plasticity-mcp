# HTML measurement label lifecycle

The distance overlay positions previously depended on `requestAnimationFrame`.
Both experimental Plasticity 26.2.1 and 26.1.3 suspend that loop while the
renderer is hidden: changing the camera left the HTML labels at old coordinates.

Overlay tags now expose an editor-owned synchronous refresh. `setView` invokes
it after camera changes; native viewport capture invokes it after rendering,
which can advance camera controls. Refresh cancels the pending frame before
scheduling its replacement, retaining one RAF loop for visible manual navigation.
Deleted/replaced tags remove their labels and stop scheduling frames.

## Repeatable acceptance

Run only against an empty disposable document in an experimental application:

```sh
npm run accept:native-measurement-labels -- --target ID --allow-disposable-mutations --output NEW_DIRECTORY
```

No arguments and `--help` are inert. Output must be new; stores and evidence are
isolated. An unknown timeout stops recovery mutations. Owned fixture recovery
requires the original document and last known revision. Successful cleanup
restores the initial scene snapshot, removes all overlay labels/helpers and
checks an in-sync durable journal. Discard the synthetic redo history afterwards.

The fixture creates face–face, face–edge and vertex–vertex dimensions. It checks
5 mm, sqrt(50) mm, 20 mm and a moving 10→15 mm dimension; text rounded to two
decimals; one attached, visible label per native version; its full DOM rectangle
inside the viewport; and its CSS anchor within 0.5 CSS px of an independent
projection of the native helper midpoint. It checks a camera change, rotation and scale with Undo, model move,
move Undo/Redo, delete Undo/Redo, deletion of all dimensions and empty cleanup.

Both experimental versions pass all thirteen phases. The original stale-camera
reproduction failed on both versions before the patch. Numeric and HTML-layout
checks retain the same thresholds after the fix. Unit regressions execute the
emitted refresh callback with RAF suspended, check a single pending frame after
repeated refresh, offscreen hiding and removed-tag cleanup, and verify the
capture order: draw, label refresh, PNG encoding.

## Limits and follow-up

This is **native measurement and HTML DOM/layout evidence**. The associated fresh
WebGL PNGs exclude HTML labels. DOM text, computed style and rectangles do not
prove rasterized glyph pixels, occlusion, overlap avoidance or full-window
capture. Default window capture retains its visibility guard. Full-window HTML
pixel acceptance remains open.

A native transform replaces the moving measurement's version and originally lost
its `userData.name` on both versions. Item move, rotate, XYZ rotation and scale
commands now capture names by stable ID and copy missing names to surviving
replacement versions before the command returns and history records its result.
This is local to the command; there is no persistent name cache or prototype
patch. Existing replacement names win, deleted IDs are not resurrected, and
unnamed measurements remain unnamed. The fixture now requires exact names after
rotation, scale and their Undo, move Undo/Redo, and measurement delete Undo/Redo.
File serialization and other command families are outside this qualification.

## External full-window review

Add `--window-review` to pause at `created`, `model-moved` and `all-deleted`.
Each phase writes `PHASE-review-ready.json` and waits up to 90 seconds for a real
CUA window capture saved as `PHASE-window.jpg` in the same new output directory.
It records the JPEG artifact hash and rejects a changed document/revision. A
JPEG file is **not** an automatic glyph-pixel pass; manual review is mandatory.
Default runs remain unattended DOM/layout checks. No args/`--help` remain inert.

The initial three-phase review failed on both experimental copies (retained as
separate failing fixtures):

| Version | Created | Model moved (expected 15 mm) | All dimensions deleted |
| --- | --- | --- | --- |
| 26.2.1 | Four expected labels visible | Stale 10.00 mm label | Stale labels remain |
| 26.1.3 | Stale empty window | Expected 15.00 mm visible | Labels absent |

Native values and DOM/layout checks passed at those same checkpoints. CUA also
reported an initial ScreenCaptureKit failure and `noWindowsAvailable` for a
viewport click. Raising the modern window did not provide reliable capture
freshness. These observations do not establish whether stale pixels originate
in the compositor, capture service or application. External review reports
retain the original native/layout exit code separately and fail overall window
acceptance; original full-window MCP fixtures remain failed too. A real foreground
window and repeatable fresh captures are still needed. No visibility emulation,
security changes or replacement rasterization are used.

After the user manually focused the experimental 26.1.3 viewport, a separate
`html-window-review-focused` run passed all three manually inspected images:
5.00/7.07/20.00/10.00 mm after creation, 15.00 mm after moving the second box,
and no measurement labels/helper lines after deletion. The same captured JPEG
bytes were displayed for review and saved; hashes match the fixture evidence.
All thirteen native/DOM phases, exact names, source restoration and empty/idle
cleanup also pass. This qualifies that foreground external-window workflow on
26.1.3; it does not accept the default Chromium full-window MCP capture or
background freshness. Earlier stale-window failures remain. The corresponding
focused 26.2.1 review is still pending.

Installed applications, app bundles and security settings were unchanged.
