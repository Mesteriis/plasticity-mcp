export type ToolCatalogMode = "compact" | "full";

// Keep the common connect, inspect, change-tracking, and delivery path visible.
// Every other registered operation remains discoverable and callable through plasticity_call.
const compactTools = new Set([
  "plasticity_list_windows",
  "plasticity_connect",
  "plasticity_status",
  "plasticity_current_selection",
  "plasticity_list_bodies",
  "plasticity_body_info",
  "plasticity_capture_snapshot",
  "plasticity_changes_since",
  "plasticity_reconcile",
  "plasticity_screenshot",
]);

export function exposeDirectTool(mode: ToolCatalogMode, name: string): boolean {
  return mode === "full" || compactTools.has(name);
}
