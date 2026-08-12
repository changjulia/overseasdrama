"use client";

import { useMemo, useState } from "react";
import { factoryModes, qualityMetrics, qualityOptions } from "./mock-data";
import type { Draft, FactoryMode, FactoryWorkspaceProps, QualityStatus } from "./types";
import baseStyles from "./factory.module.css";
import enhancementStyles from "./factory-enhancements.module.css";

const styles = { ...baseStyles, ...enhancementStyles };

type Clip = { id: string; name: string; range: string; tone: "hook" | "bridge" | "story"; seconds: number };
type ScriptLine = { id: number; text: string; source: string; emotion: string; original: boolean };

const modeData: Record<FactoryMode, { options: string[]; timeline: string[]; review: string[] }> = {
  "episode-splice": {
    options: ["普通连贯剧情", "中段高光前置", "尾段高光前置", "跨集高光前置"],
    timeline: ["高光钩子", "必要过渡", "正片起因", "矛盾递进", "小高潮", "高潮", "付费卡点"],
    review: ["人物连续性", "剧情因果", "情绪闭环", "重复镜头", "伏笔与结果", "卡点强度"],
  },
  "episode-narration": {
    options: ["高密度剧情概括", "情绪型女频解说", "悬疑追问型", "爽点前置型", "第一人称角色解说", "第三人称旁白", "特殊人物关系前置", "强设定世界观前置"],
    timeline: ["解说钩子", "背景快速交代", "正片冲突", "解说推进", "原声高潮", "解说悬念卡点"],
    review: ["首句抓人", "首帧匹配", "画面有依据", "信息不过载", "关系清楚", "保留原声高潮", "结尾追剧欲"],
  },
  "external-hook": {
    options: ["我的收藏", "长效通用钩子", "同题材高表现钩子", "相似人物关系 / 冲突", "已验证跨剧原型", "自定义生成新钩子"],
    timeline: ["外搭钩子", "过渡", "本剧正片", "矛盾递进", "高潮", "付费卡点"],
    review: ["人物一致性", "核心矛盾一致", "情绪连续", "叙事逻辑", "视听锚点", "承诺兑现", "货不对板风险"],
  },
};

const hookCandidates = [
  { title: "董事会身份揭露", source: "EP 11 · 02:14–02:20", type: "极端结果前置", score: 94, risk: "低", tags: "强情绪 · 身份反转 · 戒指锚点" },
  { title: "离婚协议当众撕毁", source: "EP 08 · 00:42–00:49", type: "戏剧事件", score: 89, risk: "中", tags: "感官刺激 · 关系冲突 · 动作锚点" },
  { title: "她主动放弃亿万遗产", source: "EP 10 · 04:06–04:13", type: "悬疑追问", score: 86, risk: "低", tags: "强设定 · 高信息效率 · 台词锚点" },
];

const transitionCandidates = [
  { title: "身份反差旁白", text: "三年前她被赶出家门，三年后所有人都要向她低头。", duration: "3.2s", score: 91, basis: "人物身份 + 戒指道具" },
  { title: "同动作匹配", text: "钩子末帧落下戒指，正片首帧由女主拾起。", duration: "2.4s", score: 88, basis: "动作方向 + 景别连续" },
  { title: "因果解释旁白", text: "这一切，要从她推开董事会大门说起。", duration: "2.8s", score: 84, basis: "因果关系 + BGM 延续" },
];

const initialScripts: ScriptLine[] = [
  { id: 1, text: "她主动放弃亿万遗产，却在离婚当天拿到了整座集团。", source: "EP 08 · 00:12–00:18", emotion: "压抑 → 反转", original: false },
  { id: 2, text: "所有人都以为她只是被扫地出门的妻子。", source: "EP 09 · 01:03–01:09", emotion: "屈辱", original: false },
  { id: 3, text: "直到董事长喊出她真正的名字。", source: "EP 11 · 02:14–02:20", emotion: "爆发", original: true },
];

function createClips(mode: FactoryMode): Clip[] {
  return modeData[mode].timeline.map((name, index) => ({ id: `${mode}-${index}`, name, range: index === 0 ? "0–6s" : `${index * 10}–${index * 10 + 10}s`, tone: index === 0 ? "hook" : index === 1 ? "bridge" : "story", seconds: index === 0 ? 6 : 10 }));
}

function buildDraft(mode: FactoryMode, status: QualityStatus, language: string, ratio: Draft["ratio"], version: number): Draft {
  const definition = factoryModes.find((item) => item.id === mode)!;
  return { id: `draft-${mode}-${Date.now()}`, title: `${definition.name} · 生成版本 V${version}`, mode, drama: "Goodbye, My Billionaire Husband", hook: mode === "external-hook" ? "婚礼现场身份反转" : mode === "episode-narration" ? "她为什么主动放弃亿万遗产？" : "董事会身份揭露", episodeRange: "EP 08–12", transition: mode === "external-hook" ? "身份反差旁白" : mode === "episode-narration" ? "原声高潮" : "动作匹配", language, duration: mode === "episode-splice" ? "01:18" : "00:58", ratio, qualityStatus: status, updatedAt: "刚刚", autoSaved: true, thumbnailTone: mode === "external-hook" ? "blue" : mode === "episode-narration" ? "violet" : "rose", progress: 100, productionStatus: "待审核", version };
}

export function FactoryWorkspace({ initialMode = "episode-splice", editingDraft, onDraftAutoSave, onOpenDrafts, onNotify }: FactoryWorkspaceProps) {
  const [mode, setMode] = useState<FactoryMode>(editingDraft?.mode ?? initialMode);
  const [step, setStep] = useState(0);
  const [selectedOption, setSelectedOption] = useState(0);
  const [hook, setHook] = useState(0);
  const [transition, setTransition] = useState(0);
  const [clips, setClips] = useState<Clip[]>(() => createClips(editingDraft?.mode ?? initialMode));
  const [selectedClip, setSelectedClip] = useState(0);
  const [scripts, setScripts] = useState(initialScripts);
  const [qualityStatus, setQualityStatus] = useState<QualityStatus>(editingDraft?.qualityStatus ?? "建议优化后生成");
  const [savedAt, setSavedAt] = useState(editingDraft?.updatedAt ?? "刚刚自动保存");
  const [language, setLanguage] = useState(editingDraft?.language ?? "英语");
  const [ratio, setRatio] = useState<Draft["ratio"]>(editingDraft?.ratio ?? "9:16");
  const [voice, setVoice] = useState("Ava · 情绪女声");
  const [style, setStyle] = useState("情绪型女频");
  const [media, setMedia] = useState({ original: true, subtitle: true, bgm: true, sfx: true, safe: true });
  const [versions, setVersions] = useState(["V3 · 当前版本 · 刚刚", "V2 · 应用质检建议 · 8 分钟前", "V1 · AI 初稿 · 16 分钟前"]);
  const [production, setProduction] = useState<"编辑中" | "生成中" | "待审核" | "已导出">("编辑中");
  const [progress, setProgress] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const definition = useMemo(() => factoryModes.find((item) => item.id === mode)!, [mode]);
  const content = modeData[mode];

  const notifySave = (message = "更改已自动保存") => { setSavedAt("刚刚自动保存"); onNotify?.(message); };
  const selectMode = (next: FactoryMode) => { setMode(next); setStep(0); setSelectedOption(0); setHook(0); setTransition(0); setClips(createClips(next)); setSelectedClip(0); setProduction("编辑中"); setProgress(0); setQualityStatus("建议优化后生成"); };
  const moveClip = (direction: -1 | 1) => { const to = selectedClip + direction; if (to < 0 || to >= clips.length) return; const next = [...clips]; [next[selectedClip], next[to]] = [next[to], next[selectedClip]]; setClips(next); setSelectedClip(to); notifySave("片段顺序已更新并自动保存"); };
  const trimClip = (delta: number) => { setClips((items) => items.map((item, index) => index === selectedClip ? { ...item, seconds: Math.max(2, item.seconds + delta), range: `已裁切 · ${Math.max(2, item.seconds + delta)}s` } : item)); notifySave("片段裁切点已更新"); };
  const rewriteLine = (id: number, action: "rewrite" | "short" | "emotion" | "suspense" | "spoiler") => { const copy = { rewrite: "她放弃遗产的那天，真正的好戏才刚刚开始。", short: "她放弃遗产，却继承了集团。", emotion: "被所有人抛弃后，她亲手夺回了整座集团。", suspense: "她为什么宁愿净身出户，也不肯说出真实身份？", spoiler: "没人知道，她的选择将彻底改变所有人的命运。" }[action]; setScripts((items) => items.map((line) => line.id === id ? { ...line, text: copy } : line)); notifySave("解说句已改写并重新匹配镜头"); };
  const saveVersion = () => { const next = `V${versions.length + 1} · 手动保存 · 刚刚`; setVersions((items) => [next, ...items]); notifySave("已保存新版本"); };
  const generate = () => {
    if (qualityStatus === "货不对板，禁止批量生成") { onNotify?.("质检未通过：货不对板，禁止批量生成"); return; }
    setProduction("生成中"); setProgress(28); onNotify?.("正在渲染：镜头、字幕与音轨已进入生成队列");
    window.setTimeout(() => setProgress(68), 450);
    window.setTimeout(() => { const version = versions.length + 1; const draft = buildDraft(mode, qualityStatus, language, ratio, version); onDraftAutoSave?.(draft); setProgress(100); setProduction("待审核"); setSavedAt("刚刚自动保存"); setReviewOpen(true); setVersions((items) => [`V${version} · 生成预览 · 刚刚`, ...items]); onNotify?.("预览生成完成，已自动保存至「我的草稿」"); }, 900);
  };

  const sharedContent = <>
    <label>选择短剧<select defaultValue="Goodbye" onChange={() => notifySave()}><option value="Goodbye">Goodbye, My Billionaire Husband</option><option>The Alpha&apos;s Forbidden Bride</option></select></label>
    <label>剧情范围<select defaultValue="EP 08–12" onChange={() => notifySave()}><option>EP 08–12</option><option>免费集 EP 01–10</option><option>付费集 EP 11–18</option><option>AI 推荐：EP 24–29</option></select></label>
    <div className={styles.rangeActions}><button type="button">手动选集</button><button type="button" className={styles.primarySoft}>✦ AI 推荐区间</button></div>
    <div className={styles.aiSummary}><b>✦ AI 区间摘要</b><p>身份压制持续升级，EP 11 完成董事会反转；人物、伏笔和卡点完整，适合 9:16 紧凑剪辑。</p><div><span>主角：Ava</span><span>矛盾：身份压制</span><span>高光 92</span><span>连续性 89</span><span>剧透风险 中</span></div></div>
  </>;

  const candidates = <div className={styles.candidateList}>{hookCandidates.map((item, index) => <button type="button" key={item.title} className={hook === index ? styles.candidateSelected : ""} onClick={() => { setHook(index); notifySave("钩子候选已更新"); }}><span className={styles.miniPoster}>▶<small>00:06</small></span><span><b>{item.title}</b><small>{item.source} · {item.type}</small><em>{item.tags}</em></span><strong>{item.score}<small>停滑</small></strong><i>剧透 {item.risk}</i></button>)}</div>;

  const renderSource = () => {
    if (mode === "episode-splice") {
      if (step === 0) return <>{sharedContent}<div className={styles.insightList}><b>区间内容证据</b><span>人物：Ava / Ethan / 董事长</span><span>伏笔：祖母绿戒指将在 EP 11 回收</span><span>推荐卡点：身份公布前 0.6 秒</span></div></>;
      if (step === 1) return <><p className={styles.fieldLabel}>选择拼接策略</p><div className={styles.optionGrid}>{content.options.map((x, i) => <button type="button" key={x} className={selectedOption === i ? styles.selected : ""} onClick={() => { setSelectedOption(i); notifySave(); }}>{x}<small>{i === 1 ? "推荐" : ""}</small></button>)}</div><div className={styles.aiSummary}><b>策略预览</b><p>先展示 EP 11 身份揭露，再通过戒指落地动作回到 EP 08，保留因果与人物连续性。</p></div></>;
      if (step === 2) return <><p className={styles.fieldLabel}>选择高光钩子候选</p>{candidates}</>;
    }
    if (mode === "episode-narration") {
      if (step === 0) return <>{sharedContent}<div className={styles.insightList}><b>AI 剧情理解</b><span>必保节点：净身出户 / 戒指证据 / 董事会揭晓</span><span>可压缩：EP 09 回忆铺垫 42 秒</span><span>原声高潮：EP 11 “Welcome back, Ms. Carter.”</span></div></>;
      if (step === 1) return <><p className={styles.fieldLabel}>解说策略</p><div className={styles.optionGrid}>{content.options.map((x, i) => <button type="button" key={x} className={selectedOption === i ? styles.selected : ""} onClick={() => { setSelectedOption(i); setStyle(x); notifySave(); }}>{x}<small>{i === 1 ? "推荐" : ""}</small></button>)}</div></>;
      if (step === 2) return <><p className={styles.fieldLabel}>设计第一句 + 第一帧</p>{candidates}<div className={styles.controlGrid}><label>第一句策略<select><option>极端结果前置</option><option>人物关系前置</option><option>悬疑问题前置</option></select></label><label>前 3 秒镜头<select><option>身份揭晓近景</option><option>戒指落地特写</option></select></label></div></>;
      if (step === 3) return <><p className={styles.fieldLabel}>解说参数</p><div className={styles.controlGrid}><label>风格<select value={style} onChange={(e) => setStyle(e.target.value)}>{content.options.map((x) => <option key={x}>{x}</option>)}</select></label><label>语种<select value={language} onChange={(e) => setLanguage(e.target.value)}><option>英语</option><option>德语</option><option>葡萄牙语</option><option>西班牙语</option></select></label><label>声音<select value={voice} onChange={(e) => setVoice(e.target.value)}><option>Ava · 情绪女声</option><option>Ryan · 悬疑男声</option><option>Mia · 清晰女声</option></select></label></div><div className={styles.aiSummary}><b>语速与时长</b><p>168 WPM · 预计 00:58 · 信息密度 4.2 点/10秒</p></div></>;
    }
    if (mode === "external-hook") {
      if (step === 0) return <>{sharedContent}<div className={styles.insightList}><b>正片 T2 适配摘要</b><span>特殊关系：隐婚妻子 × 集团继承人</span><span>核心承诺：隐忍后公开身份反杀</span><span>T2 候选：EP 08 女主推门 / 自然度 92</span></div></>;
      if (step === 1) return <><p className={styles.fieldLabel}>钩子来源</p><div className={styles.optionGrid}>{content.options.map((x, i) => <button type="button" key={x} className={selectedOption === i ? styles.selected : ""} onClick={() => { setSelectedOption(i); notifySave(); }}>{x}<small>{i === 0 ? "12 个" : ""}</small></button>)}</div></>;
      if (step === 2) return <><p className={styles.fieldLabel}>推荐钩子 · 已按正片适配度排序</p>{candidates}<div className={styles.aiSummary}><b>推荐理由</b><p>钩子的“婚礼羞辱”与本剧的“隐婚身份”共享人物关系和情绪承诺，且戒指可作为视听锚点。</p></div></>;
      if (step === 3) return <><p className={styles.fieldLabel}>选择制作方式</p><div className={styles.optionGrid}>{["使用内部合法钩子资产", "原结构换人物", "原结构换场景", "保留结构重新生成", "多人物资产批量复刻", "多语种本地化"].map((x, i) => <button key={x} className={selectedOption === i ? styles.selected : ""} onClick={() => setSelectedOption(i)}>{x}<small>{i === 0 ? "推荐" : ""}</small></button>)}</div><div className={styles.legalNote}>✓ 版权与授权记录完整，可用于商业投放</div></>;
      if (step === 4) return <><p className={styles.fieldLabel}>钩子生成控制</p><div className={styles.controlGrid}>{[["主情绪", "屈辱后反杀", "惊恐", "甜宠"], ["感官刺激", "戒指落地", "泼水", "撞击"], ["戏剧事件", "身份揭露", "婚礼逃跑", "当众解雇"], ["特殊关系", "隐婚夫妻", "继承人×前夫", "狼王×禁忌新娘"], ["镜头节奏", "强节奏", "渐进", "单镜头"], ["卡断位置", "结果前", "动作前", "原因前"]].map(([name, ...values]) => <label key={name}>{name}<select>{values.map((x) => <option key={x}>{x}</option>)}</select></label>)}</div><div className={styles.variantRow}>{["强视觉", "强台词", "视听同频", "强情绪", "强悬念", "高信息密度"].map((x) => <button key={x} type="button" onClick={(e) => e.currentTarget.classList.toggle(styles.toggleOn)}>{x}</button>)}</div></>;
      if (step === 5) return <><p className={styles.fieldLabel}>过渡候选</p><div className={styles.transitionList}>{transitionCandidates.map((item, i) => <button key={item.title} className={transition === i ? styles.candidateSelected : ""} onClick={() => setTransition(i)}><b>{item.title}<em>自然度 {item.score}</em></b><span>{item.text}</span><small>{item.duration} · {item.basis}</small></button>)}</div><button type="button" className={styles.fullButton} onClick={() => onNotify?.("已生成 3 个新的过渡候选")}>✦ 重新生成过渡</button></>;
    }
    return <><p className={styles.fieldLabel}>当前步骤摘要</p><div className={styles.aiSummary}><b>✓ 前置步骤已完成</b><p>所选内容、策略和钩子已同步到时间线。可在右侧继续调整镜头、音轨和输出规格。</p></div><button type="button" className={styles.fullButton} onClick={() => setStep(Math.min(step + 1, definition.steps.length - 1))}>继续下一步 →</button></>;
  };

  return <section className={styles.workspace} aria-label="内容工厂">
    <header className={styles.header}><div><span>CONTENT ENGINE</span><h1>内容工厂</h1><p>三种模式均支持选材、钩子设计、时间线编辑、质检、审核与导出。</p></div><div className={styles.headerActions}><span className={styles.autoSave}>● {savedAt}</span><button type="button" onClick={onOpenDrafts}>我的草稿 ↗</button></div></header>
    <nav className={styles.modeTabs} aria-label="内容工厂模式">{factoryModes.map((item) => <button type="button" key={item.id} className={mode === item.id ? styles.active : ""} onClick={() => selectMode(item.id)}><i>{item.icon}</i><span><b>{item.name}</b><small>{item.description}</small></span></button>)}</nav>
    <div className={styles.stepper}>{definition.steps.map((label, index) => <button type="button" key={label} className={index === step ? styles.current : index < step ? styles.done : ""} onClick={() => setStep(index)}><i>{index < step ? "✓" : index + 1}</i><span>{label}</span></button>)}</div>
    <div className={styles.mainGrid}>
      <aside className={styles.sourcePanel}><div className={styles.panelHeading}><div><small>{String(step + 1).padStart(2, "0")} · {definition.steps[step]?.toUpperCase()}</small><h2>{definition.steps[step]}</h2></div><span>AI 已解析</span></div>{renderSource()}</aside>
      <main className={styles.editorPanel}>
        <div className={styles.editorTop}><div className={styles.preview}><div><small>{ratio} · LIVE PREVIEW</small><button type="button" aria-label="播放预览">▶</button><span>00:00 / {editingDraft?.duration ?? "01:18"}</span></div></div><aside className={styles.outputControls}><b>输出设置</b><label>画幅<select value={ratio} onChange={(e) => { setRatio(e.target.value as Draft["ratio"]); notifySave(); }}><option>9:16</option><option>16:9</option><option>1:1</option></select></label><label>语种<select value={language} onChange={(e) => { setLanguage(e.target.value); notifySave(); }}><option>英语</option><option>德语</option><option>葡萄牙语</option><option>西班牙语</option></select></label><button className={media.safe ? styles.toggleOn : ""} onClick={() => setMedia({ ...media, safe: !media.safe })}>安全区 {media.safe ? "开" : "关"}</button><button onClick={saveVersion}>＋ 保存新版本</button><details><summary>版本历史 ({versions.length})</summary>{versions.map((x) => <button key={x} onClick={() => onNotify?.(`已切换到 ${x.split(" · ")[0]}`)}>{x}</button>)}</details></aside></div>
        {mode === "episode-narration" && step >= 3 && <div className={styles.scriptWorkbench}><div><b>解说脚本工作台</b><span>{style} · {language} · {voice}</span></div>{scripts.map((line) => <article key={line.id}><b>{String(line.id).padStart(2, "0")}</b><textarea value={line.text} onChange={(e) => setScripts((items) => items.map((x) => x.id === line.id ? { ...x, text: e.target.value } : x))}/><span>{line.source}<small>{line.emotion} · {line.original ? "保留原声" : "关闭原声"}</small></span><div><button onClick={() => rewriteLine(line.id, "rewrite")}>重写</button><button onClick={() => rewriteLine(line.id, "short")}>缩短</button><button onClick={() => rewriteLine(line.id, "emotion")}>强情绪</button><button onClick={() => rewriteLine(line.id, "suspense")}>强悬念</button><button onClick={() => rewriteLine(line.id, "spoiler")}>降剧透</button></div></article>)}</div>}
        {mode === "external-hook" && step >= 5 && <div className={styles.transition}><div><small>钩子末帧</small><b>婚礼现场 · 戒指落地</b></div><i>{transitionCandidates[transition].title} · {transitionCandidates[transition].duration}<br/><strong>自然度 {transitionCandidates[transition].score}</strong></i><div><small>正片首帧</small><b>EP 08 · 女主推门</b></div></div>}
        <div className={styles.timelineHead}><div><small>TIMELINE EDITOR</small><h2>结构时间线</h2></div><span>单击片段后可排序、裁切或替换</span></div>
        <div className={styles.ruler}>{["00:00", "00:15", "00:30", "00:45", "01:00"].map((time) => <span key={time}>{time}</span>)}</div>
        <div className={styles.timeline}>{clips.map((item, index) => <button type="button" key={item.id} className={`${styles[`${item.tone}Clip`]} ${selectedClip === index ? styles.clipSelected : ""}`} style={{ flex: item.seconds }} onClick={() => setSelectedClip(index)}><b>{item.name}</b><small>{item.range}</small></button>)}</div>
        <div className={styles.clipTools}><b>已选：{clips[selectedClip]?.name}</b><button onClick={() => moveClip(-1)}>← 前移</button><button onClick={() => moveClip(1)}>后移 →</button><button onClick={() => trimClip(-1)}>左裁 1s</button><button onClick={() => trimClip(1)}>延长 1s</button><button onClick={() => { setClips((items) => items.map((x, i) => i === selectedClip ? { ...x, name: "替换镜头 · EP 10" } : x)); notifySave("镜头已替换"); }}>替换镜头</button></div>
        <div className={styles.track}><b>音画轨</b>{([["original", "原声"], ["subtitle", `字幕 · ${language}`], ["bgm", "BGM · Tension 04"], ["sfx", "音效 · Hit"]] as const).map(([key, label]) => <button key={key} className={media[key] ? styles.trackOn : ""} onClick={() => { setMedia({ ...media, [key]: !media[key] }); notifySave(); }}>{media[key] ? "✓" : "＋"} {label}</button>)}</div>
      </main>
    </div>
    <section className={styles.qualityGate}><div className={styles.qualityTitle}><div><span>QUALITY GATE</span><h2>统一钩子质检门</h2><p>七项指标、四条曲线、首帧 / 第一句、T1 / T2 和模式专项检查。</p></div><select value={qualityStatus} onChange={(e) => setQualityStatus(e.target.value as QualityStatus)}>{qualityOptions.map((x) => <option key={x}>{x}</option>)}</select></div>
      <div className={styles.metrics}>{qualityMetrics.map(([label, score]) => <div key={label}><span>{label}<b>{score}</b></span><i><em style={{ width: `${score}%` }}/></i></div>)}</div>
      <div className={styles.reviewGrid}><div className={styles.curves}><b>情绪 / 冲突 / 信息 / 悬念曲线</b>{["情绪", "冲突", "信息", "悬念"].map((label, index) => <div key={label}><span>{label}</span><svg viewBox="0 0 220 30" preserveAspectRatio="none"><polyline points={index % 2 ? "0,25 42,19 86,22 128,8 170,13 220,2" : "0,26 42,23 86,13 128,17 170,5 220,9"}/></svg></div>)}</div><div className={styles.checks}><b>首帧 / 边界 / 专项检查</b><span><i>✓</i>第一帧与第一句话匹配</span><span><i>✓</i>T1 00:06.2 / T2 00:09.4</span>{content.review.map((item, index) => <span key={item}><i className={index === content.review.length - 1 && qualityStatus !== "可以直接生成" ? styles.warn : ""}>{index === content.review.length - 1 && qualityStatus !== "可以直接生成" ? "!" : "✓"}</i>{item}</span>)}</div><div className={styles.diagnosis}><b>滑走风险与修改建议</b><p><strong>00:02.4</strong> 身份冲突台词出现稍晚；建议提前 0.8 秒，并在首帧加入戒指道具。</p><p><strong>钩子末帧 → 正片首帧</strong> 人物一致，动作方向偏差 12°。</p><button type="button" onClick={() => { setQualityStatus("可以直接生成"); setClips((items) => items.map((x, i) => i === 0 ? { ...x, range: "0–5.2s · 已优化" } : x)); notifySave("已应用全部质检建议"); }}>✦ 一键应用全部建议</button></div></div>
      {production === "生成中" && <div className={styles.renderProgress}><span><b>正在生成成片</b><small>镜头合成 → 字幕 → 混音 → 编码</small></span><i><em style={{ width: `${progress}%` }}/></i><strong>{progress}%</strong></div>}
      {reviewOpen && <div className={styles.reviewBar}><span><b>预览已生成，等待审核</b><small>V{versions.length} · {ratio} · {language} · 已自动进入我的草稿</small></span><button onClick={() => { setProduction("编辑中"); setReviewOpen(false); }}>返回修改</button><button onClick={() => { setProduction("已导出"); setReviewOpen(false); onNotify?.("审核通过，导出任务已创建"); }}>审核通过并导出</button></div>}
      <footer><span>自动保存：{savedAt} · {production} · 版本历史已开启</span><div><button type="button" onClick={() => onNotify?.("已生成 3 个新钩子候选")}>重新生成钩子</button><button type="button" onClick={saveVersion}>保存草稿</button><button type="button" className={styles.generate} onClick={generate} disabled={production === "生成中"}>{qualityStatus === "货不对板，禁止批量生成" ? "质检阻止生成" : production === "生成中" ? `生成中 ${progress}%` : "生成预览并保存草稿 →"}</button></div></footer>
    </section>
  </section>;
}

export default FactoryWorkspace;
