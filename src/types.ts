export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
}

/** 可提交的编排操作（本地应用与主控提交共用同一份定义） */
export type RundownOp =
  | { kind: "addItem"; item: RundownItem }
  | { kind: "reorder"; order: string[] }
  | { kind: "adjustDuration"; id: string; delta: number }
  | { kind: "insertBreaking"; newId: string; headline: string; duration: number; targetId: string; position: "before" | "after"; reason: string }
  | { kind: "skipItem"; id: string }
  | { kind: "updateStatus"; id: string; status: ItemStatus }
  | { kind: "replaceSnapshot"; items: RundownItem[] };

export type QueueStatus = "待提交" | "已提交" | "被拒绝" | "重复忽略";

export interface QueuedOp {
  /** 幂等键：重复提交只算一次 */
  id: string;
  seq: number;
  op: RundownOp;
  label: string;
  detail: string;
  role: Role;
  /** 入队时基于的主控版本 */
  baseVersion: number;
  queuedAt: string;
  status: QueueStatus;
  note?: string;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  targetId: string;
  targetTitle: string;
  position: "before" | "after";
  reason: string;
  createdAt: string;
}

export type HistoryKind = "应用" | "被压缩" | "被拒绝" | "撤回" | "同步";

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  label: string;
  detail: string;
  role: Role;
  reason?: string;
  time: string;
  /** 仅“应用”类条目携带，用于一键撤回 */
  snapshot?: RundownItem[];
}
