# Window and native viewport screenshots

`plasticity_screenshot` writes a new PNG file without overwriting. It now has an
explicit `captureMode` argument; existing calls keep the default window behavior.

| Mode | Captured content | Preconditions and provenance |
| --- | --- | --- |
| `window` (default) | Full Chromium renderer, including HTML panels and labels | Brings the page forward, then requires `document.hidden === false`. Existing `{path, bytes}` result remains unchanged. |
| `viewport` | Fresh native WebGL canvas, including native geometry, clipping and WebGL helpers | Requires exactly one viewport, an idle executor, live context and verified native draw advancement. Returns `captureMode`, `freshFrame`, `rendererHidden`, width and height in addition to path/bytes. |

Viewport mode excludes HTML labels, panels and CSS backgrounds. It preserves
native canvas alpha, so background pixels can be transparent. It is not a
capture of the operating-system desktop or proof that a window is visible to
the user. Default window mode never silently falls back to viewport capture.

On both experimental copies, Electron reported a visible, non-minimized window
while Chromium reported a hidden document. Raising the window briefly changed
visibility, but `Page.bringToFront` did not reliably make a later window capture
possible. A raw CDP diagnostic could produce an image on 26.2.1, whereas hidden
26.1.3 CDP capture timed out. A valid PNG alone was therefore insufficient proof
of a new native viewport frame.

## Fresh native frame contract

Viewport capture runs the existing native viewport render handler synchronously,
then immediately encodes the WebGL canvas before a non-preserved drawing buffer
can be discarded. Both the renderer draw counter and native frame timestamp
must advance, the native dirty flag must clear, and the WebGL context must remain
live and identical. Context loss during encoding rejects the image too. Missing
capabilities, ambiguous viewports, busy executors and invalid/oversized dimensions
reject. The returned PNG signature/dimensions must match the native canvas.
No application prototype, visibility flag, background-throttling setting or
system security setting is changed. A final live smoke check on each version
confirmed that viewport capture left CAD revision and Undo/Redo depths unchanged.

## Qualified rendered scenarios

Run the existing guarded cases in new evidence directories:

```sh
npm run accept:groups -- --target ID --allow-disposable-mutations \
  --viewport-capture --output NEW_DIRECTORY
npm run accept:native-section-analysis -- --target ID --allow-disposable-mutations \
  --viewport-capture --output ANOTHER_NEW_DIRECTORY
```

Both cases pass on experimental 26.2.1 and 26.1.3 copies with `rendererHidden=true`
and verified fresh-frame provenance. Group hiding changes 3.255751% of canvas
pixels; Undo and Redo each exactly reproduce their corresponding shown/hidden
frame. The original >=0.002 change and <=0.0001 restoration ratios remain.
Native section clipping changes about 14.702% of pixels; deleting the section
exactly restores the source image. Its >=0.01 clipping threshold remains.
Pixels were decoded and compared, and representative geometry/clipping PNGs
were visually inspected. Both cases also retain native state/history checks
and restore an empty document. Persistent test stores are isolated.

These explicit native-viewport fixture variants are separate from the original
full-window failures. HTML distance labels, default window screenshots, operating
system visibility and interactive gesture scenarios remain unqualified by these
runs. Native rendering success is not evidence of physical manufacturing fit.
