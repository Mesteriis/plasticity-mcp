import type {
  Annotation,
  ConstructionJournalRecord,
  DimensionChangeBatch,
  ModelVersion,
  Project,
  ReferenceRecord,
  SliceJob,
  StructuredBlock,
  WorkbenchEvent,
} from "../shared/contracts.ts";

export interface WorkbenchState {
  project?: Project;
  sequence: number;
  events: WorkbenchEvent[];
  blocks: StructuredBlock[];
  versions: ModelVersion[];
  annotations: Annotation[];
  statuses: string[];
  manufacturingJobs: SliceJob[];
  dimensionChanges: DimensionChangeBatch[];
  references: ReferenceRecord[];
  constructionJournals: ConstructionJournalRecord[];
  drafts: Record<string, Record<string, string>>;
  needsRefetch: boolean;
}

export const initialWorkbenchState: WorkbenchState = {
  sequence: 0,
  events: [],
  blocks: [],
  versions: [],
  annotations: [],
  statuses: [],
  manufacturingJobs: [],
  dimensionChanges: [],
  references: [],
  constructionJournals: [],
  drafts: {},
  needsRefetch: false,
};

export type WorkbenchAction =
  | { type: "snapshot"; project: Project; events: WorkbenchEvent[] }
  | { type: "event"; event: WorkbenchEvent }
  | { type: "draft"; blockId: string; key: string; value: string }
  | { type: "clear-draft"; blockId: string };

export function reduceWorkbenchState(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  if (action.type === "draft") {
    return {
      ...state,
      drafts: {
        ...state.drafts,
        [action.blockId]: { ...state.drafts[action.blockId], [action.key]: action.value },
      },
    };
  }
  if (action.type === "clear-draft") {
    const drafts = { ...state.drafts };
    delete drafts[action.blockId];
    return { ...state, drafts };
  }
  if (action.type === "snapshot") {
    return buildSnapshot(action.project, action.events, state.drafts);
  }
  if (action.event.sequence <= state.sequence) return state;
  if (state.sequence > 0 && action.event.sequence !== state.sequence + 1) {
    return { ...state, needsRefetch: true };
  }
  return applyEvent({ ...state, sequence: action.event.sequence, events: [...state.events, action.event] }, action.event);
}

function buildSnapshot(project: Project, sourceEvents: WorkbenchEvent[], drafts: WorkbenchState["drafts"]): WorkbenchState {
  const events = [...sourceEvents].sort((left, right) => left.sequence - right.sequence);
  let state: WorkbenchState = { ...initialWorkbenchState, project, events, drafts };
  for (const event of events) {
    state = applyEvent({ ...state, sequence: event.sequence }, event);
  }
  return state;
}

function applyEvent(state: WorkbenchState, event: WorkbenchEvent): WorkbenchState {
  const payload = event.payload;
  switch (payload.type) {
    case "project.updated": return state.project && payload.project.revision < state.project.revision
      ? state
      : { ...state, project: payload.project, needsRefetch: false };
    case "model-version.published": return { ...state, versions: [...state.versions, payload.version] };
    case "structured-block.published": return { ...state, blocks: [...state.blocks, payload.block] };
    case "annotations.submitted": return { ...state, annotations: [...state.annotations, ...payload.annotations] };
    case "dimension-changes.submitted": return { ...state, dimensionChanges: [...state.dimensionChanges, payload.batch] };
    case "reference.registered": return { ...state, references: [...state.references, payload.reference] };
    case "construction-journal.published": return { ...state, constructionJournals: [...state.constructionJournals, payload.journal] };
    case "manufacturing.job-updated": return {
      ...state,
      manufacturingJobs: [...state.manufacturingJobs.filter((job) => job.id !== payload.job.id), payload.job]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
    case "status.published": return { ...state, statuses: [...state.statuses, payload.status] };
    case "codex.event": return state;
  }
}
