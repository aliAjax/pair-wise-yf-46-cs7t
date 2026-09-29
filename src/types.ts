export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  /** 计划时长（分钟） */
  duration: number;
  /** 可压缩段的最短时长（分钟），默认 1 */
  minDuration?: number;
  /** 硬时间 HH:mm，广告窗也以此表达固定窗口 */
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 突发插播条目 */
  breaking?: boolean;
}

export type ConflictKind = "硬时间" | "广告窗" | "条目" | "操作";

export interface ConflictEntry {
  itemId?: string;
  title: string;
  kind: ConflictKind;
  detail: string;
}

export interface CompressionRecord {
  itemId: string;
  title: string;
  from: number;
  to: number;
}

export interface CompressionInfo extends CompressionRecord {
  intentId: string;
  role: Role;
  reason: string;
  at: string;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  anchorTitle: string;
  where: "before" | "after";
  reason: string;
  createdAt: string;
  outcome: "已生效" | "已拒绝";
  conflicts?: ConflictEntry[];
}

export type IntentKind = "add" | "updateDuration" | "reorder" | "insertBreaking" | "skip";
export type IntentStatus = "待提交" | "已提交" | "已拒绝" | "已撤回" | "重复忽略";

export type IntentPayload =
  | { kind: "add"; item: Omit<RundownItem, "id" | "status">; localId: string }
  | { kind: "updateDuration"; itemId: string; delta: number }
  | { kind: "reorder"; orderedIds: string[] }
  | {
      kind: "insertBreaking";
      localId: string;
      headline: string;
      duration: number;
      anchorId: string;
      where: "before" | "after";
    }
  | { kind: "skip"; itemId: string }
  | { kind: "restore"; items: RundownItem[] };

/** 一次编排意图：断网时进入本地队列，也是主控幂等提交的单位 */
export interface Intent {
  id: string;
  action: string;
  detail: string;
  payload: IntentPayload;
  role: Role;
  reason: string;
  createdAt: string;
  status: IntentStatus;
  result?: string;
  conflicts?: ConflictEntry[];
  resolvedAt?: string;
}

export type AuditOutcome = "已生效" | "已拒绝" | "被压缩" | "已撤回" | "重复忽略";

export interface AuditEntry {
  id: string;
  intentId?: string;
  action: string;
  detail: string;
  role: Role;
  reason: string;
  at: string;
  outcome: AuditOutcome;
  conflicts?: ConflictEntry[];
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
  version: number;
}
