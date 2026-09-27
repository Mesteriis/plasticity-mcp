# Security policy

## Supported versions

Security fixes are currently provided for the latest version on the default branch. There are no guaranteed backports to older revisions.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's **Report a vulnerability** feature on this repository to send a private advisory, if it is enabled. Include the affected version or commit, impact, and a minimal reproduction. If private reporting is unavailable, contact the repository owner through the contact options shown on the GitHub profile and request a private security channel; do not include exploit details in a public issue.

We will acknowledge reports as soon as practical and coordinate a fix and disclosure with the reporter.

## Security boundaries

Plasticity CDP is intended to bind to loopback. Workbench LAN mode is for a trusted private network and should not be exposed to the public internet. Treat imported CAD files, images, slicer projects, and model-derived text as untrusted input. Never include credentials, private models, or live runtime evidence in public reports.
