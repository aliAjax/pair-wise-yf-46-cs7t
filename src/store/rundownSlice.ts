import { createSlice, current, type PayloadAction } from "@reduxjs/toolkit";
import type { BreakingChange, HistoryEntry, HistoryKind, QueuedOp, QueueStatus, Role, RundownItem } from "../types";
import { seedItems } from "./seed";
import type { CompressedSegment, Conflict } from "./recalc";

const LOCAL_KEY = "pair-wise-yf-46/local";

export interface RundownState {
  initialized: boolean;
  items: RundownItem[];
  /** 本地编排基于的主控版本 */
  baseVersion: number;
  /** 已知的主控最新版本 */
  masterVersion: number;
  history: HistoryEntry[];
  queue: QueuedOp[];
  changes: BreakingChange[];
  role: Role;
  online: boolean;
  seq: number;
  lastConflicts: Conflict[];
}

const initialState: RundownState = {
  initialized: false,
  items: seedItems,
  baseVersion: 1,
  masterVersion: 1,
  history: [],
  queue: [],
  changes: [],
  role: "导播",
  online: true,
  seq: 0,
  lastConflicts: []
};

function makeEntry(kind: HistoryKind, label: string, detail: string, role: Role, reason?: string, snapshot?: RundownItem[]): HistoryEntry {
  return { id: crypto.randomUUID(), kind, label, detail, role, reason, time: new Date().toISOString(), snapshot };
}

export function loadPersisted(): RundownState | undefined {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return undefined;
    return { ...initialState, ...(JSON.parse(raw) as Partial<RundownState>), initialized: true, lastConflicts: [] };
  } catch {
    return undefined;
  }
}

export function persistLocal(state: RundownState): void {
  const { items, baseVersion, masterVersion, queue, changes, role, online, seq } = state;
  const snapshot = { items, baseVersion, masterVersion, queue, changes, role, online, seq, history: state.history.slice(0, 80) };
  localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<{ items: RundownItem[]; version: number }>) {
      if (state.initialized) return;
      state.items = action.payload.items.length ? action.payload.items : seedItems;
      state.baseVersion = action.payload.version;
      state.masterVersion = action.payload.version;
      state.initialized = true;
    },
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    opApplied(state, action: PayloadAction<{ label: string; detail: string; role: Role; items: RundownItem[]; compressed: CompressedSegment[]; breaking?: BreakingChange }>) {
      const { label, detail, role, items, compressed, breaking } = action.payload;
      state.history.unshift(makeEntry("应用", label, detail, role, undefined, structuredClone(current(state).items)));
      for (const seg of compressed) {
        state.history.unshift(makeEntry("被压缩", "时长压缩", `「${seg.title}」${seg.from} → ${seg.to} 分钟`, role, "为保住后续硬时间/广告窗，按播出类型自动压缩可压缩段"));
      }
      state.items = items;
      if (breaking) state.changes.unshift(breaking);
      state.lastConflicts = [];
    },
    opRejected(state, action: PayloadAction<{ label: string; detail: string; role: Role; reason: string; conflicts: Conflict[] }>) {
      const { label, detail, role, reason, conflicts } = action.payload;
      state.history.unshift(makeEntry("被拒绝", label, detail, role, reason));
      state.lastConflicts = conflicts;
    },
    clearConflicts(state) {
      state.lastConflicts = [];
    },
    enqueue(state, action: PayloadAction<Omit<QueuedOp, "seq" | "queuedAt" | "status">>) {
      state.seq += 1;
      state.queue.push({ ...action.payload, seq: state.seq, queuedAt: new Date().toISOString(), status: "待提交" });
    },
    syncDone(state, action: PayloadAction<{ results: { id: string; status: QueueStatus; note?: string }[]; audits: HistoryEntry[]; items: RundownItem[]; version: number; summary: string }>) {
      const { results, audits, items, version, summary } = action.payload;
      for (const result of results) {
        const queued = state.queue.find((q) => q.id === result.id);
        if (queued) {
          queued.status = result.status;
          queued.note = result.note;
        }
      }
      state.items = items;
      state.baseVersion = version;
      state.masterVersion = version;
      state.history.unshift(...audits.slice().reverse());
      state.history.unshift(makeEntry("同步", "应急队列提交", summary, state.role));
    },
    undoApplied(state, action: PayloadAction<{ entryId: string; restored: RundownItem[]; label: string }>) {
      const target = state.history.find((entry) => entry.id === action.payload.entryId);
      if (target) delete target.snapshot;
      state.items = action.payload.restored;
      state.history.unshift(makeEntry("撤回", "撤回操作", `撤回「${action.payload.label}」`, state.role, "一键撤回，串联单已恢复到该操作之前"));
    },
    masterSynced(state, action: PayloadAction<number>) {
      state.baseVersion = action.payload;
      state.masterVersion = action.payload;
    },
    masterChanged(state, action: PayloadAction<number>) {
      state.masterVersion = action.payload;
    }
  }
});

export const { initialize, setRole, setOnline, opApplied, opRejected, clearConflicts, enqueue, syncDone, undoApplied, masterSynced, masterChanged } = slice.actions;
export default slice.reducer;
