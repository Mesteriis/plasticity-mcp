# Circular-section direct shear

Status: accepted implementation increment, 2026-09-21.

## Purpose

Extend `planar-section-resultants-v1` direct transverse-shear checks from a
proven solid rectangle to two rotationally symmetric families that Plasticity
can identify exactly from native line/circle section loops:

- one solid circle;
- one concentric circular annulus.

Other shapes remain unsupported. This package does not approximate a general
section from its area or bounding box.

## Geometry proof

A circular loop may contain one full-circle segment or adjacent circular arcs.
Every segment must share one finite centre and radius, close continuously and
sum to one full revolution. A solid circle has one such loop and no inner
loop. An annulus has exactly two such loops with coincident centres and
different radii. Eccentric holes, multiple holes, partial arcs mixed with
lines, ellipses and arbitrary curved sections are rejected.

The classifier consumes the same exact section loops that are already checked
against native B-rep properties and topology signatures. It does not trust a
caller-supplied shape label.

## Calculation

For transverse resultant magnitude `V` and area `A`:

- rectangle: `tau_max = 3 V / (2 A)`;
- solid circle: `tau_max = 4 V / (3 A)`;
- concentric annulus with outer radius `R` and inner radius `r`:
  `tau_max = 4 V / (3 A) * (R^2 + R r + r^2) / (R^2 + r^2)`.

The annular expression tends to the solid-circle value as `r` tends to zero
and to `2 V/A` in the thin-wall limit. These are elementary beam transverse
shear checks; the existing assumptions, material/process evidence gate,
safety factor and exclusions continue to apply.

The result records the selected `shearModel`. Adding the two families changes
the passport implementation version from 1.0.0 to 1.1.0. Stored 1.0.0 reports
remain readable and immutable.

## Evidence and limits

The solid-circle `4V/(3A)` relation is independently shown in University of
Washington ME354 and Purdue ME323 material. The annular expression follows
directly from `tau = VQ/(Ib)` at the neutral axis, using exact annular `Q`, `I`
and material width; its solid and thin-wall limits are tested.

This is nominal maximum transverse shear. It does not add shear/normal stress
interaction, local hole effects, anisotropic print failure, torsion, joints,
bearing, tear-out or whole-part validation.
