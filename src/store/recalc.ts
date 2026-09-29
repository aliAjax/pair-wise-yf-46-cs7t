import type { RundownItem } from "../types";

/** 开播时间：08:00，以分钟计 */
export const BROADCAST_START = 8 * 60;

export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function formatClock(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface CompressedSegment {
  id: string;
  title: string;
  from: number;
  to: number;
}

export interface Conflict {
  itemId: string;
  title: string;
  reason: string;
}

export interface RecalcResult {
  ok: boolean;
  items: RundownItem[];
  compressed: CompressedSegment[];
  conflicts: Conflict[];
}

/** 广告窗与带硬时间的条目都是固定窗口，重算时不能挤掉 */
export function isFixedWindow(item: RundownItem): boolean {
  return item.type === "广告" || Boolean(item.hardStart);
}

/**
 * 按播出类型给出可压缩下限：
 * 口播可压到一半（至少 1 分钟），嘉宾可压到六成（至少 3 分钟），
 * 新闻片 / 连线 / 广告不可压缩；已播出、已跳过的条目不再变动。
 */
export function compressFloor(item: RundownItem): number {
  if (item.status === "已播出" || item.status === "已跳过") return item.duration;
  if (item.type === "口播") return Math.max(1, Math.ceil(item.duration / 2));
  if (item.type === "嘉宾") return Math.max(3, Math.ceil(item.duration * 0.6));
  return item.duration;
}

/** 顺序累计每条的开始分钟；带硬时间的条目不会早于硬时间开播（空档留垫片） */
export function computeStarts(items: RundownItem[]): number[] {
  const starts: number[] = [];
  let cursor = BROADCAST_START;
  for (const item of items) {
    const hard = item.hardStart ? parseClock(item.hardStart) : null;
    const start = hard !== null ? Math.max(cursor, hard) : cursor;
    starts.push(start);
    cursor = start + item.duration;
  }
  return starts;
}

/**
 * 统一重算：顺序、时长、硬时间、广告窗、突发插播都走这里。
 * 固定窗口被顶超时，从窗口向前按播出类型寻找可压缩段（就近优先）；
 * 全部压到底仍保不住时，本次调整不生效并返回冲突条目。
 */
export function recalc(input: RundownItem[]): RecalcResult {
  const items = structuredClone(input);
  const floors = new Map(items.map((item) => [item.id, compressFloor(item)]));
  const compressed = new Map<string, CompressedSegment>();
  const conflicts: Conflict[] = [];
  let starts = computeStarts(items);

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.hardStart) continue;
    const hard = parseClock(item.hardStart);
    let overflow = starts[i] - hard;
    if (overflow <= 0) continue;
    for (let j = i - 1; j >= 0 && overflow > 0; j -= 1) {
      const cand = items[j];
      const room = cand.duration - (floors.get(cand.id) ?? cand.duration);
      if (room <= 0) continue;
      const cut = Math.min(room, overflow);
      const from = cand.duration;
      cand.duration -= cut;
      overflow -= cut;
      const prev = compressed.get(cand.id);
      compressed.set(cand.id, { id: cand.id, title: cand.title, from: prev?.from ?? from, to: cand.duration });
      starts = computeStarts(items);
    }
    if (overflow > 0) {
      conflicts.push({
        itemId: item.id,
        title: item.title,
        reason: `${item.type === "广告" ? "广告窗" : "硬时间"} ${item.hardStart} 保不住：之前已无可压缩段，仍超 ${overflow} 分钟`
      });
    }
  }
  return { ok: conflicts.length === 0, items, compressed: [...compressed.values()], conflicts };
}
