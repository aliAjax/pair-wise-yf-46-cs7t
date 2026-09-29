import { message } from "antd";
import type { AppDispatch, RootState } from ".";
import type { BreakingChange, HistoryEntry, QueueStatus, RundownOp } from "../types";
import { applyOp } from "./ops";
import { loadMaster, saveMaster } from "./master";
import { seedItems } from "./seed";
import { enqueue, masterChanged, masterSynced, opApplied, opRejected, syncDone, undoApplied } from "./rundownSlice";

type Thunk = (dispatch: AppDispatch, getState: () => RootState) => void;

/**
 * 导播发起一次编排调整：先本地重算校验，
 * 在线则直接写入主控，断网则进入本地应急队列。
 */
export function performOp(op: RundownOp, label: string, detail: string, breaking?: Omit<BreakingChange, "id" | "createdAt">): Thunk {
  return (dispatch, getState) => {
    const state = getState().rundown;
    const opId = crypto.randomUUID();
    const outcome = applyOp(state.items, op);
    if (!outcome.ok) {
      const reason = outcome.error ?? "与固定窗口冲突";
      dispatch(opRejected({ label, detail, role: state.role, reason, conflicts: outcome.conflicts }));
      message.error(`调整未生效：${reason}`);
      return;
    }
    const record: BreakingChange | undefined = breaking ? { ...breaking, id: crypto.randomUUID(), createdAt: new Date().toISOString() } : undefined;
    dispatch(opApplied({ label, detail, role: state.role, items: outcome.items, compressed: outcome.compressed, breaking: record }));
    if (outcome.compressed.length) {
      message.warning(`已自动压缩 ${outcome.compressed.length} 个可压缩段以保住固定窗口`);
    }
    if (state.online) {
      const master = loadMaster(seedItems);
      const onMaster = applyOp(master.items, op);
      master.items = onMaster.ok ? onMaster.items : outcome.items;
      master.version += 1;
      master.applied.push(opId);
      saveMaster(master);
      dispatch(masterSynced(master.version));
    } else {
      dispatch(enqueue({ id: opId, op, label, detail, role: state.role, baseVersion: state.baseVersion }));
      message.info("已加入本地应急队列，主链路恢复后逐条提交");
    }
  };
}

/** 一键撤回最近一次应用的操作；离线时撤回本身也进入队列 */
export function undoLast(): Thunk {
  return (dispatch, getState) => {
    const state = getState().rundown;
    const entry = state.history.find((h) => h.snapshot);
    if (!entry?.snapshot) {
      message.info("没有可撤回的操作");
      return;
    }
    const restored = structuredClone(entry.snapshot);
    const undoneLabel = entry.detail ? `${entry.label}（${entry.detail}）` : entry.label;
    dispatch(undoApplied({ entryId: entry.id, restored, label: undoneLabel }));
    const opId = crypto.randomUUID();
    if (state.online) {
      const master = loadMaster(seedItems);
      master.items = restored;
      master.version += 1;
      master.applied.push(opId);
      saveMaster(master);
      dispatch(masterSynced(master.version));
    } else {
      dispatch(enqueue({ id: opId, op: { kind: "replaceSnapshot", items: restored }, label: "撤回", detail: `撤回「${entry.label}」`, role: state.role, baseVersion: state.baseVersion }));
    }
  };
}

/**
 * 主链路恢复后按操作先后逐条提交：
 * 幂等键去重（重复提交只算一次）；主控版本已变化时，
 * 只退回有冲突的那一条，其余本地意图按主控最新顺序继续重算。
 */
export function submitQueue(): Thunk {
  return (dispatch, getState) => {
    const pending = getState().rundown.queue.filter((q) => q.status === "待提交").sort((a, b) => a.seq - b.seq);
    if (!pending.length) {
      message.info("没有待提交的操作");
      return;
    }
    const master = loadMaster(seedItems);
    const results: { id: string; status: QueueStatus; note?: string }[] = [];
    const audits: HistoryEntry[] = [];

    for (const queued of pending) {
      if (master.applied.includes(queued.id)) {
        results.push({ id: queued.id, status: "重复忽略", note: "幂等键已存在，重复提交只算一次" });
        continue;
      }
      const versionBefore = master.version;
      const outcome = applyOp(master.items, queued.op);
      if (!outcome.ok) {
        const reason = outcome.error ?? "与主控最新串联单冲突";
        results.push({ id: queued.id, status: "被拒绝", note: reason });
        audits.push({ id: crypto.randomUUID(), kind: "被拒绝", label: queued.label, detail: queued.detail, role: queued.role, reason: `主控已变更：${reason}`, time: new Date().toISOString() });
        continue;
      }
      master.items = outcome.items;
      master.version += 1;
      master.applied.push(queued.id);
      results.push({ id: queued.id, status: "已提交", note: queued.baseVersion !== versionBefore ? "主控版本已变化，已按最新顺序重算" : undefined });
      for (const seg of outcome.compressed) {
        audits.push({ id: crypto.randomUUID(), kind: "被压缩", label: "同步时压缩", detail: `「${seg.title}」${seg.from} → ${seg.to} 分钟`, role: queued.role, reason: "按主控最新顺序重算时为保住固定窗口", time: new Date().toISOString() });
      }
    }
    saveMaster(master);

    const submitted = results.filter((r) => r.status === "已提交").length;
    const rejected = results.filter((r) => r.status === "被拒绝").length;
    const duplicated = results.filter((r) => r.status === "重复忽略").length;
    const summary = `逐条提交完成：已提交 ${submitted} 条 · 退回 ${rejected} 条 · 重复忽略 ${duplicated} 条（主控 v${master.version}）`;
    dispatch(syncDone({ results, audits, items: master.items, version: master.version, summary }));
    if (rejected) message.warning(`提交完成：${rejected} 条因冲突被退回，其余已按最新顺序重算`);
    else message.success("应急队列已逐条提交到主控");
  };
}

/** 演示用：模拟另一路主控直接改了串联单，制造版本分叉 */
export function simulateMasterChange(): Thunk {
  return (dispatch, getState) => {
    const master = loadMaster(seedItems);
    const at = Math.min(1, master.items.length);
    master.items = [
      ...master.items.slice(0, at),
      { id: crypto.randomUUID(), title: "主控插入口播：天气提醒", type: "口播", duration: 2, status: "待播", presenter: "主控", source: "主控" },
      ...master.items.slice(at)
    ];
    master.version += 1;
    saveMaster(master);
    dispatch(masterChanged(master.version));
    message.warning(`主控已变更：当前 v${master.version}，本地基线 v${getState().rundown.baseVersion}`);
  };
}
