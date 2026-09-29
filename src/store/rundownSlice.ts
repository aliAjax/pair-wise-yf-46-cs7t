import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  AuditEntry,
  BreakingChange,
  CompressionInfo,
  CompressionRecord,
  ConflictEntry,
  HistoryEntry,
  Intent,
  IntentPayload,
  Role,
  RundownItem,
} from "../types";
import { evaluateIntent, intentSummary, type FitResult } from "../engine/schedule";
import { bumpMaster, commitIntent, getMaster, seedRundown } from "./api";
import type { RootState } from "./index";

export const INTENT_ACTION: Record<IntentPayload["kind"], string> = {
  add: "新增条目",
  updateDuration: "调整时长",
  reorder: "调整顺序",
  insertBreaking: "突发插播",
  skip: "取消条目",
  restore: "撤回还原",
};

interface BaseState {
  version: number;
  items: RundownItem[];
}

interface State {
  initialized: boolean;
  base: BaseState;
  /** 待提交意图，FIFO：下标 0 最早 */
  pending: Intent[];
  /** 已有结论的意图（已提交/已拒绝/已撤回/重复忽略） */
  processed: Intent[];
  history: HistoryEntry[];
  audit: AuditEntry[];
  compressionLog: CompressionInfo[];
  changes: BreakingChange[];
  role: Role;
  online: boolean;
  syncing: boolean;
  lastRejection: { id: string; action: string; detail: string; conflicts: ConflictEntry[]; at: string } | null;
}

const initialState: State = {
  initialized: false,
  base: { version: 1, items: structuredClone(seedRundown) },
  pending: [],
  processed: [],
  history: [],
  audit: [],
  compressionLog: [],
  changes: [],
  role: "导播",
  online: true,
  syncing: false,
  lastRejection: null,
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeIntent(role: Role, payload: IntentPayload, reason: string): Intent {
  return {
    id: crypto.randomUUID(),
    action: INTENT_ACTION[payload.kind],
    detail: intentSummary(payload),
    payload,
    role,
    reason,
    createdAt: nowIso(),
    status: "待提交",
  };
}

function pushAudit(state: State, entry: Omit<AuditEntry, "id" | "at"> & { at?: string }): void {
  state.audit.unshift({ id: crypto.randomUUID(), at: entry.at ?? nowIso(), ...entry });
}

function recordBreaking(state: State, intent: Intent, items: RundownItem[], outcome: "已生效" | "已拒绝", conflicts?: ConflictEntry[]): void {
  if (intent.payload.kind !== "insertBreaking") return;
  const p = intent.payload;
  const anchor = items.find((i) => i.id === p.anchorId) ?? { title: "指定条目" };
  state.changes.unshift({
    id: intent.id,
    headline: p.headline,
    duration: p.duration,
    anchorTitle: anchor.title,
    where: p.where,
    reason: intent.reason,
    createdAt: intent.createdAt,
    outcome,
    conflicts,
  });
}

interface Resolution {
  intent: Intent;
  outcome: "committed" | "conflict" | "duplicate";
  version: number;
  items: RundownItem[];
  fit?: FitResult;
  prevItems: RundownItem[];
  prevVersion: number;
}

function settle(state: State, r: Resolution): void {
  const at = nowIso();
  const idx = state.pending.findIndex((i) => i.id === r.intent.id);
  if (idx >= 0) state.pending.splice(idx, 1);
  const intent: Intent = { ...r.intent, resolvedAt: at };

  if (r.outcome === "duplicate") {
    intent.status = "重复忽略";
    intent.result = "主控已收录同一意图，重复提交只算一次";
    state.processed.unshift(intent);
    pushAudit(state, {
      intentId: intent.id, action: intent.action, detail: intent.detail,
      role: intent.role, reason: "重复提交（幂等去重）", outcome: "重复忽略", at,
    });
    return;
  }

  if (r.outcome === "conflict" || !r.fit) {
    intent.status = "已拒绝";
    intent.conflicts = r.fit?.conflicts;
    intent.result = "主控版本已变化，按最新顺序重算后仍与固定窗口冲突";
    state.processed.unshift(intent);
    state.base = { version: r.version, items: r.items };
    state.lastRejection = { id: intent.id, action: intent.action, detail: intent.detail, conflicts: r.fit?.conflicts ?? [], at };
    pushAudit(state, {
      intentId: intent.id, action: intent.action, detail: intent.detail,
      role: intent.role, reason: intent.reason, outcome: "已拒绝",
      conflicts: r.fit?.conflicts, at,
    });
    recordBreaking(state, intent, r.items, "已拒绝", r.fit?.conflicts);
    return;
  }

  intent.status = "已提交";
  state.processed.unshift(intent);
  state.base = { version: r.version, items: r.items };
  state.history.unshift({
    id: crypto.randomUUID(), label: intent.action, detail: intent.detail,
    time: at, snapshot: structuredClone(r.prevItems), version: r.prevVersion,
  });
  pushAudit(state, {
    intentId: intent.id, action: intent.action, detail: intent.detail,
    role: intent.role, reason: intent.reason, outcome: "已生效", at,
  });
  for (const c of r.fit.compressions) {
    state.compressionLog.unshift({ ...c, intentId: intent.id, role: intent.role, reason: intent.reason, at });
    pushAudit(state, {
      intentId: intent.id, action: "压缩时长", detail: `${c.title} ${c.from} → ${c.to} 分钟`,
      role: intent.role, reason: `为给「${intent.detail}」腾出固定窗口：${intent.reason}`,
      outcome: "被压缩", at,
    });
  }
  recordBreaking(state, intent, r.items, "已生效");
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initBase(state, action: PayloadAction<BaseState>) {
      if (!state.initialized) {
        state.base = action.payload;
        state.initialized = true;
      }
    },
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
    },
    setOnlineFlag(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    dismissRejection(state) {
      state.lastRejection = null;
    },
    enqueueIntent(state, action: PayloadAction<Intent>) {
      state.pending.push(action.payload);
    },
    setSyncing(state, action: PayloadAction<boolean>) {
      state.syncing = action.payload;
    },
    markAired(state, action: PayloadAction<{ itemId: string }>) {
      // 播出状态标记：只用于岗位跟进，不改变顺序/时长/固定窗口，故不走意图
      const target = state.base.items.find((i) => i.id === action.payload.itemId);
      if (target) target.status = "已播出";
    },
    resolveOne(state, action: PayloadAction<Resolution>) {
      settle(state, action.payload);
    },
    withdrawPending(state, action: PayloadAction<{ intentId: string; reason: string }>) {
      const idx = state.pending.findIndex((i) => i.id === action.payload.intentId);
      if (idx < 0) return;
      const intent = { ...state.pending.splice(idx, 1)[0], status: "已撤回" as const, result: action.payload.reason, resolvedAt: nowIso() };
      state.processed.unshift(intent);
      pushAudit(state, {
        intentId: intent.id, action: intent.action, detail: intent.detail,
        role: state.role, reason: action.payload.reason, outcome: "已撤回",
      });
    },
  },
});

export const { initBase, setRole, setOnlineFlag, dismissRejection, enqueueIntent, setSyncing, markAired, resolveOne, withdrawPending } = slice.actions;

// ---------------------------------------------------------------------------
// thunks
// ---------------------------------------------------------------------------

export interface SubmitInput {
  payload: IntentPayload;
  reason: string;
}
export type SubmitOutcome = "committed" | "queued" | "rejected";

/** 提交一条编排意图：先本地试算（失败当场不生效），在线则立即提交主控，离线进入本地队列 */
export const submitIntent = createAsyncThunk<SubmitOutcome, SubmitInput, { state: RootState }>(
  "rundown/submitIntent",
  async (input, { getState, dispatch }) => {
    const root = getState();
    const intent = makeIntent(root.rundown.role, input.payload, input.reason);

    // 先在当前本地编排（含待提交意图）上试算
    const folded = selectFoldedItems(root.rundown);
    const localFit = evaluateIntent(folded, input.payload);
    if (!localFit.ok) {
      dispatch(resolveOne({
        intent, outcome: "conflict",
        version: root.rundown.base.version, items: root.rundown.base.items,
        fit: localFit, prevItems: root.rundown.base.items, prevVersion: root.rundown.base.version,
      }));
      return "rejected";
    }

    if (!root.rundown.online) {
      // 断网：进入本地队列（由 settle 之外的途径入队——直接派发一个内部动作）
      dispatch(enqueueIntent(intent));
      return "queued";
    }

    const resp = await commitIntent({
      intentId: intent.id, baseVersion: root.rundown.base.version, payload: input.payload,
    });
    if (resp.outcome === "duplicate") {
      dispatch(resolveOne({ intent, outcome: "duplicate", version: resp.version, items: resp.items, prevItems: root.rundown.base.items, prevVersion: root.rundown.base.version }));
      return "committed";
    }
    if (resp.outcome === "conflict") {
      dispatch(resolveOne({ intent, outcome: "conflict", version: resp.version, items: resp.items, fit: resp.fit, prevItems: root.rundown.base.items, prevVersion: root.rundown.base.version }));
      return "rejected";
    }
    dispatch(resolveOne({ intent, outcome: "committed", version: resp.version, items: resp.items, fit: resp.fit, prevItems: root.rundown.base.items, prevVersion: root.rundown.base.version }));
    return "committed";
  },
);

/** 断网恢复后：按操作先后逐条提交；重复只算一次；版本冲突只退回该条，其余按最新顺序重算 */
export const syncQueue = createAsyncThunk<{ committed: number; duplicate: number; rejected: number }, void, { state: RootState }>(
  "rundown/syncQueue",
  async (_arg, { getState, dispatch }) => {
    dispatch(setSyncing(true));
    const result = { committed: 0, duplicate: 0, rejected: 0 };
    for (;;) {
      const intent = getState().rundown.pending[0];
      if (!intent) break;
      const baseBefore = getState().rundown.base;
      const resp = await commitIntent({ intentId: intent.id, baseVersion: baseBefore.version, payload: intent.payload });
      if (resp.outcome === "duplicate") {
        dispatch(resolveOne({ intent, outcome: "duplicate", version: resp.version, items: resp.items, prevItems: baseBefore.items, prevVersion: baseBefore.version }));
        result.duplicate += 1;
      } else if (resp.outcome === "conflict") {
        dispatch(resolveOne({ intent, outcome: "conflict", version: resp.version, items: resp.items, fit: resp.fit, prevItems: baseBefore.items, prevVersion: baseBefore.version }));
        result.rejected += 1;
      } else {
        dispatch(resolveOne({ intent, outcome: "committed", version: resp.version, items: resp.items, fit: resp.fit, prevItems: baseBefore.items, prevVersion: baseBefore.version }));
        result.committed += 1;
      }
    }
    dispatch(setSyncing(false));
    return result;
  },
);

export interface SyncSummary {
  committed: number;
  duplicate: number;
  rejected: number;
}

/** 撤回：优先撤回本地队列中最近的意图；队列空时撤回最近一次已生效操作（生成还原意图提交主控） */
export const withdrawLast = createAsyncThunk<void, string, { state: RootState }>(
  "rundown/withdrawLast",
  async (reason, { getState, dispatch }) => {
    const state = getState().rundown;
    const latestPending = state.pending[state.pending.length - 1];
    if (latestPending) {
      dispatch(withdrawPending({ intentId: latestPending.id, reason }));
      return;
    }
    const lastEntry = state.history[0];
    if (!lastEntry) return;
    const outcome = await dispatch(submitIntent({
      payload: { kind: "restore", items: structuredClone(lastEntry.snapshot) },
      reason: `撤回「${lastEntry.label}：${lastEntry.detail}」——${reason}`,
    }));
    void outcome;
  },
);

/** 拉取主控（启动时） */
export const bootstrap = createAsyncThunk("rundown/bootstrap", async (_arg, { dispatch }) => {
  const master = await getMaster();
  dispatch(initBase({ version: master.version, items: master.items }));
});

/** 演示：离线期间主控侧被他人改动不可压缩的现场连线，制造版本漂移与重算冲突 */
export const simulateRemoteChange = createAsyncThunk<number, void, { state: RootState }>(
  "rundown/simulateRemoteChange",
  async () => {
    const next = await bumpMaster((items) => {
      const live = items.find((i) => i.type === "连线" && i.status !== "已播出");
      if (live) live.duration += 8; // 连线不可压缩：主控靠既有可压缩段吸收，本地大意图重算时可能击穿窗口
      return items;
    });
    return next.version;
  },
);

/** 重放已拒绝的意图：基于最新主控重新提交一次（新意图，不影响幂等） */
export const retryIntent = createAsyncThunk<void, string, { state: RootState }>(
  "rundown/retryIntent",
  async (intentId, { getState, dispatch }) => {
    const original = getState().rundown.processed.find((i) => i.id === intentId);
    if (!original) return;
    await dispatch(submitIntent({ payload: original.payload, reason: `冲突处理后重新提交（原操作：${original.reason}）` }));
  },
);

// ---------------------------------------------------------------------------
// selectors：本地视图 = 主控基线 + 待提交意图按序重放（重放即试算，含压缩结果）
// ---------------------------------------------------------------------------

export interface FoldResult {
  items: RundownItem[];
  /** 待提交意图重放过程中预计发生的压缩 */
  pendingCompressions: CompressionRecord[];
}

export function selectFold(state: State): FoldResult {
  let items = structuredClone(state.base.items);
  const pendingCompressions: CompressionRecord[] = [];
  for (const intent of state.pending) {
    const fit = evaluateIntent(items, intent.payload);
    if (fit.ok) {
      items = fit.items;
      pendingCompressions.push(...fit.compressions);
    }
  }
  return { items, pendingCompressions };
}

export function selectFoldedItems(state: State): RundownItem[] {
  return selectFold(state).items;
}

export default slice.reducer;
