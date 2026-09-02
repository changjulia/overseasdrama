"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./ExternalHookDelivery.module.css";

export type DeliveryReviewStatus = "pending" | "approved" | "rejected";
export type DeliveryRenderStatus = "idle" | "queued" | "rendering" | "ready" | "failed";

export type DeliveryVersion = {
  id: string;
  label: string;
  createdAt: string;
  status: "draft" | "reviewing" | "approved" | "rejected" | "failed" | "exported";
  note?: string;
  previewUrl?: string;
  outputUrl?: string;
};

export type DeliveryExportConfig = {
  format: "MP4" | "MOV";
  resolution: "1080 × 1920" | "720 × 1280";
  quality: "标准" | "高质量";
  fileName: string;
  selectedVersionIds?: string[];
  versionFileNames?: Record<string, string>;
};

export type ExternalHookDeliveryProps = {
  view?: "preview" | "export";
  projectName: string;
  hookName?: string;
  hookLabel?: string;
  bodyLabel?: string;
  episodeReference?: string;
  duration?: string;
  previewUrl?: string;
  posterUrl?: string;
  renderConnected?: boolean;
  initialRenderStatus?: DeliveryRenderStatus;
  initialProgress?: number;
  initialRenderError?: string;
  initialReviewStatus?: DeliveryReviewStatus;
  initialReviewComment?: string;
  versions?: DeliveryVersion[];
  renderCount?: number;
  exportableVersionCount?: number;
  disabled?: boolean;
  onRequestRender?: () => void | Promise<void>;
  onReview?: (decision: Exclude<DeliveryReviewStatus, "pending">, comment: string) => void | Promise<void>;
  onSaveDraft?: () => void;
  onExport?: (config: DeliveryExportConfig) => void | Promise<void>;
  onSelectVersion?: (version: DeliveryVersion) => void;
  onNotify?: (message: string) => void;
};

const DEFAULT_VERSIONS: DeliveryVersion[] = [
  { id: "current", label: "当前编辑版", createdAt: "尚未保存版本", status: "draft" },
];

const renderLabels: Record<DeliveryRenderStatus, string> = {
  idle: "等待生成",
  queued: "任务排队中",
  rendering: "正在合成预览",
  ready: "预览已就绪",
  failed: "生成失败",
};

const versionStatusLabels: Record<DeliveryVersion["status"], string> = {
  draft: "草稿",
  reviewing: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  failed: "生成失败",
  exported: "已导出",
};

export function ExternalHookDelivery({
  view = "preview",
  projectName,
  hookName = "尚未命名钩子",
  hookLabel = "外搭钩子",
  bodyLabel = "正片承接",
  episodeReference = "尚未选择正片承接帧",
  duration = "--:--",
  previewUrl,
  posterUrl,
  renderConnected = false,
  initialRenderStatus = "idle",
  initialProgress = 0,
  initialRenderError = "",
  initialReviewStatus = "pending",
  initialReviewComment = "",
  versions = DEFAULT_VERSIONS,
  renderCount = 1,
  exportableVersionCount = 0,
  disabled = false,
  onRequestRender,
  onReview,
  onSaveDraft,
  onExport,
  onSelectVersion,
  onNotify,
}: ExternalHookDeliveryProps) {
  const [renderStatus, setRenderStatus] = useState<DeliveryRenderStatus>(previewUrl ? "ready" : initialRenderStatus);
  const [progress, setProgress] = useState(Math.min(100, Math.max(0, initialProgress)));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [renderError, setRenderError] = useState(initialRenderError);
  const [isDemoRun, setIsDemoRun] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<DeliveryReviewStatus>(initialReviewStatus);
  const [comment, setComment] = useState(initialReviewComment);
  const [format, setFormat] = useState<DeliveryExportConfig["format"]>("MP4");
  const [resolution, setResolution] = useState<DeliveryExportConfig["resolution"]>("1080 × 1920");
  const [quality, setQuality] = useState<DeliveryExportConfig["quality"]>("高质量");
  const safeProjectName = useMemo(() => projectName.trim().replace(/[\\/:*?"<>|]/g, "-") || "未命名项目", [projectName]);
  const [fileName, setFileName] = useState(`${safeProjectName}_外搭钩子_v01`);
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const [versionFileNames, setVersionFileNames] = useState<Record<string, string>>({});
  const hasPlayablePreview = Boolean(previewUrl);
  const visibleRenderStatus: DeliveryRenderStatus = hasPlayablePreview ? "ready" : renderStatus;
  const visibleProgress = hasPlayablePreview ? 100 : progress;
  const canExport = (exportableVersionCount > 0 || hasPlayablePreview) && !disabled;

  useEffect(() => {
    const exportable = versions.filter((version) => Boolean(version.outputUrl));
    setSelectedVersionIds((current) => {
      const retained = current.filter((id) => exportable.some((version) => version.id === id));
      return retained.length ? retained : exportable.map((version) => version.id);
    });
    setVersionFileNames((current) => {
      const next = { ...current };
      exportable.forEach((version, index) => {
        if (!next[version.id]) next[version.id] = `${safeProjectName}_外搭钩子_v${String(index + 1).padStart(2, "0")}`;
      });
      return next;
    });
  }, [safeProjectName, versions]);

  useEffect(() => {
    setReviewStatus(initialReviewStatus);
    setComment(initialReviewComment);
  }, [initialReviewComment, initialReviewStatus]);

  useEffect(() => {
    setRenderStatus(previewUrl ? "ready" : initialRenderStatus);
    setProgress(previewUrl ? 100 : Math.min(100, Math.max(0, initialProgress)));
    setRenderError(initialRenderError);
    if (initialRenderStatus !== "idle") setIsSubmitting(false);
  }, [initialProgress, initialRenderError, initialRenderStatus, previewUrl]);

  useEffect(() => {
    if (!isDemoRun || renderStatus !== "rendering") return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(100, current + 8);
        if (next === 100) {
          window.clearInterval(timer);
          setRenderStatus("ready");
          setIsDemoRun(false);
          onNotify?.("演示任务已完成；未生成真实视频文件");
        }
        return next;
      });
    }, 260);
    return () => window.clearInterval(timer);
  }, [isDemoRun, onNotify, renderStatus]);

  const startRender = async () => {
    if (disabled || isSubmitting || renderStatus === "rendering" || renderStatus === "queued") return;
    setIsSubmitting(true);
    setRenderError("");
    setProgress(4);
    setRenderStatus(renderConnected ? "queued" : "rendering");
    if (!renderConnected) {
      setIsDemoRun(true);
      setIsSubmitting(false);
      onNotify?.("正在演示生成任务流程；不会产生真实视频文件");
      return;
    }
    try {
      await onRequestRender?.();
      setIsSubmitting(false);
      onNotify?.("预览任务已创建，正在等待渲染服务处理");
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成任务提交失败，请稍后重试";
      setIsSubmitting(false);
      setRenderStatus("failed");
      setRenderError(message);
      onNotify?.(message);
    }
  };

  const submitReview = async (decision: Exclude<DeliveryReviewStatus, "pending">) => {
    if (!comment.trim()) { onNotify?.("请填写审核意见后再提交"); return; }
    try {
      await onReview?.(decision, comment.trim());
      setReviewStatus(decision);
      onNotify?.(decision === "approved" ? "审核已通过，可以进入导出" : "已驳回并记录修改意见");
    } catch (error) { onNotify?.(error instanceof Error ? error.message : "审核提交失败"); }
  };

  const exportConfig: DeliveryExportConfig = {
    format,
    resolution,
    quality,
    fileName: `${fileName.trim() || safeProjectName}.${format.toLowerCase()}`,
    selectedVersionIds,
    versionFileNames,
  };
  const submitExport = async () => {
    try {
      await onExport?.(exportConfig);
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : "成片导出失败");
    }
  };

  return (
    <section className={styles.delivery} aria-label="生成预览与导出">
      {view === "preview" && !renderConnected && (
        <div className={styles.boundaryNotice} role="status">
          <strong>当前仅演示交付流程</strong>
          <span>任务进度、审核与导出配置可以操作；系统不会生成、播放或导出虚构成片。</span>
        </div>
      )}

      {view === "preview" && <div className={styles.deliveryGrid}>
        <div className={styles.previewColumn}>
          <div className={styles.previewHeading}>
            <div><span>9:16 PREVIEW</span><h3>{projectName || "未命名项目"}</h3></div>
            <strong>{duration}</strong>
          </div>
          <div className={styles.phoneStage}>
            {hasPlayablePreview ? (
              <video src={previewUrl} poster={posterUrl} controls preload="metadata" aria-label={`${projectName} 成片预览`} />
            ) : (
              <div className={styles.previewEmpty} style={posterUrl ? { backgroundImage: `linear-gradient(#15233a99, #15233acc), url(${posterUrl})` } : undefined}>
                <div className={styles.playMark} aria-hidden="true">▶</div>
                <b>{isDemoRun ? "正在演示生成进度" : visibleRenderStatus === "ready" ? "演示流程已完成" : "等待真实预览文件"}</b>
                <span>{renderConnected ? "生成成功后将在此播放" : "演示状态不代表已有成片"}</span>
              </div>
            )}
            <div className={styles.safeArea} aria-hidden="true"><span>字幕安全区</span></div>
          </div>
          <dl className={styles.sourceSummary}>
            <div><dt>{hookLabel}</dt><dd>{hookName}</dd></div>
            <div><dt>{bodyLabel}</dt><dd>{episodeReference}</dd></div>
          </dl>
        </div>

        <div className={styles.controlColumn}>
          <section className={styles.card}>
            <div className={styles.cardTitle}><div><span>生成任务</span><h3>{renderLabels[visibleRenderStatus]}</h3></div><b>{Math.round(visibleProgress)}%</b></div>
            <div className={styles.progressTrack} aria-label={`生成进度 ${Math.round(visibleProgress)}%`}><i style={{ width: `${visibleProgress}%` }} /></div>
            <div className={styles.taskStages}>
              {["素材校验", "镜头合成", "字幕混音", "渲染封装"].map((stage, index) => (
                <span key={stage} className={visibleProgress >= (index + 1) * 25 ? styles.stageDone : ""}><i>{visibleProgress >= (index + 1) * 25 ? "✓" : index + 1}</i>{stage}</span>
              ))}
            </div>
            {(isSubmitting || visibleRenderStatus === "queued" || visibleRenderStatus === "rendering" || renderError) && (
              <p className={renderError ? styles.taskError : styles.taskFeedback} role={renderError ? "alert" : "status"}>
                {renderError || (isSubmitting ? "正在保存项目并创建预览任务，请稍候…" : visibleRenderStatus === "queued" ? "任务已进入队列，正在等待渲染服务领取。" : "渲染服务正在合成视频，进度会自动更新。")}
              </p>
            )}
            <button className={styles.primaryButton} type="button" onClick={startRender} disabled={disabled || isSubmitting || renderStatus === "rendering" || renderStatus === "queued"}>
              {isSubmitting ? "正在创建任务…" : renderStatus === "rendering" || renderStatus === "queued" ? "生成流程进行中…" : renderStatus === "failed" ? "重新生成预览" : renderConnected ? `批量生成 ${renderCount} 个预览` : "演示生成流程"}
            </button>
          </section>

          <section className={styles.card}><div className={styles.cardTitle}><div><span>输出状态</span><h3>{hasPlayablePreview ? "成片可播放" : "等待生成真实成片"}</h3></div></div><p className={styles.inlineHint}>{hasPlayablePreview ? "请在左侧播放检查首帧、转场、字幕与结尾，审核通过后开放导出。" : "生成任务完成后，真实视频会自动出现在左侧预览框。"}</p></section>
          <section className={styles.card}><div className={styles.cardTitle}><div><span>成片版本</span><h3>{versions.length} 个版本</h3></div></div><div className={styles.versionList}>{versions.map(version=><button type="button" key={version.id} onClick={()=>onSelectVersion?.(version)}><b>{version.label}</b><span>{version.createdAt} · {versionStatusLabels[version.status]}</span></button>)}</div></section>
        </div>
      </div>}

      {view === "export" && <div className={styles.bottomGrid}>
        <section className={styles.card}>
          <div className={styles.cardTitle}><div><span>导出规格</span><h3>命名与交付设置</h3></div><b>9:16</b></div>
          <div className={styles.exportFields}>
            <label><span>格式</span><select value={format} disabled aria-label="格式（当前渲染规格）"><option>MP4</option></select></label>
            <label><span>分辨率</span><select value={resolution} disabled aria-label="分辨率（当前渲染规格）"><option>1080 × 1920</option></select></label>
            <label><span>质量</span><select value={quality} disabled aria-label="质量（当前渲染规格）"><option>高质量</option></select></label>
            <label className={styles.nameField}><span>文件名</span><div><input value={fileName} onChange={(event) => setFileName(event.target.value)} /><i>.{format.toLowerCase()}</i></div></label>
          </div>
          {versions.some((version) => version.outputUrl) && <div className={styles.batchVersionNames}>
            <header><div><b>批量导出版本</b><span>勾选版本并在前端分别命名</span></div><button type="button" onClick={()=>setSelectedVersionIds(selectedVersionIds.length===versions.filter(version=>version.outputUrl).length?[]:versions.filter(version=>version.outputUrl).map(version=>version.id))}>{selectedVersionIds.length===versions.filter(version=>version.outputUrl).length?"取消全选":"全选可导出版本"}</button></header>
            {versions.filter(version=>version.outputUrl).map((version)=><label key={version.id}><input type="checkbox" checked={selectedVersionIds.includes(version.id)} onChange={()=>setSelectedVersionIds(current=>current.includes(version.id)?current.filter(id=>id!==version.id):[...current,version.id])}/><span>{version.label}</span><div><input value={versionFileNames[version.id]||""} onChange={(event)=>setVersionFileNames(current=>({...current,[version.id]:event.target.value}))}/><i>.{format.toLowerCase()}</i></div></label>)}
          </div>}
          <div className={styles.exportActions}>
            <button type="button" onClick={() => { onSaveDraft?.(); onNotify?.("草稿与交付配置已保存"); }} disabled={disabled}>保存草稿</button>
            <button className={styles.exportButton} type="button" onClick={() => void submitExport()} disabled={!canExport || (versions.some(version=>version.outputUrl) && !selectedVersionIds.length)} title={!canExport ? "渲染服务尚未返回真实文件" : undefined}>批量导出 {versions.some(version=>version.outputUrl) ? selectedVersionIds.length : Math.max(exportableVersionCount, hasPlayablePreview ? 1 : 0)} 个版本</button>
          </div>
          {!canExport && <small className={styles.exportHint}>等待至少一个真实预览文件后开放批量导出</small>}
        </section>
      </div>}
    </section>
  );
}

export default ExternalHookDelivery;
