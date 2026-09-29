import type {
  CompressionRecord,
  ConflictEntry,
  ConflictKind,
  IntentPayload,
  RundownItem,
} from "../types";

/** 开播时间（演示用固定档） */
export const SHOW_START = new Date("2026-10-08T08:00:00");

/** 开播锚点（当天分钟数）：硬时间换算成相对开播偏移时减去 */
const SHOW_OPEN_MINUTES = 8 * 60;

export function hhmmToMinutes(value?: string): number | null {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function minutesToHHMM(value: number): string {
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function effectiveDuration(item: RundownItem): number {
  return item.status === "已跳过" ? 0 : item.duration;
}

/** 只有嘉宾、口播可压缩；硬时间条目（含广告窗）、已播、已跳过、突发插播均不可压 */
export function isCompressible(item: RundownItem): boolean {
  return (
    (item.type === "嘉宾" || item.type === "口播") &&
    !item.hardStart &&
    item.status !== "已播出" &&
    item.status !== "已跳过" &&
    !item.breaking
  );
}

export function minDuration(item: RundownItem): number {
  return Math.max(1, item.minDuration ?? 1);
}

export function isAnchor(item: RundownItem): boolean {
  return Boolean(item.hardStart) && item.status !== "已跳过";
}

/** 已播出/已跳过条目位置在顺序调整中不可移动 */
export function isLocked(item: RundownItem): boolean {
  return item.status === "已播出" || item.status === "已跳过";
}

export interface TimelineRow {
  item: RundownItem;
  at: string;
  /** 相对开播的分钟数 */
  atMinutes: number;
  hardAt: string | null;
  /** 实际开始时间晚于硬时间（硬时间/广告窗保不住） */
  late: boolean;
  /** 实际开始时间早于硬时间（窗口前等待） */
  early: boolean;
  gapBefore: number;
}

/** 正向推算时间轴：硬时间条目对齐到硬时间，窗口前空档等待、窗口保不住则标红 */
export function computeSchedule(items: RundownItem[]): TimelineRow[] {
  let cursor = 0; // 相对开播的分钟数
  return items.map((item) => {
    const hardAbs = hhmmToMinutes(item.hardStart);
    const hard = hardAbs !== null ? hardAbs - SHOW_OPEN_MINUTES : null;
    const atMinutes = hard !== null ? Math.max(cursor, hard) : cursor;
    const late = hard !== null && cursor > hard;
    const early = hard !== null && cursor < hard;
    const row: TimelineRow = {
      item,
      at: minutesToHHMM(atMinutes + SHOW_OPEN_MINUTES),
      atMinutes,
      hardAt: hard !== null ? minutesToHHMM(hard + SHOW_OPEN_MINUTES) : null,
      late,
      early,
      gapBefore: atMinutes - cursor,
    };
    cursor = atMinutes + effectiveDuration(item);
    return row;
  });
}

export interface FitResult {
  ok: boolean;
  /** 压缩（或直接通过）后的条目 */
  items: RundownItem[];
  compressions: CompressionRecord[];
  conflicts: ConflictEntry[];
}

interface Segment {
  /** 本段结束锚点在 items 中的下标 */
  anchorIndex: number;
  anchorAt: number;
  memberIndexes: number[];
}

function anchorConflict(anchor: RundownItem, detail: string): ConflictEntry {
  return {
    itemId: anchor.id,
    title: anchor.title,
    kind: anchor.type === "广告" ? "广告窗" : "硬时间",
    detail,
  };
}

function opConflict(detail: string): ConflictEntry {
  return { title: "本次调整", kind: "操作", detail };
}

/**
 * 结构性前置校验：不依赖固定窗口的硬性规则
 * - 调整目标必须存在
 * - 已播出/已跳过条目位置不可移动
 * - 突发插播的锚点必须存在
 */
export function validateIntent(items: RundownItem[], payload: IntentPayload): ConflictEntry[] {
  const conflicts: ConflictEntry[] = [];
  switch (payload.kind) {
    case "updateDuration": {
      const target = items.find((i) => i.id === payload.itemId);
      if (!target) {
        conflicts.push(opConflict("要调整时长的条目已不存在于最新串联单"));
      } else if (target.status === "已播出") {
        conflicts.push({ itemId: target.id, title: target.title, kind: "条目", detail: "已播出内容不可调整时长" });
      } else if (target.status === "已跳过") {
        conflicts.push({ itemId: target.id, title: target.title, kind: "条目", detail: "条目已跳过，不可调整时长" });
      } else {
        const nextDuration = target.duration + payload.delta;
        if (nextDuration < minDuration(target)) {
          conflicts.push({ itemId: target.id, title: target.title, kind: "条目", detail: `时长不能低于最短可播时长 ${minDuration(target)} 分钟` });
        }
      }
      break;
    }
    case "skip": {
      const target = items.find((i) => i.id === payload.itemId);
      if (!target) conflicts.push(opConflict("要取消的条目已不存在于最新串联单"));
      else if (target.status === "已播出") conflicts.push({ itemId: target.id, title: target.title, kind: "条目", detail: "已播出内容不可取消" });
      break;
    }
    case "insertBreaking": {
      const anchor = items.find((i) => i.id === payload.anchorId);
      if (!anchor) conflicts.push(opConflict("突发插播指定的锚点条目已不存在，请重新指定插入位置"));
      else if (isLocked(anchor)) conflicts.push({ itemId: anchor.id, title: anchor.title, kind: "条目", detail: "不能插在已播出/已跳过条目的前后" });
      break;
    }
    case "reorder": {
      const presentIds = new Set(items.map((i) => i.id));
      if (payload.orderedIds.length !== items.length || payload.orderedIds.some((id) => !presentIds.has(id))) {
        conflicts.push(opConflict("排序引用了已不存在的条目，请按最新串联单重新调整"));
        break;
      }
      // 已播出/已跳过条目必须留在原位置
      const byId = new Map(items.map((i) => [i.id, i]));
      for (let newIdx = 0; newIdx < payload.orderedIds.length; newIdx += 1) {
        const moved = byId.get(payload.orderedIds[newIdx])!;
        if (isLocked(moved) && items[newIdx].id !== moved.id) {
          conflicts.push({ itemId: moved.id, title: moved.title, kind: "条目", detail: `已${moved.status === "已播出" ? "播出" : "跳过"}条目的位置不可移动` });
        }
      }
      break;
    }
    default:
      break;
  }
  return conflicts;
}

/**
 * 尝试把一套编排压进所有固定窗口：
 * 按硬时间锚点分段，段内超长时先压缩可压缩段（从最靠近锚点的开始），
 * 仍保不住窗口则整次失败并列出冲突条目。
 */
export function fitWithCompression(
  source: RundownItem[],
  options: { protect?: Set<string> } = {},
): FitResult {
  const items = structuredClone(source);
  const conflicts: ConflictEntry[] = [];
  const compressions: CompressionRecord[] = [];
  const protect = options.protect ?? new Set<string>();

  const anchorAt = (item: RundownItem): number => hhmmToMinutes(item.hardStart)! - SHOW_OPEN_MINUTES;

  const anchorIdxs = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isAnchor(item));

  // 结构性检查：硬时间顺序必须单调
  let prevAt = 0;
  for (const { item } of anchorIdxs) {
    const at = anchorAt(item);
    if (at < prevAt) {
      conflicts.push(anchorConflict(item, `硬时间 ${item.hardStart} 早于上一个固定窗口`));
    }
    prevAt = at;
  }
  if (conflicts.length) {
    return { ok: false, items: source, compressions: [], conflicts };
  }

  // 以相邻锚点为界切分段（成员为锚点之前的流动条目；锚点自身时长计入下一段起点）
  const segments: Segment[] = [];
  let from = 0;
  for (const { item: anchor, index } of anchorIdxs) {
    segments.push({
      anchorIndex: index,
      anchorAt: anchorAt(anchor),
      memberIndexes: items.map((_, i) => i).filter((i) => i >= from && i < index),
    });
    from = index + 1;
  }

  let windowStart = 0;
  for (const segment of segments) {
    const anchor = items[segment.anchorIndex];
    const members = segment.memberIndexes.map((i) => items[i]);
    const capacity = segment.anchorAt - windowStart;
    const nominal = members.reduce((sum, m) => sum + effectiveDuration(m), 0);

    if (nominal <= capacity) {
      windowStart = segment.anchorAt + effectiveDuration(anchor);
      continue;
    }

    let overrun = nominal - capacity;
    const before = new Map(members.map((m) => [m.id, m.duration]));

    // 从最靠近固定窗口的可压缩条目开始压，逐条压到最短（锚点自身排除）
    const candidates = [...segment.memberIndexes]
      .reverse()
      .filter((i) => i !== segment.anchorIndex)
      .map((i) => items[i])
      .filter((m) => isCompressible(m) && !protect.has(m.id));

    for (const candidate of candidates) {
      if (overrun <= 0) break;
      const floor = minDuration(candidate);
      const room = candidate.duration - floor;
      if (room <= 0) continue;
      const cut = Math.min(room, overrun);
      candidate.duration -= cut;
      overrun -= cut;
    }

    for (const member of members) {
      const oldDuration = before.get(member.id)!;
      if (member.duration < oldDuration) {
        compressions.push({ itemId: member.id, title: member.title, from: oldDuration, to: member.duration });
      }
    }

    if (overrun > 0) {
      // 段内所有可压缩段已压到底仍超长 —— 整次调整不生效，列出冲突
      const rigid = members.filter(
        (m) =>
          (!isCompressible(m) || protect.has(m.id)) &&
          effectiveDuration(m) > 0,
      );
      conflicts.push(
        anchorConflict(
          anchor,
          `${anchor.type === "广告" ? "广告窗" : "硬时间"} ${anchor.hardStart} 保不住，超出 ${overrun} 分钟`,
        ),
      );
      for (const m of rigid) {
        conflicts.push({
          itemId: m.id,
          title: m.title,
          kind: fixedKind(m),
          detail: rigidDetail(m, protect.has(m.id)),
        });
      }
    }

    windowStart = segment.anchorAt + effectiveDuration(anchor);
  }

  if (conflicts.length) {
    return { ok: false, items: source, compressions: [], conflicts };
  }
  return { ok: true, items, compressions, conflicts: [] };
}

function fixedKind(item: RundownItem): ConflictKind {
  if (item.type === "广告") return "广告窗";
  if (item.hardStart) return "硬时间";
  return "条目";
}

function rigidDetail(item: RundownItem, protectedByEdit: boolean): string {
  if (item.status === "已播出") return "已播出内容不可压缩";
  if (item.status === "已跳过") return "条目已跳过";
  if (item.hardStart) return `${item.type === "广告" ? "广告窗" : "硬时间条目"}不可压缩`;
  if (item.breaking) return "突发插播条目不可压缩";
  if (protectedByEdit) return "本次调整目标，不参与压缩";
  if (item.type === "新闻片") return "新闻片有既定成片时长，不可压缩";
  if (item.type === "连线") return "现场连线时长不可压缩";
  return "该条目类型不可压缩";
}

/** 在给定串联单上试应用一条意图，返回试算后的条目 */
export function applyPayload(items: RundownItem[], payload: IntentPayload): RundownItem[] {
  const next = structuredClone(items);
  switch (payload.kind) {
    case "add": {
      next.push({ ...payload.item, id: payload.localId, status: "草稿" });
      break;
    }
    case "updateDuration": {
      const target = next.find((i) => i.id === payload.itemId);
      if (target) target.duration = Math.max(1, target.duration + payload.delta);
      break;
    }
    case "reorder": {
      const byId = new Map(next.map((i) => [i.id, i]));
      const ordered = payload.orderedIds.map((id) => byId.get(id)).filter(Boolean) as RundownItem[];
      const rest = next.filter((i) => !payload.orderedIds.includes(i.id));
      return [...ordered, ...rest];
    }
    case "insertBreaking": {
      const idx = next.findIndex((i) => i.id === payload.anchorId);
      if (idx === -1) return next;
      const insertAt = payload.where === "before" ? idx : idx + 1;
      next.splice(insertAt, 0, {
        id: payload.localId,
        title: payload.headline,
        type: "新闻片",
        duration: payload.duration,
        status: "待播",
        presenter: "值班主播",
        source: "突发插播",
        breaking: true,
      });
      break;
    }
    case "skip": {
      const target = next.find((i) => i.id === payload.itemId);
      if (target) target.status = "已跳过";
      break;
    }
    case "restore": {
      return structuredClone(payload.items);
    }
  }
  return next;
}

/** 本次意图直接触碰的条目，压缩时必须保护，不能拿调整对象自己去填坑 */
export function protectedIds(payload: IntentPayload): Set<string> {
  switch (payload.kind) {
    case "add":
    case "insertBreaking":
      return new Set([payload.localId]);
    case "updateDuration":
      return new Set([payload.itemId]);
    case "skip":
      return new Set([payload.itemId]);
    case "restore":
      return new Set();
    default:
      return new Set();
  }
}

/** 试算一条意图：结构校验 + 应用 + 固定窗口校验压缩 */
/** 试算一条意图：结构校验 + 应用 + 固定窗口校验压缩；不生效时返回应用前的原始条目 */
export function evaluateIntent(items: RundownItem[], payload: IntentPayload): FitResult {
  const structural = validateIntent(items, payload);
  if (structural.length) {
    return { ok: false, items: structuredClone(items), compressions: [], conflicts: structural };
  }
  const draft = applyPayload(items, payload);
  const fit = fitWithCompression(draft, { protect: protectedIds(payload) });
  // 固定窗口保不住：整次意图不生效，退回应用前的原始编排（而非被改动的草稿）
  if (!fit.ok) return { ...fit, items: structuredClone(items) };
  return fit;
}

export function intentSummary(payload: IntentPayload): string {
  switch (payload.kind) {
    case "add":
      return payload.item.title;
    case "updateDuration":
      return `时长 ${payload.delta > 0 ? "+" : ""}${payload.delta} 分钟`;
    case "reorder":
      return "调整播出顺序";
    case "insertBreaking":
      return `${payload.headline}（插在锚点${payload.where === "before" ? "前" : "后"}）`;
    case "skip":
      return "取消条目";
    case "restore":
      return "撤回还原到上一版";
  }
}

let uid = 0;
export function localId(prefix: string): string {
  uid += 1;
  return `${prefix}-local-${Date.now().toString(36)}-${uid}`;
}
