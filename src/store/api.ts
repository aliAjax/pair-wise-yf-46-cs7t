import type { RundownItem } from "../types";
import { evaluateIntent, type FitResult } from "../engine/schedule";

/**
 * 主控服务（用 localStorage 模拟主链路）：
 * - 持有权威串联单与单调递增的版本号
 * - commit 按意图 id 幂等：重复提交只算一次
 * - baseVersion 已落后时按最新主控重算，仅退回本次冲突
 */

const STORE_KEY = "pair-wise-yf-46/master";
const LATENCY = 240;

export const seedRundown: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 6, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, minDuration: 6, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "市场数据口播", type: "口播", duration: 4, minDuration: 2, status: "待播", presenter: "林晓", source: "提词器" },
  { id: "r5", title: "整点广告", type: "广告", duration: 4, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" },
  { id: "r6", title: "整点新闻提要", type: "新闻片", duration: 4, hardStart: "08:34", status: "待播", presenter: "林晓", source: "主控" },
  { id: "r7", title: "民生话题讨论", type: "嘉宾", duration: 10, minDuration: 5, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r8", title: "天气与收播", type: "口播", duration: 3, minDuration: 1, status: "待播", presenter: "林晓", source: "提词器" },
];

interface MasterState {
  version: number;
  items: RundownItem[];
  seen: Record<string, number>; // intentId -> 提交时版本（幂等表）
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LATENCY));
}

function read(): MasterState {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as MasterState;
    } catch {
      // fallthrough，重建
    }
  }
  const initial: MasterState = { version: 1, items: structuredClone(seedRundown), seen: {} };
  localStorage.setItem(STORE_KEY, JSON.stringify(initial));
  return initial;
}

function write(next: MasterState): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
}

export interface MasterSnapshot {
  version: number;
  items: RundownItem[];
}

export async function getMaster(): Promise<MasterSnapshot> {
  await delay();
  const state = read();
  return { version: state.version, items: structuredClone(state.items) };
}

export type CommitResponse =
  | { outcome: "committed"; version: number; items: RundownItem[]; fit: FitResult }
  | { outcome: "duplicate"; version: number; items: RundownItem[] }
  | { outcome: "conflict"; version: number; items: RundownItem[]; fit: FitResult };

export interface CommitRequest {
  intentId: string;
  baseVersion: number;
  payload: Parameters<typeof evaluateIntent>[1];
}

export async function commitIntent(req: CommitRequest): Promise<CommitResponse> {
  await delay();
  const state = read();

  // 幂等：同一意图重复提交只算一次，直接回放当时结果
  if (state.seen[req.intentId] !== undefined) {
    return { outcome: "duplicate", version: state.version, items: structuredClone(state.items) };
  }

  // 主控版本已变化：不按旧版本拒绝，而是针对最新主控重算这一条
  const fit = evaluateIntent(state.items, req.payload);
  if (!fit.ok) {
    return { outcome: "conflict", version: state.version, items: structuredClone(state.items), fit };
  }

  state.items = fit.items;
  state.version += 1;
  state.seen[req.intentId] = state.version;
  write(state);
  return { outcome: "committed", version: state.version, items: structuredClone(state.items), fit };
}

/** 主控侧发生改动（演示用）：直接改写权威串联单并推进版本 */
export async function bumpMaster(mutate: (items: RundownItem[]) => RundownItem[]): Promise<MasterSnapshot> {
  await delay();
  const state = read();
  state.items = mutate(structuredClone(state.items));
  state.version += 1;
  write(state);
  return { version: state.version, items: structuredClone(state.items) };
}
