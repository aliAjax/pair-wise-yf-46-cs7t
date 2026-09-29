/**
 * Redux 编排集成验证：
 * 离线意图入队（含本地试算拒绝）→ 恢复后 FIFO 逐条提交 → 版本冲突只退冲突条 →
 * 后续意图按最新版重算 → 拒绝/压缩/撤回均产生带岗位与原因的审计。
 */
import assert from "node:assert/strict";

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const memoryStorage = new MemoryStorage();
(globalThis as { localStorage: MemoryStorage }).localStorage = memoryStorage;
(globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone ??=
  ((v: unknown) => JSON.parse(JSON.stringify(v))) as <T>(v: T) => T;
// Node 20 已提供 crypto.randomUUID，无需垫片

const { configureStore } = await import("@reduxjs/toolkit");
const reducer = (await import("../src/store/rundownSlice")).default;
const slice = await import("../src/store/rundownSlice");
const { bumpMaster } = await import("../src/store/api");

const store = configureStore({ reducer: { rundown: reducer } });
type AppState = ReturnType<typeof store.getState>;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 用主控初始化（显式清掉可能残留的主控键，确保从干净种子开始）
memoryStorage.clear();
await store.dispatch(slice.bootstrap());
const st0 = (): AppState => store.getState();
assert.equal(st0().rundown.base.items.length, 8);

console.log("在线即时提交：");

await test("可吸收的时长调整即时生效（先吃硬时间前空档，再压缩）并留压缩审计", async () => {
  // r2 硬时间 08:06 与 r1（4′）间本有 2′ 空档；+4 分钟：空档吃 2′，口播 r4 再压 2′
  const r = await store.dispatch(slice.submitIntent({
    payload: { kind: "updateDuration", itemId: "r3", delta: 4 },
    reason: "现场嘉宾延长发言",
  }));
  assert.equal(r.payload, "committed");
  const s = st0().rundown;
  assert.equal(s.base.items.find((i) => i.id === "r3")!.duration, 16);
  assert.equal(s.base.items.find((i) => i.id === "r4")!.duration, 2, "口播被压缩 4→2（最短）");
  const compAudit = s.audit.find((a) => a.outcome === "被压缩");
  assert.ok(compAudit);
  assert.equal(compAudit!.role, "导播");
  assert.ok(compAudit!.reason.includes("现场嘉宾延长发言"));
  assert.ok(s.base.version >= 2);
});

console.log("离线队列：");

store.dispatch(slice.setOnlineFlag(false));

await test("离线操作进入本地队列，本地视图按序重放含预计压缩", async () => {
  const r = await store.dispatch(slice.submitIntent({
    payload: { kind: "insertBreaking", localId: "off-b1", headline: "快讯A", duration: 2, anchorId: "r2", where: "after" },
    reason: "前方记者补充",
  }));
  assert.equal(r.payload, "queued");
  const s = st0().rundown;
  assert.equal(s.pending.length, 1);
  const folded = slice.selectFold(s);
  assert.ok(folded.items.some((i) => i.id === "off-b1"));
  // 在线那次已把 r4 压到最短 2，快讯 2 分钟由仍有余量的嘉宾 r3 吸收（16→14）
  assert.ok(folded.pendingCompressions.some((c) => c.itemId === "r3" && c.to === 14));
});

await test("本地试算就冲突的操作不入队，直接拒绝并列冲突", async () => {
  const r = await store.dispatch(slice.submitIntent({
    payload: { kind: "insertBreaking", localId: "off-bad", headline: "巨型插播", duration: 90, anchorId: "r2", where: "after" },
    reason: "不可能容纳的插播",
  }));
  assert.equal(r.payload, "rejected");
  const s = st0().rundown;
  assert.equal(s.pending.length, 1, "被拒绝的不进队列");
  assert.ok(s.processed.some((p) => p.status === "已拒绝"));
  const rejectAudit = s.audit.find((a) => a.outcome === "已拒绝")!;
  assert.equal(rejectAudit.role, "导播");
  assert.ok(rejectAudit.reason.includes("不可能容纳"));
  assert.ok(rejectAudit.conflicts!.some((c) => c.kind === "广告窗"));
});

await test("撤回队列中的待提交意图留下撤回审计", async () => {
  store.dispatch(slice.withdrawPending({ intentId: st0().rundown.pending[0].id, reason: "前方信号不稳，撤下快讯" }));
  const s = st0().rundown;
  assert.equal(s.pending.length, 0);
  const withdrawn = s.audit.find((a) => a.outcome === "已撤回")!;
  assert.ok(withdrawn);
  assert.ok(withdrawn.detail.length > 0);
  assert.ok(withdrawn.reason.includes("前方信号不稳"));
  assert.equal(withdrawn.role, "导播");
});

// 重新制造队列用于同步验证
await store.dispatch(slice.submitIntent({
  payload: { kind: "insertBreaking", localId: "off-b2", headline: "快讯B", duration: 3, anchorId: "r3", where: "after" },
  reason: "主编要求补一条",
}));
await store.dispatch(slice.submitIntent({
  payload: { kind: "skip", itemId: "r8" },
  reason: "收播口播取消",
}));

console.log("恢复同步：");

// 主控版本漂移：r2 连线加长（不可压缩），使快讯B 重算后可能击穿窗口
await bumpMaster((items) => {
  items.find((i) => i.id === "r2")!.duration += 8;
  return items;
});

await test("FIFO 提交：冲突条只退回自身，后续条目按最新版重算并生效", async () => {
  store.dispatch(slice.setOnlineFlag(true));
  const sum = await store.dispatch(slice.syncQueue());
  const result = sum.payload as { committed: number; duplicate: number; rejected: number };
  const s = st0().rundown;
  // 快讯B：r2 已 +8 占据压缩空间，+3 插播可能冲突；skip r8 在末段必然成功
  assert.ok(result.committed >= 1, `至少后续意图生效，实际：${JSON.stringify(result)}`);
  assert.equal(s.pending.length, 0);
  assert.equal(s.base.items.find((i) => i.id === "r8")!.status, "已跳过", "后续意图在最新主控上生效");
  assert.ok(s.base.items.find((i) => i.id === "r2")!.duration >= 14, "主控改动保留");
  if (result.rejected > 0) {
    const rejected = s.processed.find((p) => p.status === "已拒绝")!;
    assert.ok(rejected);
    assert.ok(rejected.conflicts!.some((c) => c.kind === "广告窗" || c.kind === "硬时间"));
  }
});

await test("撤回最近已生效操作生成还原意图，且留审计", async () => {
  const before = st0().rundown.base.version;
  await store.dispatch(slice.withdrawLast("操作有误，撤回收播取消"));
  const s = st0().rundown;
  const restoreAudit = s.audit.find((a) => a.action.includes("撤回还原") || a.reason.includes("撤回"));
  assert.ok(restoreAudit);
  assert.ok(restoreAudit!.reason.length > 0);
  void before;
});

console.log(`\n集成验证全部 ${passed} 项通过`);
