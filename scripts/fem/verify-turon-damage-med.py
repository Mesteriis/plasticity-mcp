#!/usr/bin/env python3
"""Read Code_Aster's MED output and require actual CZM_TURON damage."""

import json
import math
import sys

import MEDLoader


def read_damage(path):
    field_names = MEDLoader.GetAllFieldNames(path)
    field_name = next((name for name in field_names if name.endswith("VARI_ELGA")), None)
    if field_name is None:
        raise ValueError("MED result does not contain VARI_ELGA")

    iterations = MEDLoader.GetAllFieldIterations(path, field_name)
    if not iterations:
        raise ValueError("VARI_ELGA has no archived result steps")
    mesh_name = MEDLoader.GetMeshNamesOnField(path, field_name)[0]
    damage_history = []
    for iteration, order, instant in iterations:
        field = MEDLoader.ReadFieldGauss(path, mesh_name, 0, field_name, iteration, order)
        array = field.getArray()
        components = array.getInfoOnComponents()
        values = array.getValues()
        width = array.getNumberOfComponents()
        if "V3" not in components or "V5" not in components or width != len(components):
            raise ValueError("VARI_ELGA does not expose the expected CZM_TURON damage components V3 and V5")

        damage_values = values[components.index("V3")::width]
        state_values = values[components.index("V5")::width]
        if not damage_values or not state_values:
            raise ValueError("VARI_ELGA damage components are empty")
        max_damage = max(damage_values)
        max_state = max(state_values)
        if not math.isfinite(instant) or not math.isfinite(max_damage) or not math.isfinite(max_state):
            raise ValueError("VARI_ELGA damage result contains a non-finite value")
        damage_history.append({"order": order, "time": instant, "maxDamageV3": max_damage, "maxStateV5": max_state})

    final = damage_history[-1]
    if final["maxDamageV3"] <= 1e-6 or final["maxStateV5"] < 1:
        raise ValueError(
            f"CZM_TURON did not reach a damaged state at the final step: max V3={final['maxDamageV3']}, max V5={final['maxStateV5']}"
        )
    return {"instant": final["time"], "maxDamageV3": final["maxDamageV3"], "maxStateV5": final["maxStateV5"], "damageHistory": damage_history}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify-turon-damage-med.py RESULT.med")
    print("TURON_DAMAGE_ACCEPTANCE=" + json.dumps(read_damage(sys.argv[1]), sort_keys=True))
