export type FactoryMode = "episode-splice" | "episode-narration" | "external-hook";

export type QualityStatus =
  | "可以直接生成"
  | "建议优化后生成"
  | "停滑能力弱"
  | "情绪强但信息不足"
  | "信息清楚但缺少刺激"
  | "音画不同步"
  | "悬念锚定缺失"
  | "过度剧透"
  | "高点击低转化风险"
  | "货不对板，禁止批量生成";

export type Draft = {
  id: string;
  title: string;
  mode: FactoryMode;
  drama: string;
  hook: string;
  episodeRange: string;
  transition: string;
  language: string;
  duration: string;
  ratio: "9:16" | "16:9" | "1:1";
  qualityStatus: QualityStatus;
  updatedAt: string;
  autoSaved: boolean;
  thumbnailTone: "rose" | "blue" | "violet" | "amber" | "mint";
  progress: number;
  productionStatus?: "自动保存" | "编辑中" | "生成中" | "待质检" | "建议优化" | "通过" | "禁止批量生成" | "待审核" | "已导出";
  version?: number;
};

export type FactorySourceContext = {
  kind: "inspiration" | "library" | "favorite";
  id: string;
  title: string;
  description?: string;
  language?: string;
};

export type FactoryWorkspaceProps = {
  initialMode?: FactoryMode;
  editingDraft?: Draft | null;
  sourceContext?: FactorySourceContext | null;
  onDraftAutoSave?: (draft: Draft) => void;
  onOpenDrafts?: () => void;
  onNotify?: (message: string) => void;
};

export type FactoryModeDefinition = {
  id: FactoryMode;
  name: string;
  description: string;
  icon: string;
  steps: string[];
};
