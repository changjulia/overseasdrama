"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createInitialFactoryWorkflow, factoryModes } from "./mock-data";
import type { Draft, FactoryMode, FactorySourceContext, FactoryWorkspaceProps } from "./types";
import baseStyles from "./factory.module.css";
import enhancementStyles from "./factory-enhancements.module.css";

const styles = { ...baseStyles, ...enhancementStyles };

const padEpisode = (episode: number) => `EP ${String(episode).padStart(2, "0")}`;

function selectedRange(episodes: number[]) {
  if (!episodes.length) return "未选择片源";
  return episodes.map(padEpisode).join("、");
}

export function FactoryWorkspace({ initialMode = "episode-splice", editingDraft, sourceContext, onDraftAutoSave, onOpenDrafts, onNotify }: FactoryWorkspaceProps) {
  const source = sourceContext ?? editingDraft?.sourceContext ?? null;
  const [mode, setMode] = useState<FactoryMode>(editingDraft?.mode ?? initialMode);
  const [language, setLanguage] = useState(editingDraft?.language ?? source?.language ?? "英语");
  const [ratio, setRatio] = useState<Draft["ratio"]>(editingDraft?.ratio ?? "9:16");
  const [title, setTitle] = useState(editingDraft?.title ?? "");
  const mediaEntries = useMemo(() => Object.values(source?.episodeMedia ?? {}).sort((a, b) => a.episode - b.episode), [source]);
  const connectedEpisodes = useMemo(() => mediaEntries.filter((item) => Boolean(item.url)).map((item) => item.episode), [mediaEntries]);
  const [episodes, setEpisodes] = useState<number[]>(() => editingDraft?.selectedEpisodes?.filter((episode) => connectedEpisodes.includes(episode)) ?? connectedEpisodes);
  const [previewEpisode, setPreviewEpisode] = useState<number | null>(() => episodes[0] ?? null);
  const [savedAt, setSavedAt] = useState(editingDraft?.updatedAt ?? "尚未保存");
  const [autoSaveCountdown, setAutoSaveCountdown] = useState(15);
  const [, setDirty] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [goal, setGoal] = useState("停滑与点击");
  const [entryStrategy, setEntryStrategy] = useState("最快理解");
  const [hookSource, setHookSource] = useState("同题材高表现钩子");
  const [transition, setTransition] = useState("时间倒叙旁白");
  const [variantCount, setVariantCount] = useState(6);
  const [qualityConfirmed, setQualityConfirmed] = useState(false);
  const idRef = useRef(editingDraft?.id ?? `draft-${Date.now()}`);
  const autoSaveSecondsRef = useRef(15);
  const definition = factoryModes.find((item) => item.id === mode)!;
  const previewMedia = previewEpisode == null ? undefined : source?.episodeMedia?.[previewEpisode];
  const availableWithoutConnection = (source?.availableEpisodes ?? []).filter((episode) => !source?.episodeMedia?.[episode]?.url);
  const canCreate = Boolean(source?.kind === "library" && episodes.length && episodes.every((episode) => source.episodeMedia?.[episode]?.url));
  const steps = ["生产目标", "正片承接段", "钩子匹配", "过渡生成", "组合版本", "统一质检"];
  const stepReady = [Boolean(goal), episodes.length > 0, Boolean(hookSource), Boolean(transition), variantCount > 0, qualityConfirmed];

  const buildDraft = (): Draft => {
    const workflow = createInitialFactoryWorkflow();
    workflow.currentStep = workflow.steps[activeStep]?.id ?? "production-goal";
    workflow.goal = {
      objective: goal === "停滑与点击" ? "click-through" : goal === "连续观看" ? "completion" : "conversion",
      market: "美国",
      language,
      platform: "Meta",
      ratio,
      targetDurationSeconds: 90,
      plannedVariantCount: variantCount,
      aiGenerationAllowed: hookSource === "新生成钩子",
      intensity: "balanced",
    };
    workflow.steps = workflow.steps.map((step, index) => ({ ...step, state: index < activeStep ? "completed" : index === activeStep ? "active" : stepReady[index] ? "ready" : "locked" }));
    workflow.qualityReport = { status: qualityConfirmed ? "available" : "not-connected", findings: [] };
    return ({
    id: idRef.current,
    title: title.trim() || `${source?.dramaCn ?? source?.dramaTitle ?? source?.title ?? "未命名项目"} · ${definition.name}`,
    mode,
    drama: source?.dramaTitle ?? source?.title ?? "未关联剧目",
    hook: source?.kind === "favorite" || source?.kind === "inspiration" ? source.title : "",
    episodeRange: selectedRange(episodes),
    transition: "未设置",
    language,
    duration: episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) > 0
      ? `${Math.floor(episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) / 60)}:${String(Math.round(episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) % 60)).padStart(2, "0")}`
      : "未生成",
    ratio,
    qualityStatus: "建议优化后生成",
    updatedAt: "刚刚",
    autoSaved: true,
    thumbnailTone: mode === "external-hook" ? "blue" : mode === "episode-narration" ? "violet" : "rose",
    thumbnailUrl: episodes.map((episode) => source?.episodeMedia?.[episode]?.url).find(Boolean),
    progress: 0,
    productionStatus: "编辑中",
    version: editingDraft?.version ?? 1,
    sourceContext: source,
    selectedEpisodes: episodes,
    workflow,
  });
  };

  const save = (silent = false) => {
    if (!source) {
      if (!silent) onNotify?.("请先从剧库选择一部已上传片源的短剧");
      return;
    }
    const draft = buildDraft();
    onDraftAutoSave?.(draft);
    setSavedAt("刚刚自动保存");
    autoSaveSecondsRef.current = 15;
    setAutoSaveCountdown(15);
    setDirty(false);
    if (!silent) onNotify?.("制作草稿已保存到「我的创作」");
  };

  const latestSaveRef = useRef(save);
  latestSaveRef.current = save;

  useEffect(() => {
    if (!source) {
      setAutoSaveCountdown(15);
      return;
    }
    autoSaveSecondsRef.current = 15;
    setAutoSaveCountdown(15);
    const timer = window.setInterval(() => {
      autoSaveSecondsRef.current -= 1;
      if (autoSaveSecondsRef.current <= 0) {
        latestSaveRef.current(true);
        autoSaveSecondsRef.current = 15;
      }
      setAutoSaveCountdown(autoSaveSecondsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [source?.id]);

  const touch = () => setDirty(true);
  const toggleEpisode = (episode: number) => {
    setEpisodes((current) => current.includes(episode) ? current.filter((item) => item !== episode) : [...current, episode].sort((a, b) => a - b));
    touch();
  };

  useEffect(() => {
    const validEpisodes = editingDraft?.selectedEpisodes?.filter((episode) => connectedEpisodes.includes(episode));
    setEpisodes(validEpisodes?.length ? validEpisodes : connectedEpisodes);
    setPreviewEpisode(connectedEpisodes[0] ?? null);
    // Reset media state when the source identity changes; connectedEpisodes is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);

  useEffect(() => {
    if (!connectedEpisodes.length) {
      setPreviewEpisode(null);
      return;
    }
    if (previewEpisode == null || !connectedEpisodes.includes(previewEpisode)) {
      setPreviewEpisode(connectedEpisodes[0]);
    }
  }, [connectedEpisodes, previewEpisode]);

  return <section className={styles.workspace} aria-label="内容工厂">
    <header className={styles.header}>
      <div><span>CONTENT ENGINE</span><h1>内容工厂</h1><p>基于已连接的真实片源创建并持久化制作草稿；未接入的分析、渲染和导出不会展示模拟结果。</p></div>
      <div className={styles.headerActions}><button type="button" onClick={onOpenDrafts}>我的草稿 ↗</button></div>
    </header>

    <nav className={styles.modeTabs} aria-label="制作模式">
      {factoryModes.map((item) => <button type="button" key={item.id} className={mode === item.id ? styles.active : ""} onClick={() => { setMode(item.id); touch(); }}><i>{item.icon}</i><span><b>{item.name}</b><small>{item.description}</small></span></button>)}
    </nav>

    {!source ? <div className={styles.emptyState}><h2>尚未带入剧目与片源</h2><p>请返回剧库，在目标短剧详情中点击“进入内容工厂”。内容工厂不会再自动填入示例剧目或虚构分析。</p></div> : <>
      <div className={styles.sourceBanner}>
        <div><span>当前剧目</span><h2>{source.dramaCn ?? source.title}</h2><p>{source.dramaTitle && source.dramaTitle !== source.title ? source.dramaTitle : source.description}</p></div>
        <dl><div><dt>题材</dt><dd>{source.genre ?? "未填写"}</dd></div><div><dt>语种</dt><dd>{source.language ?? "未填写"}</dd></div><div><dt>剧集</dt><dd>{source.episodes ?? source.availableEpisodes?.length ?? 0} 集</dd></div><div><dt>已连接视频</dt><dd>{connectedEpisodes.length} 集</dd></div></dl>
      </div>

      {availableWithoutConnection.length > 0 && <div className={styles.legalNote}>片源未连接：{availableWithoutConnection.map(padEpisode).join("、")} 只有上传记录，没有可播放文件地址；这些剧集已禁止预览与生成。</div>}

      <div className={styles.editorGrid}>
        <main>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><span>01</span><h2>选择真实片源</h2></div><small>仅列出浏览器当前可读取的视频</small></div>
            {mediaEntries.length ? <div className={styles.episodeSourceGrid}>{mediaEntries.map((media) => <article key={media.episode} className={`${episodes.includes(media.episode) ? styles.selected : ""} ${previewEpisode === media.episode ? styles.previewing : ""} ${!media.url ? styles.episodeDisabled : ""}`}><button type="button" disabled={!media.url} className={styles.episodePreviewButton} onClick={() => setPreviewEpisode(media.episode)}><span><b>{padEpisode(media.episode)}</b><em>{previewEpisode === media.episode ? "正在预览" : "点击预览"}</em></span><small>{media.url ? media.name : "片源未连接"}</small></button><label><input type="checkbox" disabled={!media.url} checked={episodes.includes(media.episode)} onChange={() => toggleEpisode(media.episode)} /><span>{episodes.includes(media.episode) ? "已选入制作" : "选入制作"}</span></label></article>)}</div> : <div className={styles.emptyState}><h3>没有可读取的视频文件</h3><p>该剧只传入了集号，没有把视频文件地址带到内容工厂。请在剧库重新上传或补传片源。</p></div>}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><span>02</span><h2>草稿信息</h2></div><small>{selectedRange(episodes)}</small></div>
            <div className={styles.draftForm}>
              <label className={styles.titleField}><span>草稿名称</span><input value={title} onChange={(event) => { setTitle(event.target.value); touch(); }} placeholder={`${source.dramaCn ?? source.title} · ${definition.name}`} /></label>
              <label><span>输出比例</span><select value={ratio} onChange={(event) => { setRatio(event.target.value as Draft["ratio"]); touch(); }}><option>9:16</option><option>16:9</option><option>1:1</option></select></label>
              <label><span>成片语种</span><select value={language} onChange={(event) => { setLanguage(event.target.value); touch(); }}><option>英语</option><option>德语</option><option>葡萄牙语</option><option>西班牙语</option></select></label>
            </div>
            <div className={styles.aiSummary}><b>当前能力边界</b><p>本页会保存真实剧目、片源选择和输出参数。粗解析、细解析、镜头推荐、自动剪辑与成片渲染必须等待对应服务返回结果；当前不会伪造评分、时间线或成片。</p></div>
          </section>
        </main>

        <aside>
          <section className={styles.preview}>
            <div className={styles.previewHeader}><div><span>真实视频预览</span><h2>{previewEpisode ? padEpisode(previewEpisode) : "未选择"}</h2></div>{connectedEpisodes.length > 0 && <label><span>切换剧集</span><select value={previewEpisode ?? ""} onChange={(event) => setPreviewEpisode(Number(event.target.value))}>{connectedEpisodes.map((episode) => <option value={episode} key={episode}>{padEpisode(episode)}</option>)}</select></label>}</div>
            {previewMedia?.url ? <video key={previewMedia.url} src={previewMedia.url} controls preload="metadata" /> : <div className={styles.emptyState}><p>选择一集已连接的视频后可在这里播放。</p></div>}
            {connectedEpisodes.length > 0 && <div className={styles.previewEpisodes}>{connectedEpisodes.map((episode) => <button type="button" key={episode} className={previewEpisode === episode ? styles.selected : ""} onClick={() => setPreviewEpisode(episode)} aria-label={`预览 ${padEpisode(episode)}`}>{padEpisode(episode)}</button>)}</div>}
          </section>
        </aside>
      </div>

      <section className={styles.productionFlow} aria-label="内容生产流程">
        <div className={styles.flowHeading}>
          <div><span>内容生产流程</span><h2>从真实片源到可执行生产配方</h2><p>先完成组合设计与风险检查；分析、生成和渲染服务接入后再执行成片任务。</p></div>
          <strong>{stepReady.filter(Boolean).length} / {steps.length} 已配置</strong>
        </div>

        <nav className={styles.flowSteps} aria-label="生产步骤">
          {steps.map((step, index) => <button type="button" key={step} className={`${activeStep === index ? styles.flowStepActive : ""} ${stepReady[index] ? styles.flowStepDone : ""}`} onClick={() => setActiveStep(index)}><i>{stepReady[index] ? "✓" : index + 1}</i><span>{step}</span></button>)}
        </nav>

        <div className={styles.flowBody}>
          {activeStep === 0 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>01 · BRIEF</span><h3>确定这一批素材要解决的问题</h3><p>目标会决定后续钩子、承接点与质检规则的排序。</p></div>
            <div className={styles.choiceCards}>{["停滑与点击", "连续观看", "付费转化"].map((item) => <button type="button" key={item} className={goal === item ? styles.choiceActive : ""} onClick={() => { setGoal(item); touch(); }}><b>{item}</b><small>{item === "停滑与点击" ? "优先强首帧、强冲突和悬念" : item === "连续观看" ? "优先因果完整与情绪递进" : "优先承诺兑现与付费卡点"}</small></button>)}</div>
            <div className={styles.inlineControls}><label>目标市场<select><option>美国</option><option>德国</option><option>巴西</option><option>西班牙</option></select></label><label>投放平台<select><option>Meta</option><option>TikTok</option><option>YouTube Shorts</option></select></label><label>目标时长<select><option>60–90 秒</option><option>30–60 秒</option><option>90–180 秒</option></select></label><label>计划版本<input type="number" min="1" max="24" value={variantCount} onChange={(event) => { setVariantCount(Math.max(1, Math.min(24, Number(event.target.value) || 1))); touch(); }} /></label></div>
          </div>}

          {activeStep === 1 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>02 · STORY ENTRY</span><h3>选择正片如何开始，而不只是选择集数</h3><p>已选 {selectedRange(episodes)}。点击上方片源可切换预览并调整制作范围。</p></div>
            <div className={styles.choiceCards}>{["最快理解", "最自然承接", "最强转化"].map((item) => <button type="button" key={item} className={entryStrategy === item ? styles.choiceActive : ""} onClick={() => { setEntryStrategy(item); touch(); }}><b>{item}</b><small>{item === "最快理解" ? "从首个可理解冲突进入" : item === "最自然承接" ? "保留人物关系和必要因果" : "围绕高潮或付费卡点组织"}</small></button>)}</div>
            <div className={styles.pendingNotice}><b>等待剧情分析结果</b><span>服务接入后，这里将列出带时间码的承接点、人物关系、理解成本与推荐理由；当前不生成虚假节点。</span></div>
          </div>}

          {activeStep === 2 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>03 · HOOK MATCH</span><h3>选择钩子来源与匹配方向</h3><p>先保存筛选条件；只有钩子库返回真实资产后才会出现候选。</p></div>
            <div className={styles.choiceCards}>{["我的收藏", "长效通用钩子", "同题材高表现钩子", "相似人物关系", "新生成钩子"].map((item) => <button type="button" key={item} className={hookSource === item ? styles.choiceActive : ""} onClick={() => { setHookSource(item); touch(); }}><b>{item}</b><small>{item === "新生成钩子" ? "保存生成Brief，等待模型服务" : "从已入库的合法钩子资产检索"}</small></button>)}</div>
            <div className={styles.matchDimensions}><span>排序维度</span>{["停滑潜力", "情绪匹配", "人物关系", "矛盾匹配", "承诺兑现", "货不对板风险"].map((item) => <i key={item}>{item}</i>)}</div>
          </div>}

          {activeStep === 3 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>04 · TRANSITION</span><h3>设计钩子与正片之间的连接</h3><p>过渡作为独立对象保存，后续可替换和跨项目复用。</p></div>
            <div className={styles.choiceCards}>{["时间倒叙旁白", "因果解释旁白", "身份反差旁白", "同动作转场", "台词承接", "BGM延续"].map((item) => <button type="button" key={item} className={transition === item ? styles.choiceActive : ""} onClick={() => { setTransition(item); touch(); }}><b>{item}</b><small>{item.includes("旁白") ? "需要生成过渡文案与配音" : "需要镜头/音频特征匹配"}</small></button>)}</div>
            <div className={styles.transitionPreview}><div><small>钩子末端</small><b>等待选择真实钩子</b></div><i>→ {transition} →</i><div><small>正片起点</small><b>{previewEpisode ? padEpisode(previewEpisode) : "等待选择片源"}</b></div></div>
          </div>}

          {activeStep === 4 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>05 · VARIANTS</span><h3>配置组合数量与受控变量</h3><p>系统只保存生产矩阵，不会在渲染服务未接入时伪造视频。</p></div>
            <div className={styles.variantFormula}><b>1 个正片配方</b><span>×</span><b>3 个钩子变量</b><span>×</span><b>2 个过渡变量</b><strong>= {variantCount} 个计划版本</strong></div>
            <div className={styles.checkGrid}>{["首帧类型", "第一条台词", "主情绪", "卡断位置", "视听模式", "过渡方式"].map((item) => <label key={item}><input type="checkbox" defaultChecked onChange={touch} />{item}</label>)}</div>
          </div>}

          {activeStep === 5 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>06 · QUALITY GATE</span><h3>统一质检门</h3><p>真实分析返回前只检查配置完整性；模型指标与风险结论不会使用模拟分数。</p></div>
            <div className={styles.qualityChecklist}>{["真实片源已连接", "至少选择一集正片", "生产目标已确定", "钩子来源已确定", "过渡方式已确定", "版本数量有效"].map((item, index) => <span key={item} className={stepReady[index] ? styles.checkPass : ""}><i>{stepReady[index] ? "✓" : "!"}</i>{item}</span>)}</div>
            <label className={styles.confirmQuality}><input type="checkbox" checked={qualityConfirmed} onChange={(event) => { setQualityConfirmed(event.target.checked); touch(); }} /><span><b>确认保存为待分析生产配方</b><small>钩子适配、连通性、货不对板和高点击低转化风险将在真实分析完成后给出。</small></span></label>
          </div>}
        </div>

        <div className={styles.flowActions}><button type="button" disabled={activeStep === 0} onClick={() => setActiveStep((step) => Math.max(0, step - 1))}>上一步</button><span>{goal} · {entryStrategy} · {hookSource} · {transition}</span><button type="button" className={styles.nextButton} disabled={activeStep === steps.length - 1} onClick={() => setActiveStep((step) => Math.min(steps.length - 1, step + 1))}>下一步</button></div>
      </section>
    </>}

    <footer className={styles.workspaceFooter}><span><b>自动保存</b>{source ? `${savedAt} · ${autoSaveCountdown} 秒后再次保存` : savedAt}</span><div><button type="button" onClick={() => save(false)} disabled={!source}>保存草稿</button><button type="button" className={styles.generate} disabled={!canCreate} title={!canCreate ? "没有已连接的真实视频片源" : "渲染服务尚未接入；当前仅保存制作草稿"} onClick={() => onNotify?.("片源已就绪；成片渲染服务尚未接入，当前不会生成假视频")}>生成成片（待接入）</button></div></footer>
  </section>;
}

export default FactoryWorkspace;
