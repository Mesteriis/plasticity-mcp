# Full catalog completion audit

Objective: finish all checks for the existing 371-tool catalog on experimental
Plasticity 26.2.1 while preserving 26.1.3 compatibility. This objective is active.
A completed slice, green unit tests or a catalog count is not full completion.

## Required evidence

- Every tool/version needs a meaningful current production-path scenario.
  Metadata discovery, arbitrary invalid-input rejection and successes inside failed
  fixtures do not establish working support.
- Corresponding native scenarios must use the two approved experimental copies.
  Host-only calculations are labelled separately from geometry/rendering proof.
- Known failures need a current disposition: reproduced and fixed with regression,
  confirmed supported rejection, or an explicitly unresolved limitation/blocker.
  Historical failed evidence must be retained, including after fixes.
- Relevant local test/typecheck, native numerical and persistence checks, final CI
  and PR review must cover the resulting changes. Unrun gates remain unverified.
- Installed app bundles/settings/security and user CAD/data must remain untouched.
  Synthetic stores and owned disposable scenes are used for qualification.

## Current remaining tool evidence

Source: [machine-readable catalog audit](plasticity-26-2-catalog-audit.json).
Current successful coverage is 349/371 on 26.2.1 and 313/371 on 26.1.3.
The table is a backlog, not an acceptance waiver.

| Tool | 26.2.1 | 26.1.3 |
| --- | --- | --- |
| `plasticity_analyze_cohesive_interface` | pending | pending |
| `plasticity_analyze_design_reference` | pending | pending |
| `plasticity_analyze_static_fem` | pending | pending |
| `plasticity_analyze_strength_task` | pending | pending |
| `plasticity_calculate_fastener_member_strength` | pending | pending |
| `plasticity_calculate_heat_set_insert_retention` | pending | pending |
| `plasticity_calculate_section_strength` | covered | pending |
| `plasticity_calculate_single_fastener_strength` | pending | pending |
| `plasticity_calculate_strength` | covered | pending |
| `plasticity_calculate_threaded_receiver_strength` | covered | pending |
| `plasticity_calculate_tongue_root_strength` | pending | pending |
| `plasticity_calculate_tongue_root_strength_from_coupon_data` | pending | pending |
| `plasticity_calibrate_turon_mixed_mode_law` | pending | pending |
| `plasticity_check_fastener_group_layout` | covered | pending |
| `plasticity_cohesive_fem_report` | pending | pending |
| `plasticity_compare_static_fem_refinement_reports` | pending | pending |
| `plasticity_create_blind_hole` | covered | pending |
| `plasticity_create_blind_hole_pattern` | covered | pending |
| `plasticity_create_counterbore_pattern` | covered | pending |
| `plasticity_create_countersink` | covered | pending |
| `plasticity_create_countersink_pattern` | covered | pending |
| `plasticity_create_heat_set_insert_pocket_pattern` | covered | pending |
| `plasticity_create_hex_nut_pocket` | covered | pending |
| `plasticity_create_hex_nut_pocket_pattern` | covered | pending |
| `plasticity_create_screw_boss_pattern` | covered | pending |
| `plasticity_create_slotted_hole` | covered | pending |
| `plasticity_create_slotted_hole_pattern` | covered | pending |
| `plasticity_create_through_hole` | covered | pending |
| `plasticity_create_through_hole_pattern` | covered | pending |
| `plasticity_design_reference_request` | pending | pending |
| `plasticity_distribute_fastener_group_load` | pending | pending |
| `plasticity_fastener_group_plate_bearing_report` | covered | pending |
| `plasticity_find_faces` | covered | pending |
| `plasticity_inspect_arbitrary_sections` | covered | pending |
| `plasticity_inspect_fastener_group` | covered | pending |
| `plasticity_inspect_integral_rectangular_plate` | covered | pending |
| `plasticity_inspect_planar_section` | covered | pending |
| `plasticity_inspect_rectangular_member` | covered | pending |
| `plasticity_inspect_single_fastener_plate` | covered | pending |
| `plasticity_list_printed_thread_qualifications` | pending | pending |
| `plasticity_match_printed_thread_qualification` | pending | pending |
| `plasticity_measure_fastener_grip_stack` | covered | pending |
| `plasticity_measure_nonparallel_planar_polygon_clearance` | covered | pending |
| `plasticity_plan_cohesive_layer_planes` | pending | pending |
| `plasticity_record_printed_thread_qualification` | pending | pending |
| `plasticity_scan_arbitrary_sections` | covered | pending |
| `plasticity_scan_section_strength` | covered | pending |
| `plasticity_section_strength_scan_report` | covered | pending |
| `plasticity_static_fem_report` | pending | pending |
| `plasticity_strength_methods` | pending | pending |
| `plasticity_strength_request` | pending | pending |
| `plasticity_verify_fastener_group_load` | covered | pending |
| `plasticity_verify_fastener_group_plate_bearing` | covered | pending |
| `plasticity_verify_integral_plate_strength` | covered | pending |
| `plasticity_verify_member_strength` | covered | pending |
| `plasticity_verify_section_strength` | covered | pending |
| `plasticity_verify_single_fastener_strength` | covered | pending |
| `plasticity_verify_tongue_root_strength_from_coupon_data` | pending | pending |

## Retained failures requiring final disposition audit

These are historical failed fixtures, not all necessarily current product defects.
Counts below preserve the evidence; fixes do not delete their original failures.
Current unsupported/native/UI cases must still be assessed before completion.

| Failure category | 26.2.1 retained cases | 26.1.3 retained cases |
| --- | ---: | ---: |
| `ascii-stl-multiple-solids-rejected` | 1 | 0 |
| `cantilever-method-deflection-limit` | 1 | 0 |
| `circular-imprint-nominal-measurement-gate` | 1 | 1 |
| `interactive-gesture-required` | 1 | 1 |
| `mmb-arm-thickness-halved` | 1 | 0 |
| `pipe-channel-nominal-bounds-gate` | 0 | 1 |
| `public-interface-failure-location-mapping` | 1 | 0 |
| `reference-search-timeout` | 1 | 0 |
| `stale-window-html-pixels` | 1 | 1 |
| `step-import-nominal-bounds-gate` | 0 | 1 |
| `thread-envelope-and-fractional-helix-gate` | 3 | 3 |
| `unsupported-fractional-turns` | 2 | 2 |
| `viewport-unavailable` | 3 | 3 |

## Next execution order

1. Reconcile the remaining legacy native-operation gap using guarded, isolated
   existing verifiers and stop mutations after uncertain outcomes.
2. Exercise remaining calculation, printed-thread qualification and strength
   request flows through production stdio with independent gates.
3. Verify actual static/cohesive solver workflows, report freshness/refinement
   and mixed-mode calibration. Synthetic diagnostics do not prove physical strength.
4. Complete live analysis/design-reference checks without expanding capability
   privileges or exporting user CAD; classify any external/runtime blockers.
5. Reconcile all retained failures and repeat affected current checks, including
   genuine full-window rendering where rendering is claimed.
6. Audit every requirement against fresh outputs and merged CI before marking
   the thread goal complete.
