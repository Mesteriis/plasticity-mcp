import type { AnnotationInput } from "../../shared/contracts.ts";

const DATABASE = "plasticity-workbench";
const STORE = "annotation-drafts";

export async function loadAnnotationDraft(projectId: string, modelVersionId: string): Promise<AnnotationInput[]> {
  if (typeof indexedDB === "undefined") return [];
  const database = await openDraftDatabase();
  return await new Promise((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key(projectId, modelVersionId));
    request.onsuccess = () => resolve((request.result as AnnotationInput[] | undefined) ?? []);
    request.onerror = () => reject(request.error ?? new Error("Could not read annotation draft"));
  });
}

export async function saveAnnotationDraft(projectId: string, modelVersionId: string, annotations: AnnotationInput[]): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDraftDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    if (annotations.length === 0) store.delete(key(projectId, modelVersionId));
    else store.put(annotations, key(projectId, modelVersionId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save annotation draft"));
  });
}

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open annotation draft database"));
  });
}

function key(projectId: string, modelVersionId: string): string {
  return `${projectId}:${modelVersionId}`;
}
