# Circular-section direct shear implementation plan

1. Add failing unit tests for solid-circle and concentric-annulus stresses,
   model labels, rotated load invariance, split-arc recognition and rejection
   of eccentric or otherwise unsupported sections.
2. Implement an exact loop-family classifier and bounded shear-factor helper.
3. Return the selected shear model, bump new section results to passport
   version 1.1.0 and keep stored 1.0.0 reports readable.
4. Update the method registry, agent instructions and public documentation.
5. Run targeted tests, the complete test/typecheck gates and diff review, then
   commit and fast-forward into `main`.
