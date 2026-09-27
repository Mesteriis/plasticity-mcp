import type { AnnotationBatchInput, DimensionChangeBatchInput, ManufacturingProfile, PairingGrant, PrinterStatus, Project, SliceJob, WorkbenchEvent } from "../shared/contracts.ts";

export class BrowserApi {
  async projects(): Promise<Project[]> {
    return this.request("GET", "/api/projects");
  }

  async createProject(name: string): Promise<Project> {
    return this.request("POST", "/api/projects", { name });
  }

  async snapshot(projectId: string): Promise<{ project: Project; events: WorkbenchEvent[] }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}`);
  }

  async submitAnnotations(projectId: string, batch: AnnotationBatchInput): Promise<unknown> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/annotations`, batch);
  }

  async exchangePairing(code: string): Promise<{ projectId: string; role: string }> {
    return this.request("POST", "/api/pair/exchange", { code });
  }

  async createPairing(projectId: string): Promise<{ id: string; url: string; qrDataUrl: string; expiresAt: string }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/pairings`, { role: "annotate", ttlMs: 24 * 60 * 60 * 1_000 });
  }

  async pairings(projectId: string): Promise<PairingGrant[]> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/pairings`);
  }

  async revokePairing(projectId: string, pairingId: string): Promise<void> {
    await this.request("DELETE", `/api/projects/${encodeURIComponent(projectId)}/pairings/${encodeURIComponent(pairingId)}`);
  }

  async submitDimensionChanges(projectId: string, batch: DimensionChangeBatchInput): Promise<unknown> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/dimension-changes`, batch);
  }

  async manufacturingProfiles(projectId: string): Promise<{ profiles: ManufacturingProfile[]; adapters: Array<{ id: string; available: boolean }> }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/profiles`);
  }

  async manufacturingJobs(projectId: string): Promise<SliceJob[]> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs`);
  }

  async printerStatus(projectId: string, profile: ManufacturingProfile): Promise<PrinterStatus> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/printer-status`, { profile });
  }

  async approvePrint(projectId: string, jobId: string): Promise<SliceJob> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/manufacturing/jobs/${encodeURIComponent(jobId)}/approve`, { confirmed: true });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = response.status === 204 ? undefined : await response.json() as unknown;
    if (!response.ok) throw new Error(JSON.stringify(payload));
    return payload as T;
  }
}
