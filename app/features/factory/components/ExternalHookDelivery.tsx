"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./ExternalHookDelivery.module.css";

export type DeliveryReviewStatus = "pending" | "approved" | "rejected";
export type DeliveryRenderStatus = "idle" | "queued" | "rendering" | "ready" | "failed";

export type DeliveryVersion = {
  id: string;
  label: string;
  createdAt: string;
  status: "draft" | "reviewing" | "approved" | "rejected" | "exported";
  note?: string;
  previewUrl?: string;
};

export type DeliveryExportConfig = {
  format: "MP4" | "MOV";
  resolution: "1080 × 1920" | "720 × 1280";
  quality: "标准" | "高质量";
  fileName: string;
};

export type ExternalHookDeliveryProps = {
  view?: "preview" | "export";
  projectName: string;
  hookName?: string;
  episodeReference?: string;
  duration?: string;
  previewUrl?: string;
  posterUrl?: string;
  renderConnected?: boolean;
  initialRenderStatus?: DeliveryRenderStatus;
  initialProgress?: number;
  initialReviewStatus?: DeliveryReviewStatus;
  initialReviewComment?: string;
  versions?: DeliveryVersion[];
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
  exported: "已导出",
};

export function ExternalHookDelivery({
  view = "preview",
  projectName,
  hookName = "尚未命名钩子",
  episodeReference = "尚未选择正片承接帧",
  duration = "--:--",
  previewUrl,
  posterUrl,
  renderConnected = false,
  initialRenderStatus = "idle",
  initialProgress = 0,
  initialReviewStatus = "pending",
  initialReviewComment = "",
  versions = DEFAULT_VERSIONS,
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
  const [isDemoRun, setIsDemoRun] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<DeliveryReviewStatus>(initialReviewStatus);
  const [comment, setComment] = useState(initialReviewComment);
  const [format, setFormat] = useState<DeliveryExportConfig["format"]>("MP4");
  const [resolution, setResolution] = useState<DeliveryExportConfig["resolution"]>("1080 × 1920");
  const [quality, setQuality] = useState<DeliveryExportConfig["quality"]>("高质量");
  const safeProjectName = useMemo(() => projectName.trim().replace(/[\\/:*?"<>|]/g, "-") || "未命名项目", [projectName]);
  const [fileName, setFileName] = useState(`${safeProjectName}_外搭钩子_v01`);
  const hasPlayablePreview = Boolean(previewUrl);
  const visibleRenderStatus: DeliveryRenderStatus = hasPlayablePreview ? "ready" : renderStatus;
  const visibleProgress = hasPlayablePreview ? 100 : progress;
  const canExport = hasPlayablePreview && !disabled;

  useEffect(() => {
    setReviewStatus(initialReviewStatus);
    setComment(initialReviewComment);
  }, [initialReviewComment, initialReviewStatus]);

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
    if (disabled || renderStatus === "rendering") return;
    setProgress(4);
    setRenderStatus(renderConnected ? "queued" : "rendering");
    if (!renderConnected) {
      setIsDemoRun(true);
      onNotify?.("正在演示生成任务流程；不会产生真实视频文件");
      return;
    }
    try {
      await onRequestRender?.();
      onNotify?.("生成任务已提交，请通过外部任务状态更新组件数据");
    } catch {
      setRenderStatus("failed");
      onNotify?.("生成任务提交失败，请稍后重试");
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
            <div><dt>外搭钩子</dt><dd>{hookName}</dd></div>
            <div><dt>正片承接</dt><dd>{episodeReference}</dd></div>
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
            <button className={styles.primaryButton} type="button" onClick={startRender} disabled={disabled || renderStatus === "rendering"}>
              {renderStatus === "rendering" ? "生成流程进行中…" : renderConnected ? "生成预览" : "演示生成流程"}
            </button>
          </section>

          <section className={styles.card}><div className={styles.cardTitle}><div><span>输出状态</span><h3>{hasPlayablePreview ? "成片可播放" : "等待生成真实成片"}</h3></div></div><p className={styles.inlineHint}>{hasPlayablePreview ? "请在左侧播放检查首帧、转场、字幕与结尾，确认后可直接导出。" : "生成任务完成后，真实视频会自动出现在左侧预览框。"}</p></section>
        </div>
      </div>}

      {view === "export" && <div className={styles.bottomGrid}>
        <section className={styles.card}>
          <div className={styles.cardTitle}><div><span>导出规格</span><h3>命名与交付设置</h3></div><b>9:16</b></div>
          <div className={styles.exportFields}>
            <label><span>格式</span><select value={format} onChange={(event) => setFormat(event.target.value as DeliveryExportConfig["format"])}><option>MP4</option><option>MOV</option></select></label>
            <label><span>分辨率</span><select value={resolution} onChange={(event) => setResolution(event.target.value as DeliveryExportConfig["resolution"])}><option>1080 × 1920</option><option>720 × 1280</option></select></label>
            <label><span>质量</span><select value={quality} onChange={(event) => setQuality(event.target.value as DeliveryExportConfig["quality"])}><option>高质量</option><option>标准</option></select></label>
            <label className={styles.nameField}><span>文件名</span><div><input value={fileName} onChange={(event) => setFileName(event.target.value)} /><i>.{format.toLowerCase()}</i></div></label>
          </div>
          <div className={styles.exportActions}>
            <button type="button" onClick={() => { onSaveDraft?.(); onNotify?.("草稿与交付配置已保存"); }} disabled={disabled}>保存草稿</button>
            <button className={styles.exportButton} type="button" onClick={() => void onExport?.(exportConfig)} disabled={!canExport} title={!hasPlayablePreview ? "渲染服务尚未返回真实文件" : undefined}>导出成片</button>
          </div>
          {!canExport && <small className={styles.exportHint}>等待真实预览文件后开放导出</small>}
        </section>
      </div>}
    </section>
  );
}

export default ExternalHookDelivery;
