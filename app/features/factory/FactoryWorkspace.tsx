"use client";

import { useMemo, useState } from "react";
import { factoryModes, qualityMetrics } from "./mock-data";
import type { Draft, FactoryMode, FactoryWorkspaceProps, QualityStatus } from "./types";
import styles from "./factory.module.css";

const modeCopy: Record<FactoryMode, { options: string[]; timeline: string[]; review: string[] }> = {
  "episode-splice": {
    options: ["普通连贯剧情", "中段高光前置", "尾段高光前置", "跨集高光前置"],
    timeline: ["高光钩子", "必要过渡", "正片起因", "矛盾递进", "小高潮", "付费卡点"],
    review: ["人物连续性", "剧情因果", "情绪闭环", "重复镜头", "伏笔与结果", "卡点强度"],
  },
  "episode-narration": {
    options: ["高密度剧情概括", "情绪型女频", "悬疑追问型", "爽点前置型", "第一人称", "第三人称旁白"],
    timeline: ["解说钩子", "背景快交代", "正片冲突", "解说推进", "原声高潮", "悬念卡点"],
    review: ["首句抓人", "首帧匹配", "画面依据", "信息不过载", "关系清楚", "保留原声高潮"],
  },
  "external-hook": {
    options: ["我的收藏", "长效通用钩子", "同题材高表现", "相似人物关系", "跨剧原型", "自定义生成"],
    timeline: ["外搭钩子", "过渡", "本剧正片", "矛盾递进", "高潮", "付费卡点"],
    review: ["人物一致", "矛盾一致", "情绪连续", "视听锚点", "承诺兑现", "货不对板风险"],
  },
};

function buildDraft(mode: FactoryMode, status: QualityStatus): Draft {
  const definition = factoryModes.find((item) => item.id === mode)!;
  return {
    id: `draft-${mode}-${Date.now()}`,
    title: `${definition.name} · 新生成版本`,
    mode,
    drama: "Goodbye, My Billionaire Husband",
    hook: mode === "external-hook" ? "婚礼现场身份反转" : mode === "episode-narration" ? "她为什么主动放弃亿万遗产？" : "董事会身份揭露",
    episodeRange: "EP 08–12",
    transition: mode === "external-hook" ? "身份反差旁白" : mode === "episode-narration" ? "原声高潮" : "动作匹配",
    language: "英语",
    duration: mode === "episode-splice" ? "01:18" : "00:58",
    ratio: "9:16",
    qualityStatus: status,
    updatedAt: "刚刚",
    autoSaved: true,
    thumbnailTone: mode === "external-hook" ? "blue" : mode === "episode-narration" ? "violet" : "rose",
    progress: 36,
  };
}

export function FactoryWorkspace({ initialMode = "episode-splice", editingDraft, onDraftAutoSave, onOpenDrafts, onNotify }: FactoryWorkspaceProps) {
  const [mode, setMode] = useState<FactoryMode>(editingDraft?.mode ?? initialMode);
  const [step, setStep] = useState(0);
  const [selectedOption, setSelectedOption] = useState(0);
  const [qualityStatus, setQualityStatus] = useState<QualityStatus>(editingDraft?.qualityStatus ?? "建议优化后生成");
  const [savedAt, setSavedAt] = useState(editingDraft?.updatedAt ?? "尚未生成");
  const definition = useMemo(() => factoryModes.find((item) => item.id === mode)!, [mode]);
  const content = modeCopy[mode];

  const selectMode = (next: FactoryMode) => {
    setMode(next);
    setStep(0);
    setSelectedOption(0);
    setQualityStatus("建议优化后生成");
  };

  const generate = () => {
    if (qualityStatus === "货不对板，禁止批量生成") {
      onNotify?.("质检未通过：货不对板，禁止批量生成");
      return;
    }
    const draft = buildDraft(mode, qualityStatus);
    onDraftAutoSave?.(draft);
    setSavedAt("刚刚自动保存");
    setStep(definition.steps.length - 1);
    onNotify?.("已生成预览，并自动保存至「我的草稿」");
  };

  return (
    <section className={styles.workspace} aria-label="内容工厂">
      <header className={styles.header}>
        <div><span>CONTENT ENGINE</span><h1>内容工厂</h1><p>选择内容、设计钩子、生成结构、编辑时间线，经统一质检后自动保存。</p></div>
        <button type="button" onClick={onOpenDrafts}>我的草稿 <b>↗</b></button>
      </header>

      <nav className={styles.modeTabs} aria-label="内容工厂模式">
        {factoryModes.map((item) => <button type="button" key={item.id} className={mode === item.id ? styles.active : ""} onClick={() => selectMode(item.id)}><i>{item.icon}</i><span><b>{item.name}</b><small>{item.description}</small></span></button>)}
      </nav>

      <div className={styles.stepper}>
        {definition.steps.map((label, index) => <button type="button" key={label} className={index === step ? styles.current : index < step ? styles.done : ""} onClick={() => setStep(index)}><i>{index < step ? "✓" : index + 1}</i><span>{label}</span></button>)}
      </div>

      <div className={styles.mainGrid}>
        <aside className={styles.sourcePanel}>
          <div className={styles.panelHeading}><div><small>01 · CONTENT</small><h2>{mode === "episode-narration" ? "剧情与解说策略" : mode === "external-hook" ? "正片与钩子来源" : "正片与拼接策略"}</h2></div><span>AI 已解析</span></div>
          <label>选择短剧<select defaultValue="Goodbye"><option value="Goodbye">Goodbye, My Billionaire Husband</option><option>The Alpha&apos;s Forbidden Bride</option></select></label>
          <label>正片区间<select defaultValue="EP 08–12"><option>EP 08–12</option><option>EP 16–21</option><option>AI 推荐：EP 24–29</option></select></label>
          <div className={styles.aiSummary}><b>✦ AI 区间摘要</b><p>身份压制持续升级，EP 11 完成董事会反转；人物、伏笔和卡点完整，适合 9:16 紧凑剪辑。</p><div><span>强情绪 92</span><span>连续性 89</span><span>剧透风险 中</span></div></div>
          <p className={styles.fieldLabel}>{mode === "episode-splice" ? "拼接策略" : mode === "episode-narration" ? "解说策略" : "钩子来源"}</p>
          <div className={styles.optionGrid}>{content.options.map((option, index) => <button type="button" key={option} className={selectedOption === index ? styles.selected : ""} onClick={() => setSelectedOption(index)}>{option}<small>{index === 0 ? "推荐" : ""}</small></button>)}</div>
        </aside>

        <main className={styles.editorPanel}>
          <div className={styles.preview}><div><small>9:16 · LIVE PREVIEW</small><button type="button" aria-label="播放预览">▶</button><span>00:00 / 01:18</span></div></div>
          {mode === "episode-narration" && <div className={styles.scriptRow}><b>解说 01</b><p>她主动放弃亿万遗产，却在离婚当天拿到了整座集团。</p><span>EP 08 · 00:12–00:18</span><button type="button">重写</button></div>}
          {mode === "external-hook" && <div className={styles.transition}><div><small>钩子末帧</small><b>婚礼现场 · 戒指落地</b></div><i>身份反差旁白 · 3.2s<br/><strong>自然度 91</strong></i><div><small>正片首帧</small><b>EP 08 · 女主推门</b></div></div>}
          <div className={styles.timelineHead}><div><small>03 · TIMELINE</small><h2>结构时间线</h2></div><span>拖动 · 裁切 · 替换镜头 · 原声</span></div>
          <div className={styles.ruler}>{["00:00", "00:15", "00:30", "00:45", "01:00"].map((time) => <span key={time}>{time}</span>)}</div>
          <div className={styles.timeline}>{content.timeline.map((item, index) => <button type="button" key={item} className={index === 0 ? styles.hookClip : index === 1 ? styles.bridgeClip : styles.storyClip}><b>{item}</b><small>{index === 0 ? "0–6s" : `${index * 11}–${index * 11 + 11}s`}</small></button>)}</div>
          <div className={styles.track}><b>声音</b><span>原声开</span><span>BGM · Tension 04</span><span>字幕 · EN</span><span>音效 · Hit</span></div>
        </main>
      </div>

      <section className={styles.qualityGate}>
        <div className={styles.qualityTitle}><div><span>QUALITY GATE</span><h2>统一钩子质检门</h2><p>任何模式生成前，都必须确认首帧、第一句、T1/T2 与钩子承诺。</p></div><select value={qualityStatus} onChange={(event) => setQualityStatus(event.target.value as QualityStatus)}><option>可以直接生成</option><option>建议优化后生成</option><option>停滑能力弱</option><option>音画不同步</option><option>过度剧透</option><option>高点击低转化风险</option><option>货不对板，禁止批量生成</option></select></div>
        <div className={styles.metrics}>{qualityMetrics.map(([label, score]) => <div key={label}><span>{label}<b>{score}</b></span><i><em style={{ width: `${score}%` }} /></i></div>)}</div>
        <div className={styles.reviewGrid}>
          <div className={styles.curves}><b>情绪 / 冲突 / 信息 / 悬念曲线</b>{["情绪", "冲突", "信息", "悬念"].map((label, index) => <div key={label}><span>{label}</span><svg viewBox="0 0 220 30" preserveAspectRatio="none"><polyline points={index % 2 ? "0,25 42,19 86,22 128,8 170,13 220,2" : "0,26 42,23 86,13 128,17 170,5 220,9"} /></svg></div>)}</div>
          <div className={styles.checks}><b>模式专项检查</b>{content.review.map((item, index) => <span key={item}><i className={index === 5 && qualityStatus !== "可以直接生成" ? styles.warn : ""}>{index === 5 && qualityStatus !== "可以直接生成" ? "!" : "✓"}</i>{item}</span>)}</div>
          <div className={styles.diagnosis}><b>滑走风险与修改建议</b><p><strong>00:02.4</strong> 第一条信息稍晚，建议将身份冲突台词提前 0.8 秒，并在首帧加入关键道具。</p><button type="button" onClick={() => { setQualityStatus("可以直接生成"); onNotify?.("已应用质检建议"); }}>✦ 一键应用建议</button></div>
        </div>
        <footer><span>自动保存：{savedAt} · 版本历史已开启</span><div><button type="button" onClick={() => onNotify?.("钩子已加入重新生成队列")}>重新生成钩子</button><button type="button" className={styles.generate} onClick={generate}>{qualityStatus === "货不对板，禁止批量生成" ? "质检阻止生成" : "生成预览并保存草稿 →"}</button></div></footer>
      </section>
    </section>
  );
}

export default FactoryWorkspace;
