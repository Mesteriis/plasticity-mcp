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
projection of the native helper midpoint. It checks a camera change, model move,
move Undo/Redo, delete Undo/Redo, deletion of all dimensions and empty cleanup.

Both experimental versions pass all nine phases. The original stale-camera
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

A native transform replaces the moving measurement's version and loses its
`userData.name` on both versions. Its stable ID, topology endpoints and numeric
value remain correct. The fixture follows stable IDs and records native names;
name persistence is a separate unresolved defect, not accepted by this test.
Installed applications, app bundles and security settings were unchanged.
