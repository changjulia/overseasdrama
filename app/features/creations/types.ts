import type { Draft, FactoryMode } from "../factory/types";

export type FavoriteKind = "广告实例" | "钩子原型" | "高光片段" | "解说结构" | "过渡方法";

export type Favorite = {
  id: string;
  title: string;
  kind: FavoriteKind;
  hook: string;
  language: string;
  theme: string;
  source: string;
  savedAt: string;
  tone: Draft["thumbnailTone"];
};

export type MyCreationsProps = {
  drafts: Draft[];
  favorites?: Favorite[];
  initialTab?: "favorites" | "drafts";
  onContinueEdit?: (draft: Draft) => void;
  onReuseDraft?: (draft: Draft) => void;
  onUseFavorite?: (favorite: Favorite, mode: FactoryMode) => void;
  onOpenInspiration?: () => void;
  onRemoveFavorite?: (favoriteId: string) => void;
  onNotify?: (message: string) => void;
};
