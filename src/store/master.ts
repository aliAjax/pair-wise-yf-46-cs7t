import type { RundownItem } from "../types";

const KEY = "pair-wise-yf-46/master";

/** 模拟主控端：版本号 + 最新串联单 + 已处理的幂等键 */
export interface MasterState {
  version: number;
  items: RundownItem[];
  applied: string[];
}

export function loadMaster(fallback: RundownItem[]): MasterState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MasterState;
      if (Array.isArray(parsed.items)) {
        return { version: parsed.version ?? 1, items: parsed.items, applied: parsed.applied ?? [] };
      }
    }
  } catch {
    /* 本地数据损坏时回退到种子串联单 */
  }
  return { version: 1, items: fallback, applied: [] };
}

export function saveMaster(master: MasterState): void {
  localStorage.setItem(KEY, JSON.stringify(master));
}
