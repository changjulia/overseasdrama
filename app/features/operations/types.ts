export type OperationsSection = "sources" | "tasks" | "team";

export type SourceRecord = {
  id: string;
  name: string;
  kind: "广告情报" | "内部投放" | "正片资产";
  platform: string;
  markets: string;
  frequency: string;
  status: "运行中" | "已暂停" | "待配置";
  lastSync: string;
  volume: number;
};

export type PipelineTask = {
  id: string;
  title: string;
  category: "素材抓取" | "基础分析" | "深度分析" | "剧集解析" | "故事线匹配" | "补充高光" | "接点精分析" | "视频生成";
  status: "处理中" | "排队中" | "已暂停" | "已完成" | "需处理" | "失败";
  progress: number;
  owner: string;
  createdAt: string;
  cost: string;
  backendId?: string;
  stage?: "coarse" | "detail" | "precision" | "hook_match" | "supplemental_highlight" | "entry_precision";
  episodeNumber?: number;
  currentStage?: string;
  attempt?: number;
  maxAttempts?: number;
  errorKind?: string;
  nextAttemptAt?: string;
  error?: string;
  logs?: unknown;
  backendStatus?: "queued" | "running" | "paused" | "succeeded" | "failed";
  updatedAt?: string;
};
