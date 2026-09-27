# Contributing

Thanks for helping improve Plasticity MCP. Contributions should preserve native Plasticity behavior, revision safety, and the distinction between exact B-rep measurements and approximate mesh or screen measurements.

## Before you start

- Check existing issues and the acceptance documentation to avoid duplicate work.
- For a substantial change, open an issue first to agree on the behavior and scope.
- Do not include private CAD files, screenshots, local paths, credentials, or machine-specific runtime data in a change.

## Development setup

Requirements are Node.js 24 or newer and, for live CAD acceptance, macOS Apple Silicon with Plasticity 26.1.3. Install dependencies with `npm install` at the repository root. Workbench dependencies are managed by the root npm workspace.

Run the relevant checks before submitting:

```sh
npm test
npm run typecheck
npm --prefix workbench test
npm --prefix workbench run typecheck
npm --prefix workbench run build
```

Live acceptance scripts can mutate the selected Plasticity document or interact with installed slicer software. Run them only after reading their matching guide and selecting a disposable test document. Record what was actually verified; do not describe mock or type checks as live application validation.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add regression coverage for meaningful behavior changes.
- Update user documentation when tools, inputs, configuration, install steps, or safety behavior change.
- Include the exact checks run and their results. Clearly identify checks that need Plasticity or another live application and were not run.
- Do not commit generated build output, local databases, evidence artifacts, or application data.

By submitting a contribution, you agree that it will be distributed under the repository's MIT License and copyright notice.
