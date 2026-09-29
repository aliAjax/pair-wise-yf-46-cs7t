/**
 * 编排引擎 + 主控同步验证（node 运行，esbuild 即时编译）
 * 覆盖：可压缩段选择/最短保护、固定窗口保不住则整次拒绝、突发前后插入、
 * 幂等去重、主控版本漂移后只退回冲突条目、后续意图按最新顺序重算。
 */
import assert from "node:assert/strict";
import {
  applyPayload, computeSchedule, evaluateIntent, fitWithCompression, localId,
} from "../src/engine/schedule";
import { bumpMaster, commitIntent, getMaster, seedRundown } from "../src/store/api";
import type { IntentPayload, RundownItem } from "../src/types";

// --- 浏览器 API 垫片 ---
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}
(globalThis as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
(globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone ??=
  ((v: unknown) => JSON.parse(JSON.stringify(v))) as <T>(v: T) => T;

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
async function testAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// 引擎规则
// ---------------------------------------------------------------------------
console.log("引擎规则：");

test("基线时间轴：所有硬时间/广告窗均可满足", () => {
  const rows = computeSchedule(seedRundown);
  assert.deepEqual(rows.filter((r) => r.late), []);
  assert.equal(rows.find((r) => r.item.id === "r5")!.at, "08:30");
});

test("小幅加时由最靠近窗口的口播吸收，调整目标自身不被压缩", () => {
  const fit = evaluateIntent(seedRundown, { kind: "updateDuration", itemId: "r3", delta: 3 });
  assert.equal(fit.ok, true);
  assert.deepEqual(fit.compressions.map((c) => c.itemId), ["r4"]);
  assert.deepEqual(fit.compressions.map((c) => [c.from, c.to]), [[4, 3]]);
  assert.equal(fit.items.find((i) => i.id === "r3")!.duration, 15);
});

test("压缩顺序：从最靠近固定窗口的可压缩条目开始", () => {
  // 窗口 08:10，锚点前流动内容共 10 分钟、容量 10 分钟；远端条目再加 2 分钟 → 超长 2 分钟
  const items: RundownItem[] = [
    { id: "a", title: "远端口播", type: "口播", duration: 6, minDuration: 1, status: "待播", presenter: "x", source: "y" },
    { id: "b", title: "近端口播", type: "口播", duration: 4, minDuration: 1, status: "待播", presenter: "x", source: "y" },
    { id: "h", title: "整点广告", type: "广告", duration: 2, hardStart: "08:10", status: "待播", presenter: "x", source: "y" },
  ];
  // 直接制造 2 分钟超长（等价于远端条目 +2 分钟），观察压缩落点
  items[0].duration = 8;
  const fit = fitWithCompression(items);
  assert.equal(fit.ok, true);
  assert.equal(fit.items.find((i) => i.id === "b")!.duration, 2, "近端条目先被压");
  assert.equal(fit.items.find((i) => i.id === "a")!.duration, 8, "远端条目保持");
  assert.deepEqual(fit.compressions.map((c) => c.itemId), ["b"]);
});

test("压缩触底仍保不住广告窗：整次调整不生效并指出冲突条目", () => {
  const fit = evaluateIntent(seedRundown, { kind: "updateDuration", itemId: "r3", delta: 12 });
  assert.equal(fit.ok, false);
  assert.deepEqual(fit.items, seedRundown, "串联单必须原样退回");
  assert.ok(fit.conflicts.some((c) => c.kind === "广告窗" && c.itemId === "r5"));
  assert.ok(fit.conflicts.some((c) => c.itemId === "r3"), "要指出本次调整目标");
});

test("已播出条目不能调整时长", () => {
  const fit = evaluateIntent(seedRundown, { kind: "updateDuration", itemId: "r1", delta: 5 });
  assert.equal(fit.ok, false);
  assert.ok(fit.conflicts[0].detail.includes("已播出"));
});

test("突发插播：可插在指定条目前后，位置正确", () => {
  const after = applyPayload(seedRundown, { kind: "insertBreaking", localId: "b1", headline: "急讯", duration: 1, anchorId: "r2", where: "after" });
  assert.equal(after.findIndex((i) => i.id === "b1"), seedRundown.findIndex((i) => i.id === "r2") + 1);
  const before = applyPayload(seedRundown, { kind: "insertBreaking", localId: "b2", headline: "急讯", duration: 1, anchorId: "r5", where: "before" });
  assert.equal(before.findIndex((i) => i.id === "b2"), seedRundown.findIndex((i) => i.id === "r5"));
});

test("突发插播时长可被段内压缩吸收时生效（插播自身不被压）", () => {
  const fit = evaluateIntent(seedRundown, { kind: "insertBreaking", localId: "b1", headline: "急讯", duration: 2, anchorId: "r2", where: "after" });
  assert.equal(fit.ok, true);
  assert.equal(fit.items.find((i) => i.id === "b1")!.duration, 2);
  assert.equal(computeSchedule(fit.items).find((r) => r.item.id === "r5")!.at, "08:30");
});

test("突发插播会挤掉广告窗：不生效，固定窗口条目列入冲突", () => {
  const fit = evaluateIntent(seedRundown, { kind: "insertBreaking", localId: "b1", headline: "重大急讯", duration: 11, anchorId: "r2", where: "after" });
  assert.equal(fit.ok, false);
  assert.ok(fit.conflicts.some((c) => c.kind === "广告窗" && c.itemId === "r5"));
  assert.ok(fit.conflicts.some((c) => c.itemId === "b1"), "插播条目本身列入冲突");
  assert.deepEqual(fit.items, seedRundown);
});

test("拖拽排序：已播出条目位置不可移动", () => {
  const fit = evaluateIntent(seedRundown, { kind: "reorder", orderedIds: ["r2", "r1", "r3", "r4", "r5", "r6", "r7", "r8"] });
  assert.equal(fit.ok, false);
  assert.ok(fit.conflicts.some((c) => c.detail.includes("位置不可移动")));
});

test("跳过条目立即释放时长，窗口重算通过", () => {
  const fit = evaluateIntent(seedRundown, { kind: "skip", itemId: "r4" });
  assert.equal(fit.ok, true);
  assert.equal(fit.items.find((i) => i.id === "r4")!.status, "已跳过");
});

test("撤销还原意图直接回到旧快照", () => {
  const fit = evaluateIntent(seedRundown, { kind: "restore", items: seedRundown });
  assert.equal(fit.ok, true);
  assert.equal(fit.compressions.length, 0);
});

// ---------------------------------------------------------------------------
// 主控 / 队列语义
// ---------------------------------------------------------------------------
async function main() {
  console.log("主控与队列：");

  await testAsync("主控提交：重复提交同一意图只算一次（幂等）", async () => {
    const before = await getMaster();
    const payload: IntentPayload = { kind: "updateDuration", itemId: "r8", delta: 1 };
    const r1 = await commitIntent({ intentId: "dup-1", baseVersion: before.version, payload });
    assert.equal(r1.outcome, "committed");
    const r2 = await commitIntent({ intentId: "dup-1", baseVersion: r1.version, payload });
    assert.equal(r2.outcome, "duplicate");
    assert.equal(r2.version, r1.version, "重复提交不推进版本");
    const after = await getMaster();
    assert.equal(after.items.find((i) => i.id === "r8")!.duration, 4, "只生效一次（3+1）");
  });

  await testAsync("主控版本漂移：只退回冲突的那条，后续意图按最新顺序重算", async () => {
    const v0 = (await getMaster()).version;

    // I1：最新主控上会击穿广告窗的突发插播
    const i1: IntentPayload = { kind: "insertBreaking", localId: "q1", headline: "重大急讯", duration: 10, anchorId: "r2", where: "after" };
    // I2：跳过末段口播，任何版本都能通过
    const i2: IntentPayload = { kind: "skip", itemId: "r8" };

    // 离线期间主控侧把不可压缩的现场连线 r2 加长到 14 分钟（+8），
    // 主控自身恰好靠压缩嘉宾/口播吸收；本地 I1（+10 分钟）重算后只剩 2 分钟空间 → 超 4 分钟保不住广告窗
    const remote = await bumpMaster((items) => {
      items.find((i) => i.id === "r2")!.duration = 14;
      return items;
    });
    assert.ok(remote.version > v0);

    const resp1 = await commitIntent({ intentId: "i1", baseVersion: v0, payload: i1 });
    assert.equal(resp1.outcome, "conflict", "I1 按最新主控重算后冲突，被退回");
    assert.equal(resp1.version, remote.version);
    assert.ok(resp1.fit.conflicts.some((c) => c.kind === "广告窗"));

    // I2 不按旧版本连坐，基于最新主控重算并提交
    const resp2 = await commitIntent({ intentId: "i2", baseVersion: resp1.version, payload: i2 });
    assert.equal(resp2.outcome, "committed");
    assert.equal(resp2.version, remote.version + 1);

    const final = await getMaster();
    assert.equal(final.items.find((i) => i.id === "q1"), undefined, "被拒绝的插播不进串联单");
    assert.equal(final.items.find((i) => i.id === "r2")!.duration, 14, "主控改动保留");
    assert.equal(final.items.find((i) => i.id === "r8")!.status, "已跳过", "后续意图在最新顺序上生效");
    assert.equal(computeSchedule(final.items).find((r) => r.item.id === "r5")!.late, false,
      "主控加长被既有可压缩段吸收，广告窗仍准点，不被本地被拒意图影响");
  });

  await testAsync("FIFO：后到的冲突条目不连坐前面的提交", async () => {
    const master = await getMaster();
    const ok: IntentPayload = { kind: "skip", itemId: "r7" };
    const bad: IntentPayload = { kind: "updateDuration", itemId: "r1", delta: 1 }; // r1 已播出
    const r1 = await commitIntent({ intentId: "f1", baseVersion: master.version, payload: ok });
    assert.equal(r1.outcome, "committed");
    const r2 = await commitIntent({ intentId: "f2", baseVersion: r1.version, payload: bad });
    assert.equal(r2.outcome, "conflict");
    assert.equal((await getMaster()).items.find((i) => i.id === "r7")!.status, "已跳过");
  });

  console.log(`\n全部 ${passed} 项验证通过`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
