import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag, Tooltip } from "antd";
import type { RundownItem } from "../types";
import { isCompressible, minDuration } from "../engine/schedule";

interface Props {
  item: RundownItem;
  cumulative: string;
  hardAt: string | null;
  late: boolean;
  early: boolean;
  canEdit: boolean;
  compressedFrom?: number;
  onDuration: (delta: number) => void;
  onStatus: () => void;
  onSkip: () => void;
}

export function SortableItem({ item, cumulative, hardAt, late, early, canEdit, compressedFrom, onDuration, onStatus, onSkip }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: !canEdit || item.status === "已播出" });
  const compressible = isCompressible(item);
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status} ${late ? "row-late" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" disabled={!canEdit || item.status === "已播出"} {...attributes} {...listeners}>⠿</button>
      <time className={late ? "danger-text" : ""}>
        {cumulative}
        {early && <small className="wait-mark">等{hardAt}</small>}
      </time>
      <div className="row-main">
        <b>{item.title}{item.breaking && <Tag color="volcano" className="inline-tag">突发</Tag>}{compressedFrom !== undefined && <Tag color="orange" className="inline-tag">压缩 {compressedFrom}→{item.duration}</Tag>}</b>
        <small>
          {item.source} · {item.presenter}
          {hardAt && <Tag color={item.type === "广告" ? "gold" : "purple"} className="inline-tag">{item.type === "广告" ? "广告窗" : "硬时间"} {hardAt}</Tag>}
          {compressible && <Tooltip title={`可压缩段，最短 ${minDuration(item)} 分钟`}><Tag color="cyan" className="inline-tag">可压至{minDuration(item)}′</Tag></Tooltip>}
        </small>
      </div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : item.type === "口播" ? "green" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : item.status === "草稿" ? "default" : "processing"}>{item.status}</Tag>
      <div className="row-actions">
        <Tooltip title={canEdit ? "" : "当前岗位无导播权限"}><span><Button size="small" disabled={!canEdit} onClick={() => onDuration(-1)}>-1</Button></span></Tooltip>
        <Button size="small" disabled={!canEdit} onClick={() => onDuration(1)}>+1</Button>
        <Button size="small" type="primary" disabled={!canEdit || item.status === "已播出" || item.status === "已跳过"} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={!canEdit || item.status === "已播出"} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}
