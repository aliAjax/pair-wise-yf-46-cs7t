import { useEffect, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { useGetRundownQuery } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { clearConflicts, initialize, setOnline, setRole } from "./store/rundownSlice";
import { performOp, simulateMasterChange, submitQueue, undoLast } from "./store/thunks";
import { computeStarts, formatClock, parseClock } from "./store/recalc";
import type { HistoryKind, QueueStatus, Role } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

const KIND_COLOR: Record<HistoryKind, string> = { 应用: "blue", 被压缩: "orange", 被拒绝: "red", 撤回: "purple", 同步: "green" };
const QUEUE_COLOR: Record<QueueStatus, string> = { 待提交: "gold", 已提交: "green", 被拒绝: "red", 重复忽略: "default" };

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online, lastConflicts } = useAppSelector((state) => state.rundown);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const starts = computeStarts(items);
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const overrun = items.filter((item, index) => item.hardStart && starts[index] > parseClock(item.hardStart));
  const last = items.at(-1);
  const endAt = last ? formatClock(starts[starts.length - 1] + last.duration) : "--:--";
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || role !== "导播") return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    const order = arrayMove(items.map((item) => item.id), oldIndex, newIndex);
    dispatch(performOp({ kind: "reorder", order }, "调整顺序", `「${items[oldIndex].title}」移动到第 ${newIndex + 1} 位`));
  };

  const submit = (values: FormValues) => {
    dispatch(performOp({ kind: "addItem", item: { ...values, id: crypto.randomUUID(), status: "草稿" } }, "新增条目", values.title));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undoLast())} disabled={role === "字幕"}>撤回上一步</Button></div></div>
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={overrun.length ? "danger-text" : ""}><b>{overrun.length}</b> 个硬时间风险</span><span><b>{endAt}</b> 预计收播</span></div>
      {lastConflicts.length > 0 && (
        <Alert className="conflict-alert" type="error" closable onClose={() => dispatch(clearConflicts())}
          message="本次调整未生效，存在冲突条目"
          description={<ul>{lastConflicts.map((c) => <li key={c.itemId}>「{c.title}」{c.reason}</li>)}</ul>} />
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{items.map((item, index) => (
            <SortableItem key={item.id} item={item} cumulative={formatClock(starts[index])}
              onDuration={(delta) => dispatch(performOp({ kind: "adjustDuration", id: item.id, delta }, "调整时长", `「${item.title}」${delta > 0 ? "增加" : "减少"} ${Math.abs(delta)} 分钟`))}
              onStatus={() => dispatch(performOp({ kind: "updateStatus", id: item.id, status: "已播出" }, "播出状态", `「${item.title}」→ 已播出`))}
              onSkip={() => dispatch(performOp({ kind: "skipItem", id: item.id }, "取消条目", item.title))} />
          ))}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={role === "字幕"}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, online } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, targetId: "", position: "after" as "before" | "after", reason: "突发新闻" });
  const target = items.find((item) => item.id === values.targetId) ?? items[0];
  const insert = () => {
    if (!target) return;
    const positionText = values.position === "before" ? "前" : "后";
    dispatch(performOp(
      { kind: "insertBreaking", newId: crypto.randomUUID(), headline: values.headline, duration: values.duration, targetId: target.id, position: values.position, reason: values.reason },
      "突发插播",
      `「${values.headline}」插在「${target.title}」${positionText}`,
      { headline: values.headline, duration: values.duration, targetId: target.id, targetTitle: target.title, position: values.position, reason: values.reason }
    ));
    setValues({ ...values, headline: "" });
  };
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.position} onChange={(value) => setValues({ ...values, position: value })} options={[{ value: "before", label: "插在条目前" }, { value: "after", label: "插在条目后" }]} /></div>
    <Select value={target?.id} onChange={(value) => setValues({ ...values, targetId: value })} options={items.map((item) => ({ value: item.id, label: item.title }))} placeholder="选择目标条目" />
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2 || !target} onClick={insert}>立即插入并重算时长</Button>
    {!online && <small>离线操作将进入本地应急队列，主链路恢复后按操作先后逐条提交。</small>}
  </Card>;
}

function QueuePage() {
  const dispatch = useAppDispatch();
  const { queue, online, baseVersion, masterVersion } = useAppSelector((state) => state.rundown);
  const pending = queue.filter((q) => q.status === "待提交").length;
  const sorted = [...queue].sort((a, b) => a.seq - b.seq);
  return <Card title="本地应急队列">
    <div className="version-line">
      <span>主控版本 <b>v{masterVersion}</b></span>
      <span>本地基线 <b className={baseVersion !== masterVersion ? "danger-text" : ""}>v{baseVersion}</b></span>
      {baseVersion !== masterVersion && <Tag color="orange">主控已变更，提交时按最新顺序重算</Tag>}
    </div>
    <div className="queue-list">
      {sorted.length ? sorted.map((q) => (
        <article key={q.id}>
          <Tag color={QUEUE_COLOR[q.status]}>{q.status}</Tag>
          <div><b>#{q.seq} {q.label}</b><small>{q.detail} · {q.role} · {format(new Date(q.queuedAt), "HH:mm:ss")}</small>{q.note && <small className="op-note">{q.note}</small>}</div>
        </article>
      )) : <p>当前没有待同步操作。</p>}
    </div>
    <div className="head-actions">
      <Button type="primary" disabled={!online || !pending} onClick={() => dispatch(submitQueue())}>按操作先后逐条提交（{pending}）</Button>
      <Button onClick={() => dispatch(simulateMasterChange())}>模拟主控变更</Button>
    </div>
    {!online && <small>离线中：编排先进入本地队列；恢复后逐条提交，重复提交只算一次，主控版本变化时只退回有冲突的操作。</small>}
  </Card>;
}

function ChangesPage() {
  const changes = useAppSelector((state) => state.rundown.changes);
  return <Card title="突发变更记录"><Timeline items={changes.map((item) => ({ color: "red", children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟 · 插在「{item.targetTitle}」{item.position === "before" ? "前" : "后"}</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} />{!changes.length && <p>暂无突发插播。</p>}</Card>;
}

function HistoryPage() {
  const history = useAppSelector((state) => state.rundown.history);
  return <Card title="操作历史（岗位与原因留痕）">
    <Timeline items={history.map((entry) => ({ color: KIND_COLOR[entry.kind], children: <div><b><Tag color={KIND_COLOR[entry.kind]}>{entry.kind}</Tag>{entry.label}</b><p>{entry.detail}</p><p><Tag>{entry.role}</Tag>{entry.reason ?? "—"}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} />
    {!history.length && <p>暂无操作记录。</p>}
  </Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data) dispatch(initialize({ items: data.items, version: data.version })); }, [data, dispatch]);
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {state.queue.filter((q) => q.status === "待提交").length ? <em>{state.queue.filter((q) => q.status === "待提交").length}</em> : null}</NavLink><NavLink to="/history">{t("history")}</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label></div></header><Routes><Route path="/" element={<RundownPage />} /><Route path="/changes" element={<ChangesPage />} /><Route path="/queue" element={<QueuePage />} /><Route path="/history" element={<HistoryPage />} /></Routes></main>
  </div>;
}
