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

export type DeliveryRenderValidation = {
  passed?: boolean;
  failureCodes?: string[];
  technical?: Record<string, unknown>;
  [key: string]: unknown;
};

export type DeliveryRenderTelemetry = {
  queuedAt?: string;
  startedAt?: string;
  leaseUntil?: string;
  lastHeartbeatAt?: string;
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
  renderTaskId?: string;
  retryOfTaskId?: string;
  renderValidation?: DeliveryRenderValidation;
  renderTelemetry?: DeliveryRenderTelemetry;
  initialReviewStatus?: DeliveryReviewStatus;
  initialReviewComment?: string;
  versions?: DeliveryVersion[];
  renderCount?: number;
  exportableVersionCount?: number;
  disabled?: boolean;
  onRequestRender?: () => void | Promise<void>;
  onReview?: (decision: Exclude<DeliveryReviewStatus, "pending">, comment: string) => void | Promise<void>;
  onSaveDraft?: () => void | boolean | Promise<void | boolean>;
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
  renderTaskId,
  retryOfTaskId,
  renderValidation,
  renderTelemetry,
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
  const [isReviewSubmitting, setIsReviewSubmitting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [renderError, setRenderError] = useState(initialRenderError);
  const [clock, setClock] = useState(() => Date.now());
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
  const canExport =
    (exportableVersionCount > 0 || hasPlayablePreview) &&
    reviewStatus === "approved" &&
    !disabled &&
    !isExporting;

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
    if (visibleRenderStatus !== "queued" && visibleRenderStatus !== "rendering") return;
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [visibleRenderStatus]);

  const parseTime = (value?: string) => value ? Date.parse(value) : Number.NaN;
  const queuedAt = parseTime(renderTelemetry?.queuedAt);
  const startedAt = parseTime(renderTelemetry?.startedAt);
  const leaseUntil = parseTime(renderTelemetry?.leaseUntil);
  const lastHeartbeatAt = parseTime(renderTelemetry?.lastHeartbeatAt);
  const queueLooksStuck = visibleRenderStatus === "queued" && Number.isFinite(queuedAt) && !Number.isFinite(startedAt) && clock - queuedAt > 10 * 60_000;
  const heartbeatReference = Number.isFinite(lastHeartbeatAt) ? lastHeartbeatAt : startedAt;
  const renderLooksStuck = visibleRenderStatus === "rendering" && (
    (Number.isFinite(heartbeatReference) && clock - heartbeatReference > 5 * 60_000) ||
    (Number.isFinite(leaseUntil) && leaseUntil < clock)
  );
  const suspectedStall = queueLooksStuck || renderLooksStuck;
  const failureCodes = Array.isArray(renderValidation?.failureCodes) ? renderValidation.failureCodes.map(String) : [];
  const normalizedFailureEvidence = `${failureCodes.join(" ")} ${renderError}`.toUpperCase();
  const failureAdvice = /404|NOT_FOUND|EXPIRED|DOWNLOAD/.test(normalizedFailureEvidence)
    ? "检查源素材是否已过期或返回 404；重新落盘／入库并校验播放后再重试。"
    : /CORRUPT|DECODE|INVALID_MEDIA|DAMAGED/.test(normalizedFailureEvidence)
      ? "源文件可能损坏或无法解码；请重新下载并用 FFprobe 校验音视频流。"
      : /NO_AUDIO|AUDIO_SPEC|AUDIO_MISSING|AUDIO_VIDEO_SYNC/.test(normalizedFailureEvidence)
        ? "检查素材是否缺少音轨、旁白资产是否仍有效，以及混音后音视频时长是否一致。"
        : failureCodes.length || /QC|QUALITY|VALIDATION/.test(normalizedFailureEvidence)
          ? "媒体 QC 未通过；按失败码修复编码、时长、响度、画幅或边界后重新渲染。"
          : "保留任务 ID 和错误信息，检查 worker 日志与素材可用性后再重试。";
  const technical = renderValidation?.technical;
  const technicalSummary = technical ? JSON.stringify(technical, null, 2) : "";

  const startRender = async () => {
    if (disabled || isSubmitting || renderStatus === "rendering" || renderStatus === "queued") return;
    if (!renderConnected) {
      onNotify?.("渲染服务未连接，不能创建真实任务");
      return;
    }
    setIsSubmitting(true);
    setRenderError("");
    setProgress(4);
    setRenderStatus("queued");
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
    if (!hasPlayablePreview || isReviewSubmitting) {
      if (!hasPlayablePreview) onNotify?.("请先生成并播放检查真实预览");
      return;
    }
    setIsReviewSubmitting(true);
    try {
      await onReview?.(decision, comment.trim());
      setReviewStatus(decision);
      onNotify?.(decision === "approved" ? "审核已通过，可以进入导出" : "已驳回并记录修改意见");
    } catch (error) { onNotify?.(error instanceof Error ? error.message : "审核提交失败"); }
    finally { setIsReviewSubmitting(false); }
  };

  const exportConfig: DeliveryExportConfig = {
    format,
    resolution,
    quality,
    fileName: `${fileName.trim() || safeProjectName}.${format.toLowerCase()}`,
  };
  const submitExport = async () => {
    if (!canExport) {
      onNotify?.(reviewStatus !== "approved" ? "请先完成人工审核并通过后再导出" : "暂无可导出的真实成片");
      return;
    }
    setIsExporting(true);
    try {
      await onExport?.(exportConfig);
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : "成片导出失败");
    } finally { setIsExporting(false); }
  };
  const submitSaveDraft = async () => {
    if (disabled || isSavingDraft) return;
    setIsSavingDraft(true);
    try {
      const saved = await onSaveDraft?.();
      if (saved !== false) onNotify?.("草稿与交付配置已保存");
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : "草稿保存失败");
    } finally { setIsSavingDraft(false); }
  };

  return (
    <section className={styles.delivery} aria-label="生成预览与导出">
      {view === "preview" && !renderConnected && (
        <div className={styles.boundaryNotice} role="status">
          <strong>渲染服务未连接</strong>
          <span>当前不能创建真实任务；不会显示本地递增的演示进度或伪造完成状态。</span>
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
                <b>{visibleRenderStatus === "ready" ? "任务完成但媒体地址不可用" : "等待真实预览文件"}</b>
                <span>{renderConnected ? "生成并通过媒体 QC 后将在此播放" : "请先恢复渲染服务连接"}</span>
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
            {suspectedStall && <div className={styles.stallWarning} role="status"><b>任务疑似卡住，但尚未被服务端判定失败</b><span>{queueLooksStuck ? "排队超过 10 分钟且未见启动时间；请检查 worker 是否在线及队列领取日志。" : "最近心跳超过 5 分钟或租约已过期；请检查 worker 状态，等待服务端重试／失败结论，避免重复提交。"}</span>{renderTaskId && <code>任务 ID：{renderTaskId}</code>}</div>}
            {retryOfTaskId && <p className={styles.taskFeedback} role="status">新版本重试自失败任务 <code>{retryOfTaskId}</code>；旧版本审批不会复用。</p>}
            {visibleRenderStatus === "failed" && <div className={styles.failureEvidence} role="alert"><b>真实渲染／媒体 QC 失败</b>{renderTaskId && <code>任务 ID：{renderTaskId}</code>}{failureCodes.length ? <div><span>失败码</span><ul>{failureCodes.map(code=><li key={code}>{code}</li>)}</ul></div> : <p>服务端未返回结构化失败码。</p>}<p>{failureAdvice}</p>{technicalSummary && <details><summary>技术探测证据</summary><pre>{technicalSummary}</pre></details>}</div>}
            <button className={styles.primaryButton} type="button" onClick={startRender} disabled={disabled || !renderConnected || isSubmitting || renderStatus === "rendering" || renderStatus === "queued"}>
              {isSubmitting ? "正在创建任务…" : renderStatus === "rendering" || renderStatus === "queued" ? "生成流程进行中…" : renderStatus === "failed" ? "重新生成预览" : renderConnected ? `批量生成 ${renderCount} 个预览` : "渲染服务未连接"}
            </button>
          </section>

          <section className={styles.card}><div className={styles.cardTitle}><div><span>输出状态</span><h3>{hasPlayablePreview ? "真实成片可播放" : "等待真实成片与媒体 QC"}</h3></div></div><p className={styles.inlineHint}>{hasPlayablePreview ? "服务端已返回可播放媒体；仍需人工检查首帧、转场、字幕、音轨与结尾后才能导出。" : "只有真实渲染成功、媒体 QC 通过并返回播放地址后，视频才会出现在左侧。"}</p></section>
          <section className={styles.card}>
            <div className={styles.cardTitle}>
              <div><span>人工审核</span><h3>成片交付门禁</h3></div>
              <em className={styles[reviewStatus]}>{reviewStatus === "approved" ? "已通过" : reviewStatus === "rejected" ? "已驳回" : "待审核"}</em>
            </div>
            <label className={styles.commentField}>
              <span>审核意见（必填）</span>
              <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="记录首帧、转场、字幕、音轨与结尾检查结果" disabled={!hasPlayablePreview || isReviewSubmitting} />
            </label>
            <div className={styles.reviewActions}>
              <button type="button" onClick={() => void submitReview("rejected")} disabled={!hasPlayablePreview || isReviewSubmitting}>{isReviewSubmitting ? "提交中…" : "驳回修改"}</button>
              <button type="button" onClick={() => void submitReview("approved")} disabled={!hasPlayablePreview || isReviewSubmitting}>{isReviewSubmitting ? "提交中…" : "通过审核"}</button>
            </div>
          </section>
          <section className={styles.card}><div className={styles.cardTitle}><div><span>成片版本</span><h3>{versions.length} 个版本</h3></div></div><div className={styles.versionList}>{versions.map(version=><button type="button" key={version.id} onClick={()=>onSelectVersion?.(version)}><b>{version.label}</b><span>{version.createdAt} · {versionStatusLabels[version.status]}</span></button>)}</div></section>
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
            <button type="button" onClick={() => void submitSaveDraft()} disabled={disabled || isSavingDraft}>{isSavingDraft ? "保存中…" : "保存草稿"}</button>
            <button className={styles.exportButton} type="button" onClick={() => void submitExport()} disabled={!canExport} title={!canExport ? reviewStatus !== "approved" ? "人工审核通过后才能导出" : "渲染服务尚未返回真实文件" : undefined}>{isExporting ? "正在导出…" : `批量导出 ${Math.max(exportableVersionCount, hasPlayablePreview ? 1 : 0)} 个版本`}</button>
          </div>
          {!canExport && <small className={styles.exportHint}>{reviewStatus !== "approved" ? "人工审核通过后开放导出" : "等待至少一个真实预览文件后开放批量导出"}</small>}
        </section>
      </div>}
    </section>
  );
}

export default ExternalHookDelivery;
