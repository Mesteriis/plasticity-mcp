# Circular-section torsion implementation plan

1. Add failing tests for solid-circle and concentric-annulus torsion, signed
   torque invariance, noncircular rejection, missing shear evidence and the
   combined transverse-shear/torsion boundary.
2. Reuse the exact circular-family proof and calculate `abs(T) R / (Ixx+Iyy)`.
3. Add structured torsion outputs, bump new section results to 1.2.0 and keep
   1.0.0/1.1.0 stored reports readable.
4. Update method resources, agent instructions, public docs and the guarded
   live section acceptance.
5. Run targeted tests, complete repository gates and a real stdio acceptance;
   commit and fast-forward into `main` only after the disposable document is
   restored.
