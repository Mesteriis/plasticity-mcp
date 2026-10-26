# Direct UI edit qualification

The direct mouse-edit fixture remains unaccepted on both experimental versions.
All 371 tools already have passing application-connected catalog scenarios; this
additional check concerns an edit initiated through the real desktop UI, native
change detection, exact Undo/Redo and restoration of an owned disposable scene.
A backend transform or programmatically dispatched DOM event is not its evidence.

## Focus helper

`scripts/focus-return.applescript` operates only on an already-running process.
It checks its PID against the exact executable, requires one exact window title,
activates that process and raises that window. It remembers the previous process,
executable and front-window title, then restores the previous application/window
when the caller creates a release file, the lease expires, or an operation fails.
Restoration rechecks process identity and foreground state; failures are explicit.
The helper does not open/close applications or modify CAD, application bundles,
security settings or permissions. It uses existing macOS Automation/Accessibility
access and fails rather than modifying access settings.

```sh
osascript scripts/focus-return.applescript \
  "$target_pid" "$expected_executable" "$window_title" 900 "$release_file"
```

Resolve the PID from the exact experimental executable and isolated profile before
invocation. The release path must be new and under `/tmp/`; the maximum lease is
1–900 seconds. Run asynchronously while doing the UI work, then create that exact
release file and wait for the helper to finish. Use one helper at a time: overlapping
leases can compete when restoring different previous applications. The bounded
lease is a fallback for caller failure, not a reason to leave a live helper behind.

On macOS, source compilation and actual target activation/foreground restoration
passed. Early release and a short timed return were checked independently against
the foreground PID. A wrong executable was rejected without a focus change.
The longer lease was used successfully for the pointer diagnostic and released
explicitly. These checks qualify focus management, not mouse drag or CAD geometry.

## Retained attempts

- `direct-mouse-interrupted-user-edits`: the user confirmed making additional
  selections/Fillet Shell edits in the disposable test document. The verifier was
  stopped without Undo. The user's saved native file was preserved separately
  with a matching hash; no acceptance was claimed for that interrupted sequence.
- `direct-mouse-navigation-no-commit` and `direct-mouse-cua-input-no-commit`:
  CUA selected the Solid and opened Move, but the attempted gizmo drags did not
  commit a geometric move. Native bounds stayed 0..20 × 0..20 × 0..10 mm. The
  verifier was stopped; exact body/geometry/history reconciliation preceded
  an explicit backup and opening of an owned empty baseline. These remain failed
  fixtures; cleanup does not turn them into passes.
- Starting Move by keyboard before the viewport had an active interaction context
  displayed `Cannot read properties of undefined (reading 'active')`. A later
  direct viewport selection opened Move. This observation does not establish an
  adapter defect or qualify that initial keyboard path.

## Observed input limitation

A separate empty-document diagnostic temporarily observed native pointer events
without generating any input, preventing defaults or changing CAD. One CUA drag
from screenshot coordinates (1100,600) to (1300,700) produced trusted events:

| Event | Native client coordinate | Buttons |
| --- | --- | ---: |
| `pointerdown` | (520,300) | 1 |
| `pointermove` | (620,350) | 0 |
| `pointerup` | (620,350) | 0 |

There was no motion with the button held in that observed sequence. This explains
why this transport observation does not prove a native held-button drag. It is
not a universal claim about every CUA environment. A second attempt returned
`noWindowsAvailable`. The diagnostic listeners were removed explicitly; the scene
remained empty with clean native history. No application prototype, visibility flag,
input handler or security setting was patched.

A clean one-move manual fixture is now waiting for a human gesture on 26.2.1.
It must pass the original diff/bounds, Undo/Redo and cleanup gates before the
corresponding 26.1.3 fixture runs. The foreground helper is available; repeated
CUA attempts or numeric/backend transformations cannot replace that evidence.
