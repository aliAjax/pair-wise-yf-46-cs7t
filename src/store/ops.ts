import type { RundownItem, RundownOp } from "../types";
import { recalc, type CompressedSegment, type Conflict, type RecalcResult } from "./recalc";

export interface ApplyOutcome {
  ok: boolean;
  items: RundownItem[];
  compressed: CompressedSegment[];
  conflicts: Conflict[];
  error?: string;
}

function wrap(result: RecalcResult): ApplyOutcome {
  return {
    ok: result.ok,
    items: result.items,
    compressed: result.compressed,
    conflicts: result.conflicts,
    error: result.ok ? undefined : result.conflicts.map((c) => c.reason).join("；")
  };
}

function fail(items: RundownItem[], error: string): ApplyOutcome {
  return { ok: false, items, compressed: [], conflicts: [], error };
}

/**
 * 把一条编排操作应用到给定串联单上。
 * 本地先行应用与断网恢复后提交主控走同一个入口，
 * 保证“主控版本变化后按最新顺序重算”与本地校验规则一致。
 */
export function applyOp(current: RundownItem[], op: RundownOp): ApplyOutcome {
  switch (op.kind) {
    case "addItem":
      return wrap(recalc([...current, op.item]));
    case "replaceSnapshot":
      return wrap(recalc(structuredClone(op.items)));
    case "reorder": {
      const byId = new Map(current.map((item) => [item.id, item]));
      const listed: RundownItem[] = [];
      for (const id of op.order) {
        const item = byId.get(id);
        if (!item) return fail(current, "部分条目在主控已不存在，无法按原顺序重排");
        listed.push(item);
      }
      // 主控新增的条目保持当前位置，其余按本地意图的顺序重排
      const inOrder = new Set(op.order);
      let cursor = 0;
      const merged = current.map((item) => (inOrder.has(item.id) ? listed[cursor++] : item));
      return wrap(recalc(merged));
    }
    case "adjustDuration": {
      const target = current.find((entry) => entry.id === op.id);
      if (!target) return fail(current, "目标条目在主控已不存在");
      const next = current.map((entry) => (entry.id === op.id ? { ...entry, duration: Math.max(1, entry.duration + op.delta) } : entry));
      return wrap(recalc(next));
    }
    case "insertBreaking": {
      const index = current.findIndex((entry) => entry.id === op.targetId);
      if (index < 0) return fail(current, "插播位置对应的条目在主控已不存在");
      const at = op.position === "before" ? index : index + 1;
      const breaking: RundownItem = {
        id: op.newId,
        title: op.headline,
        type: "新闻片",
        duration: op.duration,
        status: "待播",
        presenter: "值班主播",
        source: `插播：${op.reason}`
      };
      return wrap(recalc([...current.slice(0, at), breaking, ...current.slice(at)]));
    }
    case "skipItem": {
      if (!current.some((entry) => entry.id === op.id)) return fail(current, "目标条目在主控已不存在");
      return wrap(recalc(current.map((entry) => (entry.id === op.id ? { ...entry, status: "已跳过" } : entry))));
    }
    case "updateStatus": {
      if (!current.some((entry) => entry.id === op.id)) return fail(current, "目标条目在主控已不存在");
      return wrap(recalc(current.map((entry) => (entry.id === op.id ? { ...entry, status: op.status } : entry))));
    }
  }
}
