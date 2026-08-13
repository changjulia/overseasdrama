"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEpisodePlaybackUrls,
  listEpisodeMedia,
  revokeEpisodePlaybackUrls,
  storeEpisodeMedia,
} from "../lib/episode-media-store";
import type { FactoryEpisodeMedia } from "../features/factory/types";

export function useEpisodeMedia(dramaId: string | number | null) {
  const [episodeMedia, setEpisodeMedia] = useState<Record<number, FactoryEpisodeMedia>>({});
  const [loading, setLoading] = useState(false);
  const urlsRef = useRef<Record<number, FactoryEpisodeMedia>>({});

  const refresh = useCallback(async () => {
    revokeEpisodePlaybackUrls(urlsRef.current);
    urlsRef.current = {};
    if (dramaId == null) {
      setEpisodeMedia({});
      return {};
    }
    setLoading(true);
    try {
      const records = await listEpisodeMedia(dramaId);
      const next = createEpisodePlaybackUrls(records);
      urlsRef.current = next;
      setEpisodeMedia(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, [dramaId]);

  useEffect(() => {
    void refresh();
    return () => {
      revokeEpisodePlaybackUrls(urlsRef.current);
      urlsRef.current = {};
    };
  }, [refresh]);

  const save = useCallback(async (episode: number, file: File) => {
    if (dramaId == null) throw new Error("请先创建短剧记录再保存片源");
    await storeEpisodeMedia(dramaId, episode, file);
    return refresh();
  }, [dramaId, refresh]);

  return { episodeMedia, loading, refresh, save };
}
