# Circular-section torsion passport

Status: accepted implementation increment, 2026-09-21.

## Purpose

Extend `planar-section-resultants-v1` with nominal elastic torsional shear for
the two exact rotationally symmetric families already proven from native
section loops:

- a solid circle;
- a concentric circular annulus.

No polar-moment substitution is permitted for rectangles, perforated plates,
eccentric holes or other shapes. Their Saint-Venant torsion constants and
stress distributions are different from the polar area moment.

## Applicability and formula

For a nonzero torsional resultant `T` about the section normal, outer radius
`R` and polar area moment `J = Ixx + Iyy`:

```text
tau_max = abs(T) * R / J
```

For the supported circular families this equals the classical elastic torsion
solution, with `J = πR⁴/2` for a solid circle and
`J = π(R⁴-r⁴)/2` for a concentric annulus. The calculation requires the same
sourced or measured material/process shear limit and explicit safety factor as
direct shear. It records the chosen `torsionModel` and a separate torsion
utilization.

The method assumes a straight, homogeneous-equivalent circular member, torque
transmitted about the measured section centre, linear-elastic behavior and no
local geometric discontinuity at the checked section. Existing confirmations
for static load, homogeneous-equivalent section and representative section
resultants remain mandatory. Twist is not calculated because the current
section scenario does not prove shaft length, shear modulus or torsional
boundary conditions.

## Interaction boundary

When transverse shear and torsion are both nonzero, the server returns both
component stress values but the overall result is `unsupported`. Their vector
stress fields do not generally reach maxima at the same point, and this
passport does not invent a combined failure criterion. Axial/bending normal
stress and circular torsion continue to be reported separately, with stress
interaction listed as unchecked.

Noncircular torsion remains `unsupported`. A supported circular torsion result
does not validate shoulders, keyways, threads, attachments, layer interfaces,
fatigue, creep or whole-part behavior.

## Version and compatibility

New calculations use `planar-section-resultants-v1` 1.2.0. Stored 1.0.0 and
1.1.0 reports remain readable. The result adds optional
`torsionalShearStressMPa`, `torsionModel` and `torsionUtilization` fields.

Formula evidence is published by MIT OpenCourseWare, Missouri S&T and the
University of Alabama in Huntsville mechanics-of-materials material for solid
and hollow circular shafts.
