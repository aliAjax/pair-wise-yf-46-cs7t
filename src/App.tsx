import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Badge, Button, Card, Form, Input, InputNumber, Modal, Select, Switch, Tag, Timeline, Tooltip, message } from "antd";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { shallowEqual } from "react-redux";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  bootstrap, dismissRejection, markAired, selectFold, setOnlineFlag, setRole, simulateRemoteChange,
  submitIntent, syncQueue, withdrawLast, withdrawPending, retryIntent,
} from "./store/rundownSlice";
import type { ItemType, Role } from "./types";
import { computeSchedule, evaluateIntent, localId } from "./engine/schedule";
import type { AppDispatch } from "./store";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1), hardStart: z.string().regex(/^\d{2}:\d{2}$/).or(z.literal("")).optional() });
type FormValues = z.infer<typeof schema>;

const intentStatusColor: Record<string, string> = { 待提交: "red", 已提交: "green", 已拒绝: "red", 已撤回: "default", 重复忽略: "default" };

/** 统一提交入口：按返回结果给出提示 */
async function runIntent(dispatch: AppDispatch, payload: Parameters<typeof submitIntent>[0]["payload"], reason: string): Promise<void> {
  const outcome = await dispatch(submitIntent({ payload, reason })).unwrap();
  if (outcome === "queued") message.warning("已进入本地应急队列，主链路恢复后按顺序提交");
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const { role, online, lastRejection } = useAppSelector((state) => state.rundown);
  const baseVersion = useAppSelector((state) => state.rundown.base.version);
  const fold = useAppSelector((state) => selectFold(state.rundown), shallowEqual);
  const items = fold.items;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const timeline = useMemo(() => computeSchedule(items), [items]);
  const total = items.reduce((sum, item) => sum + (item.status === "已跳过" ? 0 : item.duration), 0);
  const lateRows = timeline.filter((row) => row.late);
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控", hardStart: "" } });

  const compressedMap = new Map(fold.pendingCompressions.map((c) => [c.itemId, c.from]));

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || role !== "导播") return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const next = [...items];
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    Modal.confirm({
      title: "确认调整顺序",
      content: "系统将按播出类型和硬时间寻找可压缩段；若广告窗或下一档硬时间保不住，本次调整不生效。",
      okText: "调整并重算",
      cancelText: "再想想",
      onOk: () => runIntent(dispatch, { kind: "reorder", orderedIds: next.map((i) => i.id) }, "导播拖动调整播出顺序"),
    });
  };

  const submit = (values: FormValues) => {
    void runIntent(dispatch, {
      kind: "add",
      localId: localId("item"),
      item: { title: values.title, type: values.type as ItemType, duration: values.duration, presenter: values.presenter, source: values.source, hardStart: values.hardStart || undefined },
    }, "新增播出条目");
    reset();
  };

  const askWithdraw = () => {
    let reason = "";
    Modal.confirm({
      title: "撤回上一步",
      content: <Input.TextArea placeholder="撤回原因（将记录岗位与原因）" onChange={(e) => { reason = e.target.value; }} />,
      okText: "确认撤回",
      cancelText: "取消",
      onOk: () => {
        if (reason.trim().length < 2) {
          message.error("请填写撤回原因");
          throw new Error("missing reason");
        }
        return dispatch(withdrawLast(reason.trim()));
      },
    });
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading">
        <div><small>2026-10-08 · 08:00 开播 · 主控版本 v{baseVersion}</small><h2>直播串联单</h2></div>
        <div className="head-actions">
          <Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag>
          <Button onClick={askWithdraw} disabled={role === "字幕"}>撤回上一步</Button>
        </div>
      </div>
      {lastRejection && <Alert
        className="reject-alert"
        type="error" showIcon banner
        message={`调整未生效：${lastRejection.action} · ${lastRejection.detail}`}
        description={<ul className="conflict-list">{lastRejection.conflicts.map((c, i) => <li key={i}><Tag color={c.kind === "广告窗" ? "gold" : "red"}>{c.kind}</Tag><b>{c.title}</b>：{c.detail}</li>)}</ul>}
        action={<Button size="small" onClick={() => dispatch(dismissRejection())}>知道了</Button>}
      />}
      <div className="summary">
        <span><b>{items.length}</b> 条内容</span>
        <span><b>{total}</b> 分钟总时长</span>
        <span className={lateRows.length ? "danger-text" : ""}><b>{lateRows.length}</b> 个窗口风险</span>
        <span><b>{timeline.at(-1)?.at ?? "--:--"}</b> 预计收播</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{timeline.map(({ item, at, hardAt, late, early }) => <SortableItem
            key={item.id} item={item} cumulative={at} hardAt={hardAt} late={late} early={early}
            canEdit={role === "导播"}
            compressedFrom={compressedMap.get(item.id)}
            onDuration={(delta) => {
              const target = items.find((i) => i.id === item.id);
              if (!target) return;
              void runIntent(dispatch, { kind: "updateDuration", itemId: item.id, delta },
                `${delta > 0 ? "现场拉长节奏" : "现场压缩节奏"}（${item.title}）`);
            }}
            onStatus={() => {
              dispatch(markAired({ itemId: item.id }));
              message.success(`「${item.title}」已标记播出，后续重算不再移动该条目`);
            }}
            onSkip={() => Modal.confirm({
              title: `取消「${item.title}」`,
              content: "取消后该条目不占时长，系统立即重算固定窗口。",
              okText: "确认取消", okButtonProps: { danger: true }, cancelText: "再想想",
              onOk: () => runIntent(dispatch, { kind: "skip", itemId: item.id }, "导播取消条目"),
            })}
          />)}</div>
        </SortableContext>
      </DndContext>
      {fold.pendingCompressions.length > 0 && <p className="pending-note">本地队列重放预计压缩：{fold.pendingCompressions.map((c) => `${c.title} ${c.from}→${c.to}′`).join("，")}（提交时确认）</p>}
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols">
            <Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片", "连线", "嘉宾", "口播", "广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item>
            <Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item>
          </div>
          <Form.Item label="硬时间/广告窗（留空为浮动条目）"><Controller name="hardStart" control={control} render={({ field }) => <Input {...field} placeholder="HH:mm，如 08:30" />} /></Form.Item>
          <div className="two-cols">
            <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
            <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          </div>
          <Button htmlType="submit" type="primary" block disabled={role === "字幕"}>加入串联单并重算</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { online, role } = useAppSelector((state) => state.rundown);
  const items = useAppSelector((state) => selectFold(state.rundown).items, shallowEqual);
  const [headline, setHeadline] = useState("");
  const [duration, setDuration] = useState(5);
  const [anchorId, setAnchorId] = useState(items[0]?.id ?? "");
  const [where, setWhere] = useState<"before" | "after">("after");
  const [reason, setReason] = useState("突发新闻");

  useEffect(() => {
    if (!items.some((i) => i.id === anchorId)) setAnchorId(items[0]?.id ?? "");
  }, [items, anchorId]);

  const submit = () => {
    const payload = { kind: "insertBreaking" as const, localId: localId("breaking"), headline, duration, anchorId, where };
    const fit = evaluateIntent(items, payload);
    if (!fit.ok) {
      Modal.error({
        title: "突发插播不生效：固定窗口会被挤掉",
        content: <ul className="conflict-list">{fit.conflicts.map((c, i) => <li key={i}><Tag color={c.kind === "广告窗" ? "gold" : "red"}>{c.kind}</Tag><b>{c.title}</b>：{c.detail}</li>)}</ul>,
      });
      return;
    }
    void runIntent(dispatch, payload, reason);
    setHeadline("");
    if (!online) message.warning("已进入本地应急队列");
  };

  return <Card title="突发插播" className="breaking-card">
    <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="插播标题" />
    <div className="two-cols">
      <InputNumber value={duration} min={1} max={60} onChange={(v) => setDuration(Number(v ?? 5))} addonAfter="分钟" />
      <Select value={where} onChange={(v) => setWhere(v)} options={[{ value: "before", label: "插在条目前" }, { value: "after", label: "插在条目后" }]} />
    </div>
    <Select value={anchorId} onChange={setAnchorId} style={{ width: "100%" }} options={items.map((item) => ({ value: item.id, label: `${item.hardStart ? "🔒 " : ""}「${item.title}」` }))} />
    <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="插播原因（留岗审计）" />
    <Button type="primary" danger block disabled={headline.length < 2 || role === "字幕"} onClick={submit}>立即插入并重算时长</Button>
    <small>突发插播不参与压缩；若会挤掉广告窗或下一档硬时间，本次插播不生效。</small>
  </Card>;
}

function QueuePage() {
  const dispatch = useAppDispatch();
  const { pending, processed, online, syncing, base } = useAppSelector((s) => s.rundown);

  const doSync = async () => {
    const r = await dispatch(syncQueue()).unwrap();
    if (r.rejected > 0) message.warning(`同步完成：${r.committed} 条生效，${r.rejected} 条冲突退回，${r.duplicate} 条重复忽略`);
    else message.success(`同步完成：${r.committed} 条生效，${r.duplicate} 条重复忽略`);
  };

  return <div className="side-stack">
    <Card
      title={<span>本地应急队列 <Badge count={pending.length} showZero color={pending.length ? "red" : "#999"} /></span>}
      extra={<small>本地基线版本 v{base.version}</small>}
    >
      {!online && <Alert type="warning" showIcon className="reject-alert" message="当前处于本地应急模式" description="编排先入本地队列；主链路恢复后按操作先后逐条提交，重复提交只算一次。" />}
      <div className="queue-list">
        {pending.length ? pending.map((item, idx) => <article key={item.id}>
          <Tag color="red">#{idx + 1} {item.action}</Tag>
          <b>{item.detail}</b>
          <span className="queue-meta"><small>{item.role} · {format(new Date(item.createdAt), "HH:mm:ss")}</small><br /><small className="muted">{item.reason}</small></span>
          <Button size="small" onClick={() => {
            let reason = "";
            Modal.confirm({
              title: "撤回该本地操作", content: <Input.TextArea placeholder="撤回原因（将记录岗位与原因）" onChange={(e) => { reason = e.target.value; }} />,
              okText: "确认撤回", onOk: () => {
                if (reason.trim().length < 2) { message.error("请填写撤回原因"); throw new Error("missing"); }
                dispatch(withdrawPending({ intentId: item.id, reason: reason.trim() }));
              },
            });
          }}>撤回</Button>
        </article>) : <p>当前没有待同步操作。</p>}
      </div>
      <div className="queue-actions">
        <Tooltip title={online ? "" : "请先恢复在线模式"}>
          <Button type="primary" loading={syncing} disabled={!online || pending.length === 0} onClick={doSync}>主链路恢复后逐条提交</Button>
        </Tooltip>
        {!online && pending.length > 0 && <Tooltip title="演示：模拟离线期间主控侧被其他岗位改动"><Button onClick={() => { void dispatch(simulateRemoteChange()).then((r) => message.info(`主控已推进到 v${r.payload}，提交时将按最新顺序重算，仅退回真正冲突的条目`)); }}>模拟主控版本变化</Button></Tooltip>}
      </div>
    </Card>
    <Card title="提交结论（含冲突退回 / 压缩 / 撤回）">
      <div className="queue-list">
        {processed.length ? processed.map((item) => <article key={item.id} className="processed-row">
          <Tag color={intentStatusColor[item.status]}>{item.status}</Tag>
          <div><b>{item.action} · {item.detail}</b><br /><small>{item.role} · {format(new Date(item.resolvedAt ?? item.createdAt), "HH:mm:ss")} · {item.result ?? item.reason}</small>
            {item.conflicts && <ul className="conflict-list compact">{item.conflicts.map((c, i) => <li key={i}><Tag color={c.kind === "广告窗" ? "gold" : "red"}>{c.kind}</Tag>{c.title}：{c.detail}</li>)}</ul>}
          </div>
          {item.status === "已拒绝" && online && <Button size="small" onClick={() => { void dispatch(retryIntent(item.id)); }}>按最新版重提</Button>}
        </article>) : <p>尚无已处理操作。</p>}
      </div>
    </Card>
  </div>;
}

function ChangesPage() {
  const { changes } = useAppSelector((s) => s.rundown);
  return <Card title="突发变更记录">
    <Timeline items={changes.map((item) => ({ color: item.outcome === "已生效" ? "red" : "gray", children: <div>
      <b>{item.headline}</b> <Tag color={item.outcome === "已生效" ? "green" : "default"}>{item.outcome}</Tag>
      <p>{item.reason} · {item.duration} 分钟 · 插在「{item.anchorTitle}」{item.where === "before" ? "前" : "后"}</p>
      {item.conflicts && <ul className="conflict-list compact">{item.conflicts.map((c, i) => <li key={i}><Tag color={c.kind === "广告窗" ? "gold" : "red"}>{c.kind}</Tag>{c.title}：{c.detail}</li>)}</ul>}
      <small>{format(new Date(item.createdAt), "HH:mm:ss")}</small>
    </div> }))} />
  </Card>;
}

function AuditPage() {
  const { audit, compressionLog } = useAppSelector((s) => s.rundown);
  const color: Record<string, string> = { 已生效: "green", 已拒绝: "red", 被压缩: "orange", 已撤回: "default", 重复忽略: "default" };
  return <div className="side-stack">
    <Card title="操作审计（拒绝 / 压缩 / 撤回均留岗位与原因）">
      <div className="queue-list">
        {audit.length ? audit.map((entry) => <article key={entry.id} className="processed-row">
          <Tag color={color[entry.outcome]}>{entry.outcome}</Tag>
          <div><b>{entry.action} · {entry.detail}</b><br /><small>{entry.role} 岗 · {format(new Date(entry.at), "HH:mm:ss")}</small><p className="reason-line">原因：{entry.reason}</p>
            {entry.conflicts && <ul className="conflict-list compact">{entry.conflicts.map((c, i) => <li key={i}><Tag color={c.kind === "广告窗" ? "gold" : "red"}>{c.kind}</Tag>{c.title}：{c.detail}</li>)}</ul>}
          </div>
        </article>) : <p>暂无审计记录。</p>}
      </div>
    </Card>
    <Card title="压缩台账">
      <div className="queue-list">
        {compressionLog.length ? compressionLog.map((c) => <article key={`${c.intentId}-${c.itemId}`}>
          <Tag color="orange">压缩</Tag>
          <div><b>{c.title}</b> {c.from} → {c.to} 分钟<br /><small>{c.role} 岗 · {format(new Date(c.at), "HH:mm:ss")} · {c.reason}</small></div>
        </article>) : <p>尚无压缩记录。</p>}
      </div>
    </Card>
  </div>;
}

function HistoryPage() {
  const { history } = useAppSelector((s) => s.rundown);
  return <Card title="版本历史（撤回快照）">
    <Timeline items={history.map((entry) => ({ color: "blue", children: <div>
      <b>{entry.label} · {entry.detail}</b> <Tag>v{entry.version}</Tag>
      <p>{entry.snapshot.length} 条 · {format(new Date(entry.time), "HH:mm:ss")}</p>
    </div> }))} />
  </Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { t, i18n } = useTranslation();

  useEffect(() => { void dispatch(bootstrap()); }, [dispatch]);

  const toggleOnline = (value: boolean) => {
    dispatch(setOnlineFlag(value));
    if (value && state.pending.length > 0) {
      Modal.confirm({
        title: "主链路已恢复",
        content: `本地队列有 ${state.pending.length} 条操作，是否按先后顺序逐条提交？`,
        okText: "立即逐条提交", cancelText: "暂不提交",
        onOk: async () => {
          const r = await dispatch(syncQueue()).unwrap();
          if (r.rejected > 0) message.warning(`提交完成：${r.committed} 生效 / ${r.rejected} 冲突退回 / ${r.duplicate} 重复忽略`);
          else message.success(`提交完成：${r.committed} 生效 / ${r.duplicate} 重复忽略`);
        },
      });
    }
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div>
      <nav>
        <NavLink to="/">{t("rundown")}</NavLink>
        <NavLink to="/changes">{t("changes")}</NavLink>
        <NavLink to="/queue">{t("queue")} {state.pending.length ? <em>{state.pending.length}</em> : null}</NavLink>
        <NavLink to="/audit">{t("audit")}</NavLink>
        <NavLink to="/history">{t("history")}</NavLink>
      </nav>
      <Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button>
    </aside>
    <main>
      <header className="topbar">
        <div><small>直播运行中 · 拒绝、压缩、撤回均保留岗位与原因</small><h1>{t("title")}</h1></div>
        <div className="top-actions">
          <label>在线模式 <Switch checked={state.online} onChange={toggleOnline} /></label>
          <label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{ value: "导播" }, { value: "主编" }, { value: "字幕" }, { value: "演播室" }]} /></label>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<RundownPage />} />
        <Route path="/changes" element={<ChangesPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
  </div>;
}
