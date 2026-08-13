"use client";

import { useMemo, useState } from "react";
import styles from "./InspirationWorkspace.module.css";

export type InspirationTab = "feed" | "prototypes" | "analysis" | "review";
type View = "grid" | "table";
type SortKey = "exposure" | "days" | "captured" | "reuse" | "ratio";
type DemoState = "ready" | "loading" | "empty" | "error";
type MaterialType = "正片剧集拼接" | "正片剧集解说" | "外搭钩子＋本剧正片";

type Material = {
  id: string;
  title: string;
  type: MaterialType;
  source: "外部" | "内部";
  platform: string;
  market: string;
  language: string;
  theme: string;
  emotion: string;
  hookType: string;
  hookDuration: number;
  transition: string;
  episode: string;
  exposure: number;
  days: number;
  captured: string;
  prototype: string;
  reuse: number;
  confidence: number;
  review: string;
  analysis: string;
  color: "rose" | "blue" | "cyan" | "amber";
  sensory: string;
  relation: string;
  highlight: string;
  hookRelation: string;
  avLead: string;
  ageDays: number;
  highPerformanceRatio: number;
};

const materials: Material[] = [
  { id: "AD-240812-018", title: "婚礼宣誓时，她叫出另一个人的名字", type: "外搭钩子＋本剧正片", source: "外部", platform: "Meta", market: "美国", language: "英语", theme: "情感背叛", emotion: "震惊", hookType: "关系禁忌", hookDuration: 18, transition: "声音桥接", episode: "EP01 00:42–02:04", exposure: 28400000, days: 31, captured: "08-12 10:24", prototype: "公开场合关系崩塌", reuse: 17, confidence: 94, review: "已通过", analysis: "深度分析完成", color: "rose", sensory: "强表情／强动作", relation: "禁忌旧爱", highlight: "无前置", hookRelation: "因果承接", avLead: "台词主导", ageDays: 1, highPerformanceRatio: 71 },
  { id: "AD-240812-011", title: "服务生摘下面具，董事会全体起立", type: "正片剧集拼接", source: "内部", platform: "TikTok", market: "英国", language: "英语", theme: "身份反转", emotion: "爽感", hookType: "身份揭晓", hookDuration: 12, transition: "无过渡", episode: "EP07 01:16–03:01", exposure: 19200000, days: 24, captured: "08-12 09:18", prototype: "低位身份瞬间翻盘", reuse: 12, confidence: 91, review: "已通过", analysis: "深度分析完成", color: "blue", sensory: "大字字幕", relation: "伪弱者×权势群体", highlight: "中段高光", hookRelation: "情绪承接", avLead: "画面主导", ageDays: 12, highPerformanceRatio: 66 },
  { id: "AD-240811-083", title: "全族要处决她，狼王却闻到了继承人", type: "正片剧集解说", source: "外部", platform: "Meta", market: "德国", language: "德语", theme: "狼人奇幻", emotion: "紧张", hookType: "极端处境", hookDuration: 23, transition: "解说承接", episode: "EP03–EP05", exposure: 14600000, days: 19, captured: "08-11 22:46", prototype: "审判现场血脉反转", reuse: 8, confidence: 86, review: "待复核", analysis: "基础分析完成", color: "cyan", sensory: "视觉奇观", relation: "隐秘血脉", highlight: "尾段高光", hookRelation: "反差承接", avLead: "音效主导", ageDays: 42, highPerformanceRatio: 62 },
  { id: "AD-240811-064", title: "三年前被逐出家门，今晚她来收账", type: "正片剧集拼接", source: "内部", platform: "TikTok", market: "巴西", language: "葡萄牙语", theme: "女性复仇", emotion: "愤怒", hookType: "结果前置", hookDuration: 15, transition: "闪白转场", episode: "EP12→EP01", exposure: 11800000, days: 16, captured: "08-11 19:32", prototype: "红毯归来当众清算", reuse: 9, confidence: 89, review: "已通过", analysis: "深度分析完成", color: "amber", sensory: "突发音效", relation: "伪弱者×权势群体", highlight: "跨集高光", hookRelation: "因果承接", avLead: "画面主导", ageDays: 76, highPerformanceRatio: 58 },
  { id: "AD-240810-039", title: "孩子当众问总裁：你为什么和我长一样", type: "外搭钩子＋本剧正片", source: "外部", platform: "YouTube", market: "墨西哥", language: "西班牙语", theme: "甜宠萌宝", emotion: "震惊", hookType: "秘密揭晓", hookDuration: 21, transition: "匹配剪辑", episode: "EP02 00:18–01:55", exposure: 9700000, days: 13, captured: "08-10 16:08", prototype: "萌宝识父触发旧秘密", reuse: 14, confidence: 78, review: "边界待确认", analysis: "基础分析完成", color: "blue", sensory: "强表情／强动作", relation: "隐秘血脉", highlight: "无前置", hookRelation: "情绪承接", avLead: "台词主导", ageDays: 120, highPerformanceRatio: 49 },
];

const prototypes = [
  { name: "公开场合关系崩塌", summary: "庆典／婚礼中以一句越界台词让稳定关系瞬间破裂", emotion: "震惊＋屈辱", sensory: "静场突停、近景反应、重音切镜", relation: "新娘 × 隐秘旧爱 × 未婚夫", instances: 17, dramas: 6, life: "持续 94 天", ratio: "71%", fit: "豪门、婚恋、复仇", avoid: "轻喜、纯成长", languages: "英 / 德 / 西", universal: "跨市场长效", color: "rose" },
  { name: "低位身份瞬间翻盘", summary: "受辱人物通过信物、称谓或权力动作完成身份反转", emotion: "屈辱→爽感", sensory: "耳光声、全场起立、低角度推镜", relation: "伪弱者 × 权势群体", instances: 12, dramas: 9, life: "持续 61 天", ratio: "66%", fit: "逆袭、豪门、复仇", avoid: "现实慢热", languages: "英 / 葡 / 西", universal: "高通用", color: "blue" },
  { name: "审判现场血脉反转", summary: "群体处决达到峰值时，以超常血脉迫使权威者改判", emotion: "恐惧→震惊", sensory: "祭坛奇观、心跳、环绕运镜", relation: "被审判者 × 族群首领", instances: 8, dramas: 4, life: "持续 38 天", ratio: "62%", fit: "狼人、龙族、奇幻", avoid: "都市现实", languages: "英 / 德", universal: "垂类强势", color: "cyan" },
];

const metricData = [
  ["停滑能力", 92, "00:00 强表情特写＋婚礼静场"],
  ["情绪强度", 88, "00:04 公开叫错名字，屈辱峰值"],
  ["感官刺激", 81, "00:01 杯子碎裂声与快速推镜"],
  ["戏剧强度", 94, "00:07 未婚夫与旧爱同框反应"],
  ["信息效率", 84, "前 6 秒交付三人关系与背叛"],
  ["音画协同", 87, "重音、切镜、字幕在 ±2 帧内同步"],
  ["悬念与正片承诺", 90, "00:16 抛出‘五年前那一夜’"],
] as const;

const analysisProfiles: Record<string, { drama: string; summary: string; firstLine: string; subject: string; relation: string; t1Reason: string; t2Reason: string; bridge: string; body: string; promise: string }> = {
  "AD-240812-018": { drama: "The Vow We Broke", summary: "隐瞒旧情的新娘在婚礼宣誓时叫出旧爱名字，当众击穿三人关系，并承诺揭晓五年前的死亡秘密。", firstLine: "我选择你，Adrian。", subject: "新娘面部占比 42%", relation: "新娘 × 隐秘旧爱 × 未婚夫", t1Reason: "核心背叛事件完成，旧爱进入画面", t2Reason: "合同交易构成首个可理解事件", bridge: "戒指匹配剪辑至旧日合同印章", body: "只要我签字，你就放过我母亲？", promise: "五年前的旧事由合同交易兑现" },
  "AD-240812-011": { drama: "The Hidden Heiress", summary: "受辱服务生在董事会上摘下面具，以董事长称谓和全体起立完成身份翻盘，并承诺清算伪造股权者。", firstLine: "现在，谁还认为我没有资格？", subject: "服务生摘下面具占比 48%", relation: "伪弱者 × 董事会 × 冒名继承人", t1Reason: "真实继承人身份完成揭晓", t2Reason: "股权质询形成首个完整事件", bridge: "无过渡，起立动作直接承接质询", body: "这份股权书上的签名，是伪造的。", promise: "身份反转由董事会表决立即兑现" },
  "AD-240811-083": { drama: "The Alpha's Forbidden Bride", summary: "被族群审判的新娘在处决前显现继承人血脉，迫使狼王改判，并引出禁忌婚约的后续冲突。", firstLine: "处决她——等等，我闻到了王族血脉。", subject: "祭坛光效主体占比 51%", relation: "禁忌新娘 × 狼族首领 × 族群长老", t1Reason: "血脉奇观与改判悬念完成", t2Reason: "狼王暂停处决形成可理解事件", bridge: "心跳声延续至狼王反应镜头", body: "在孩子出生前，任何人不得动她。", promise: "继承人设定由狼王命令直接兑现" },
  "AD-240811-064": { drama: "Her Glorious Return", summary: "被逐出家门的女主在红毯宴会携证据归来，当众宣布收回公司，并引出三年前陷害真相。", firstLine: "三年前你们赶我走，今晚我来收账。", subject: "红毯推门动作占比 46%", relation: "被逐女儿 × 豪门家族 × 冒名继承者", t1Reason: "归来目标与清算对象明确", t2Reason: "股东文件质证形成首个事件", bridge: "闪白转场连接红毯与旧日签字", body: "公司百分之五十一的股份，现在属于我。", promise: "复仇承诺由控股证据开始兑现" },
  "AD-240810-039": { drama: "My Secret Billionaire Dad", summary: "萌宝在公开场合质问总裁为何与自己长得一样，以亲子外貌奇观击穿隐婚秘密，并承诺揭晓母亲当年离开的原因。", firstLine: "叔叔，你为什么和我长得一样？", subject: "萌宝与总裁同框占比 57%", relation: "萌宝 × 隐婚母亲 × 总裁父亲", t1Reason: "亲子疑问与群体反应完成", t2Reason: "总裁追问母亲身份形成首个事件", bridge: "相同侧脸匹配剪辑进入本剧", body: "告诉我，这个孩子到底是谁？", promise: "亲子悬念由旧照片与时间线承接" },
};

const buildTranscript = (material: Material) => {
  const profile = analysisProfiles[material.id];
  const t1 = material.hookDuration;
  const t2 = material.transition === "无过渡" ? t1 : t1 + 6;
  return [
    { time: "00:00–00:03", speaker: "环境 / OCR", asr: `（${material.theme}场景声出现）`, ocr: material.hookType, visual: profile.subject, segment: "钩子", tone: "hook" },
    { time: `00:03–00:${String(Math.min(8, t1)).padStart(2, "0")}`, speaker: "核心人物", asr: profile.firstLine, ocr: material.emotion, visual: profile.relation, segment: "钩子", tone: "hook" },
    { time: `00:08–00:${String(t1).padStart(2, "0")}`, speaker: "旁白 / 对白", asr: profile.t1Reason, ocr: material.prototype, visual: `${material.hookType}完成`, segment: "钩子", tone: "hook" },
    ...(material.transition === "无过渡" ? [] : [{ time: `00:${String(t1).padStart(2, "0")}–00:${String(t2).padStart(2, "0")}`, speaker: "旁白 / BGM", asr: material.transition, ocr: "进入正片", visual: profile.bridge, segment: "过渡", tone: "transition" }]),
    { time: `00:${String(t2).padStart(2, "0")}–00:${String(t2 + 14).padStart(2, "0")}`, speaker: "本剧主角", asr: profile.body, ocr: material.episode, visual: profile.t2Reason, segment: "正片", tone: "body" },
  ];
};

const fmt = (value: number) => value >= 10000000 ? `${(value / 10000000).toFixed(1)}千万` : `${(value / 10000).toFixed(0)}万`;

export type InspirationWorkspaceProps = {
  initialTab?: InspirationTab;
  onOpenFactory?: (materialId: string) => void;
  onFavoriteChange?: (materialId: string, favorite: boolean) => void;
  onAddMonitorSource?: () => void;
};

export function InspirationWorkspace({ initialTab = "feed", onOpenFactory, onFavoriteChange, onAddMonitorSource }: InspirationWorkspaceProps) {
  const [tab, setTab] = useState<InspirationTab>(initialTab);
  const [view, setView] = useState<View>("grid");
  const [language, setLanguage] = useState("全部语种");
  const [type, setType] = useState("全部类型");
  const [emotion, setEmotion] = useState("全部情绪");
  const [sort, setSort] = useState<SortKey>("exposure");
  const [selectedId, setSelectedId] = useState(materials[0].id);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([materials[1].id]);
  const [prototypeIndex, setPrototypeIndex] = useState(0);
  const [toast, setToast] = useState("");
  const [t1, setT1] = useState(23);
  const [t2, setT2] = useState(29);
  const [reviewType, setReviewType] = useState<MaterialType>("正片剧集解说");
  const [reviewStatus, setReviewStatus] = useState("待复核");
  const [moreFilters, setMoreFilters] = useState(false);
  const [platform, setPlatform] = useState("全部平台");
  const [market, setMarket] = useState("全部国家");
  const [theme, setTheme] = useState("全部题材");
  const [hookType, setHookType] = useState("全部钩子");
  const [transition, setTransition] = useState("全部过渡");
  const [reviewFilter, setReviewFilter] = useState("全部状态");
  const [minExposure, setMinExposure] = useState("0");
  const [minDays, setMinDays] = useState("0");
  const [demoState, setDemoState] = useState<DemoState>("ready");
  const [sensory, setSensory] = useState("全部刺激");
  const [relation, setRelation] = useState("全部关系");
  const [highlight, setHighlight] = useState("全部方式");
  const [hookRelation, setHookRelation] = useState("全部关系");
  const [avLead, setAvLead] = useState("全部类型");
  const [captureRange, setCaptureRange] = useState("近一年");
  const [longRunning, setLongRunning] = useState("全部");

  const filtered = useMemo(() => [...materials]
    .filter((item) => language === "全部语种" || item.language === language)
    .filter((item) => type === "全部类型" || item.type === type)
    .filter((item) => emotion === "全部情绪" || item.emotion === emotion)
    .filter((item) => platform === "全部平台" || item.platform === platform)
    .filter((item) => market === "全部国家" || item.market === market)
    .filter((item) => theme === "全部题材" || item.theme === theme)
    .filter((item) => hookType === "全部钩子" || item.hookType === hookType)
    .filter((item) => transition === "全部过渡" || (transition === "包含过渡" ? item.transition !== "无过渡" : item.transition === "无过渡"))
    .filter((item) => reviewFilter === "全部状态" || item.review === reviewFilter)
    .filter((item) => sensory === "全部刺激" || item.sensory === sensory)
    .filter((item) => relation === "全部关系" || item.relation === relation)
    .filter((item) => highlight === "全部方式" || item.highlight === highlight)
    .filter((item) => hookRelation === "全部关系" || item.hookRelation === hookRelation)
    .filter((item) => avLead === "全部类型" || item.avLead === avLead)
    .filter((item) => captureRange === "近一年" || (captureRange === "近 30 天" ? item.ageDays <= 30 : item.ageDays > 30 && item.ageDays <= 90))
    .filter((item) => longRunning === "全部" || (longRunning === "长效 ≥30 天" ? item.days >= 30 : item.days < 30))
    .filter((item) => item.exposure >= Number(minExposure || 0) * 10000 && item.days >= Number(minDays || 0))
    .sort((a, b) => sort === "days" ? b.days - a.days : sort === "captured" ? b.captured.localeCompare(a.captured) : sort === "reuse" ? b.reuse - a.reuse : sort === "ratio" ? b.highPerformanceRatio - a.highPerformanceRatio : b.exposure - a.exposure), [language, type, emotion, platform, market, theme, hookType, transition, reviewFilter, sensory, relation, highlight, hookRelation, avLead, captureRange, longRunning, minExposure, minDays, sort]);
  const selected = materials.find((item) => item.id === selectedId) ?? materials[0];

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };
  const openAnalysis = (id: string) => { setSelectedId(id); setTab("analysis"); };
  const toggleFavorite = (id: string) => {
    const favorite = !favoriteIds.includes(id);
    setFavoriteIds((current) => favorite ? [...current, id] : current.filter((item) => item !== id));
    onFavoriteChange?.(id, favorite);
    flash(favorite ? "已收藏到「我的创作」" : "已取消收藏");
  };

  return <section className={styles.workspace} aria-label="灵感大屏工作区">
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>DISCOVERY CENTER · 市场素材情报</span><h1>灵感大屏</h1><p>从真实跑量实例中识别钩子、结构与可复用的增长方法。</p></div>
      <div className={styles.headerActions}><span className={styles.live}><i />数据更新于 2 分钟前</span><button className={styles.secondary} onClick={() => { onAddMonitorSource?.(); flash("监测源配置已打开"); }}>＋ 添加监测源</button></div>
    </header>

    <nav className={styles.tabs} aria-label="灵感大屏页面">
      {([['feed','跑量素材','1,284'],['prototypes','钩子原型','46'],['analysis','素材分析','AI'],['review','人工复核','12']] as const).map(([key, label, count]) =>
        <button key={key} className={tab === key ? styles.activeTab : ""} onClick={() => setTab(key)}><span>{label}</span><em>{count}</em></button>)}
    </nav>

    {tab === "feed" && <>
      <div className={styles.stats}>
        {[["今日新增素材","1,284","+18.6%"],["活跃跑量素材","3,672","近 7 日"],["新增钩子原型","46","今日 +9"],["长效通用钩子","28","持续 ≥ 30 天"],["待人工复核","12","低置信度"],["覆盖范围","8 市场 / 12 语种","186 部剧"]].map(([label,value,note]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
      </div>
      <div className={styles.toolbar}>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="素材类型"><option>全部类型</option><option>正片剧集拼接</option><option>正片剧集解说</option><option>外搭钩子＋本剧正片</option></select>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="语种"><option>全部语种</option>{[...new Set(materials.map((item) => item.language))].map((item) => <option key={item}>{item}</option>)}</select>
        <select value={emotion} onChange={(e) => setEmotion(e.target.value)} aria-label="强情绪"><option>全部情绪</option>{[...new Set(materials.map((item) => item.emotion))].map((item) => <option key={item}>{item}</option>)}</select>
        <button type="button" className={`${styles.filterMore} ${moreFilters ? styles.filterActive : ""}`} aria-expanded={moreFilters} onClick={() => setMoreFilters((value) => !value)}><span>更多筛选</span><i aria-hidden="true">{moreFilters ? "⌃" : "⌄"}</i></button>
        <span className={styles.spacer} />
        <label className={styles.sort}>排序 <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}><option value="exposure">曝光量</option><option value="days">跑量天数</option><option value="captured">抓取时间</option><option value="reuse">钩子复用次数</option><option value="ratio">高表现实例比例</option></select></label>
        <div className={styles.viewSwitch}><button className={view === "grid" ? styles.selected : ""} onClick={() => setView("grid")} aria-label="网格视图">▦</button><button className={view === "table" ? styles.selected : ""} onClick={() => setView("table")} aria-label="表格视图">☷</button></div>
      </div>
      {moreFilters && <section className={styles.filterPanel} aria-label="更多筛选">
        <div className={styles.filterPanelHead}><div><b>高级筛选</b><span>覆盖来源、内容、结构、表现与复核字段</span></div><button onClick={() => { setPlatform("全部平台"); setMarket("全部国家"); setTheme("全部题材"); setHookType("全部钩子"); setTransition("全部过渡"); setReviewFilter("全部状态"); setSensory("全部刺激"); setRelation("全部关系"); setHighlight("全部方式"); setHookRelation("全部关系"); setAvLead("全部类型"); setCaptureRange("近一年"); setLongRunning("全部"); setMinExposure("0"); setMinDays("0"); }}>重置筛选</button></div>
        <div className={styles.filterFields}>
          <label>平台<select value={platform} onChange={(e) => setPlatform(e.target.value)}><option>全部平台</option><option>Meta</option><option>TikTok</option><option>YouTube</option></select></label>
          <label>国家／市场<select value={market} onChange={(e) => setMarket(e.target.value)}><option>全部国家</option>{[...new Set(materials.map((item) => item.market))].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>故事题材<select value={theme} onChange={(e) => setTheme(e.target.value)}><option>全部题材</option>{[...new Set(materials.map((item) => item.theme))].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>钩子类型<select value={hookType} onChange={(e) => setHookType(e.target.value)}><option>全部钩子</option>{[...new Set(materials.map((item) => item.hookType))].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>感官刺激<select value={sensory} onChange={(e) => setSensory(e.target.value)}><option>全部刺激</option><option>强表情／强动作</option><option>视觉奇观</option><option>大字字幕</option><option>突发音效</option></select></label>
          <label>特殊人物关系<select value={relation} onChange={(e) => setRelation(e.target.value)}><option>全部关系</option><option>禁忌旧爱</option><option>伪弱者×权势群体</option><option>隐秘血脉</option></select></label>
          <label>高光前置<select value={highlight} onChange={(e) => setHighlight(e.target.value)}><option>全部方式</option><option>无前置</option><option>中段高光</option><option>尾段高光</option><option>跨集高光</option></select></label>
          <label>钩子与第二段<select value={hookRelation} onChange={(e) => setHookRelation(e.target.value)}><option>全部关系</option><option>因果承接</option><option>情绪承接</option><option>反差承接</option></select></label>
          <label>视听主导<select value={avLead} onChange={(e) => setAvLead(e.target.value)}><option>全部类型</option><option>画面主导</option><option>台词主导</option><option>音效主导</option></select></label>
          <label>是否包含过渡<select value={transition} onChange={(e) => setTransition(e.target.value)}><option>全部过渡</option><option>包含过渡</option><option>无过渡</option></select></label>
          <label>曝光下限（万）<input min="0" type="number" value={minExposure} onChange={(e) => setMinExposure(e.target.value)} /></label>
          <label>跑量天数下限<input min="0" type="number" value={minDays} onChange={(e) => setMinDays(e.target.value)} /></label>
          <label>抓取时间<select value={captureRange} onChange={(e) => setCaptureRange(e.target.value)}><option>近一年</option><option>近 30 天</option><option>31–90 天</option></select></label>
          <label>是否长效跑量<select value={longRunning} onChange={(e) => setLongRunning(e.target.value)}><option>全部</option><option>长效 ≥30 天</option><option>非长效</option></select></label>
          <label>人工复核<select value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value)}><option>全部状态</option><option>已通过</option><option>待复核</option><option>边界待确认</option></select></label>
          <label>状态演示<select value={demoState} onChange={(e) => setDemoState(e.target.value as DemoState)}><option value="ready">正常数据</option><option value="loading">加载中</option><option value="empty">空状态</option><option value="error">加载失败</option></select></label>
        </div>
      </section>}
      {demoState === "loading" && <StatePanel icon="◌" title="正在同步跑量素材" detail="正在加载广告实例、曝光快照与分析状态…" />}
      {demoState === "error" && <StatePanel icon="!" title="素材加载失败" detail="数据源暂时不可用，请检查监测源或稍后重试。" action="重新加载" onAction={() => setDemoState("ready")} />}
      {demoState === "empty" && <StatePanel icon="◇" title="还没有跑量素材" detail="添加监测源或调整筛选条件后，素材会显示在这里。" action="恢复演示数据" onAction={() => setDemoState("ready")} />}
      {demoState === "ready" && (view === "grid" ? <div className={styles.grid}>{filtered.map((item) => <MaterialCard key={item.id} item={item} favorite={favoriteIds.includes(item.id)} onFavorite={() => toggleFavorite(item.id)} onAnalyze={() => openAnalysis(item.id)} />)}</div> : <MaterialTable items={filtered} onAnalyze={openAnalysis} />)}
      {demoState === "ready" && !filtered.length && <StatePanel icon="⌁" title="没有符合条件的素材" detail="尝试放宽曝光、跑量天数或内容筛选。" action="清除高级条件" onAction={() => { setMinExposure("0"); setMinDays("0"); setPlatform("全部平台"); setMarket("全部国家"); setTheme("全部题材"); }} />}
    </>}

    {tab === "prototypes" && <PrototypeView selected={prototypeIndex} setSelected={setPrototypeIndex} onFactory={() => { onOpenFactory?.(materials[0].id); flash("已带入外搭钩子内容工厂"); }} onFavorite={() => flash("钩子原型已收藏")} />}
    {tab === "analysis" && <AnalysisView selected={selected} setSelected={setSelectedId} onFactory={() => { onOpenFactory?.(selected.id); flash("已通过钩子质检，可进入内容工厂"); }} />}
    {tab === "review" && <ReviewView t1={t1} t2={t2} setT1={setT1} setT2={setT2} type={reviewType} setType={setReviewType} status={reviewStatus} onSubmit={() => { setReviewStatus("已复核"); flash("复核结果已提交，分析版本已更新"); }} />}
    {toast && <div className={styles.toast}>✓ {toast}</div>}
  </section>;
}

function MaterialCard({ item, favorite, onFavorite, onAnalyze }: { item: Material; favorite: boolean; onFavorite: () => void; onAnalyze: () => void }) {
  const [instancesOpen, setInstancesOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  return <article className={styles.card}>
    <div className={`${styles.cover} ${styles[item.color]}`}><span className={styles.source}>{item.source} · {item.platform}</span><button className={styles.play} aria-label={playing ? "暂停素材" : "播放素材"} aria-pressed={playing} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button><em>02:03</em><button className={`${styles.favorite} ${favorite ? styles.favorited : ""}`} onClick={onFavorite} aria-label={favorite ? "取消收藏" : "收藏"} aria-pressed={favorite}>{favorite ? "♥" : "♡"}</button>{item.reuse > 1 && <button className={styles.duplicateBubble} onClick={() => setInstancesOpen((value) => !value)} aria-label={`展开 ${item.reuse} 个重复实例`}>{item.reuse}</button>}</div>
    <div className={styles.cardBody}><div className={styles.tags}><span>{item.type}</span><span>{item.language}</span><span>{item.theme}</span></div><h3>{item.title}</h3><p><b>{item.hookType}</b> · {item.hookDuration}s · {item.emotion} · {item.transition}</p>
      <div className={styles.segmentBar} title="钩子 / 过渡 / 正片"><i /><i /><i /></div><div className={styles.segmentLegend}><span>钩子 0:{item.hookDuration}</span><span>{item.transition}</span><span>{item.episode}</span></div>
      <dl><div><dt>曝光</dt><dd>{fmt(item.exposure)}</dd></div><div><dt>跑量</dt><dd>{item.days} 天</dd></div><div><dt>原型复用</dt><dd>{item.reuse} 次 <sup>{item.reuse > 10 ? `+${item.reuse - 1}` : ""}</sup></dd></div></dl>
      <div className={styles.cardFooter}><span>{item.analysis} · {item.captured}</span><button onClick={onAnalyze}>进入分析 →</button></div>
    </div>
    {instancesOpen && <div className={styles.duplicateList}><b>同组全部广告实例</b>{[0,1,2].map((index) => <button key={index} onClick={onAnalyze}><span>{index === 0 ? item.market : index === 1 ? "加拿大" : "澳大利亚"} · {index === 0 ? item.captured : `08-${9-index} ${12+index}:20`}</span><small>{index === 0 ? item.episode : index === 1 ? "EP02 00:14–01:32" : "EP05 00:06–01:18"} · 曝光 {fmt(Math.round(item.exposure / (index + 1)))}</small></button>)}</div>}
  </article>;
}

function MaterialTable({ items, onAnalyze }: { items: Material[]; onAnalyze: (id: string) => void }) {
  const [expandedId, setExpandedId] = useState("");
  return <div className={styles.tableWrap}><div className={`${styles.row} ${styles.rowHead}`}><span>广告素材</span><span>素材类型 / 剧目</span><span>钩子原型</span><span>时长 / 过渡</span><span>曝光 / 跑量</span><span>状态</span></div>{items.map((item) => <div key={item.id}><div className={styles.row} role="button" tabIndex={0} onClick={() => onAnalyze(item.id)}><span><i className={`${styles.thumb} ${styles[item.color]}`}>▶</i><b>{item.title}<small>{item.platform} · {item.language} · {item.captured}</small></b></span><span>{item.type}<small>{item.episode}</small></span><span>{item.prototype}<small><button className={styles.inlineBubble} onClick={(event) => { event.stopPropagation(); setExpandedId(expandedId === item.id ? "" : item.id); }}>{item.reuse} 个实例</button></small></span><span>{item.hookDuration}s<small>{item.transition}</small></span><span><strong>{fmt(item.exposure)}</strong><small>{item.days} 天</small></span><span><em>{item.analysis}</em><small>{item.review}</small></span></div>{expandedId === item.id && <div className={styles.tableInstances}>{["本次抓取", "重复投放 08-10", "重复投放 08-06"].map((label,index) => <span key={label}><b>{label}</b><small>{index ? "不同日期 / 不同正片组合" : `${item.market} · ${item.episode}`} · 曝光 {fmt(Math.round(item.exposure/(index+1)))}</small></span>)}</div>}</div>)}</div>;
}

function PrototypeView({ selected, setSelected, onFactory, onFavorite }: { selected: number; setSelected: (value: number) => void; onFactory: () => void; onFavorite: () => void }) {
  const [playing, setPlaying] = useState(false);
  const item = prototypes[selected];
  const [favoriteNames, setFavoriteNames] = useState<string[]>([]);
  const [allInstances, setAllInstances] = useState(false);
  const [matching, setMatching] = useState(false);
  const favorite = favoriteNames.includes(item.name);
  const togglePrototypeFavorite = () => { setFavoriteNames((current) => favorite ? current.filter((name) => name !== item.name) : [...current, item.name]); onFavorite(); };
  const visibleInstances = Array.from({ length: allInstances ? item.instances : Math.min(3, item.instances) }, (_, index) => ({ ...materials[index % materials.length], instanceKey: `${item.name}-${index}`, captured: index < materials.length ? materials[index].captured : `07-${String(31 - index).padStart(2, "0")} ${String(9 + index % 10).padStart(2, "0")}:20` }));
  return <div className={styles.prototypeLayout}>
    <aside className={styles.prototypeList}><div className={styles.panelTitle}><span><small>PROTOTYPE CLUSTERS</small><h2>钩子原型聚类</h2></span><em>{prototypes.length}</em></div>{prototypes.map((prototype, index) => <button key={prototype.name} className={selected === index ? styles.activeItem : ""} onClick={() => setSelected(index)}><i className={`${styles.prototypeIcon} ${styles[prototype.color]}`}>{index + 1}</i><span><b>{prototype.name}</b><small>{prototype.emotion} · {prototype.instances} 个实例</small></span><em>→</em></button>)}</aside>
    <main className={styles.prototypeDetail}><section className={styles.prototypeHero}><div className={`${styles.prototypeVideo} ${styles[item.color]}`}><span>02 · 典型实例 · 00:18</span><button aria-label={playing ? "暂停典型实例" : "播放典型实例"} aria-pressed={playing} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button><em>{item.universal}</em></div><div><small className={styles.eyebrow}>01 · 原型定义</small><h2>{item.name}</h2><p>{item.summary}</p><div className={styles.prototypeStats}><span><b>{item.instances}</b><small>广告实例</small></span><span><b>{item.dramas}</b><small>使用剧目</small></span><span><b>{item.life}</b><small>生命周期</small></span><span><b>{item.ratio}</b><small>高曝光占比</small></span></div><div className={styles.actions}><button onClick={togglePrototypeFavorite} aria-pressed={favorite}>{favorite ? "♥ 已收藏" : "♡ 收藏原型"}</button><button onClick={() => setMatching((value) => !value)}>匹配我的剧 →</button><button onClick={onFactory}>进入内容工厂 →</button></div></div></section>
      {matching && <section className={styles.matchPanel}><div><span className={styles.label}>11 · 匹配我的剧</span><h3>根据人物关系、题材与可兑现剧情智能匹配</h3></div>{["错嫁后，前夫跪求复合","隐婚总裁的替身新娘","龙王弃妃归来"].map((title,index) => <button key={title} onClick={onFactory}><b>{title}</b><small>匹配度 {92-index*7}% · {index ? "情绪／关系适配" : "关系与承诺均可兑现"}</small><em>带入制作 →</em></button>)}</section>}
      <section className={styles.detailGrid}><article><span className={styles.label}>结构定义</span><h3>稳定场景 → 越界信息 → 群体反应 → 未解旧事</h3><div className={styles.miniTimeline}><i>感官拦截<small>0–2s</small></i><i>品类识别<small>2–5s</small></i><i>情绪击穿<small>5–11s</small></i><i>悬念锚定<small>11–18s</small></i></div></article><article><span className={styles.label}>关系与刺激</span><h3>{item.relation}</h3><p>主情绪：{item.emotion}<br />感官刺激：{item.sensory}</p></article><article><span className={styles.label}>适配判断</span><p><b>适配：</b>{item.fit}</p><p className={styles.risk}><b>不适配：</b>{item.avoid}</p></article><article><span className={styles.label}>跨市场表现</span><h3>{item.languages}</h3><p>高曝光实例集中在美国、英国和巴西；核心关系信息可跨文化理解。</p></article></section>
      <section className={styles.prototypeInsights}>
        <article><span className={styles.label}>03 · 结构时间线</span><div className={styles.prototypeTimeline}><i>0–2s 感官拦截</i><i>2–5s 品类识别</i><i>5–11s 情绪击穿</i><i>11–18s 悬念锚定</i></div></article>
        <article><span className={styles.label}>04 · 情绪与悬念曲线</span><div className={styles.sparkline}>⌁╱╲╱╲╱╲╱⌁</div><p>情绪峰值 7.2s · 悬念持续抬升至 T1</p></article>
        <article><span className={styles.label}>05 · 使用剧目分布</span><p>豪门婚恋 42% · 女性复仇 31% · 身份反转 19% · 其他 8%</p><div className={styles.distribution}><i /><i /><i /><i /></div></article>
        <article><span className={styles.label}>06 · 跨语种与跨市场</span><p>{item.languages} · 美国 38% / 英国 21% / 巴西 18% / 其他 23%</p></article>
        <article><span className={styles.label}>07 · 生命周期趋势</span><h3>{item.life}</h3><p>第 3 周进入高曝光平台，第 9 周仍有跨剧复用。</p></article>
        <article><span className={styles.label}>08 · 适配题材</span><div className={styles.chips}>{item.fit.split("、").map((value) => <span key={value}>✓ {value}</span>)}</div></article>
        <article><span className={styles.label}>09 · 不适配题材</span><p className={styles.risk}>× {item.avoid}：承诺难在正片早期兑现</p></article>
        <article><span className={styles.label}>10 · 收藏状态</span><h3>{favorite ? "已进入我的收藏" : "尚未收藏"}</h3><button onClick={togglePrototypeFavorite}>{favorite ? "取消收藏" : "收藏此原型"}</button></article>
      </section>
      <section className={styles.instanceStrip}><div className={styles.panelTitle}><span><small>ALL INSTANCES</small><h2>同原型广告实例</h2></span><button onClick={() => setAllInstances((value) => !value)}>{allInstances ? "收起实例" : `展开全部 ${item.instances} 条`}</button></div><div>{visibleInstances.map((material, index) => <button key={material.instanceKey}><i className={`${styles.instanceThumb} ${styles[material.color]}`}>▶</i><span><b>{material.title}</b><small>{material.market} · {material.episode} · {fmt(Math.max(120000, Math.round(material.exposure * (1 - index * .025))))} · {material.captured}</small></span></button>)}</div></section>
    </main>
  </div>;
}

function AnalysisView({ selected, setSelected, onFactory }: { selected: Material; setSelected: (id: string) => void; onFactory: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [activeSegment, setActiveSegment] = useState<"hook" | "transition" | "body" | "climax" | "cliff">("hook");
  const [lines, setLines] = useState(() => buildTranscript(selected));
  const [editing, setEditing] = useState<number | null>(null);
  const [suggestionsApplied, setSuggestionsApplied] = useState(false);
  const profile = analysisProfiles[selected.id];
  const t1 = selected.hookDuration;
  const t2 = selected.transition === "无过渡" ? t1 : t1 + 6;
  const metricOffset = materials.findIndex((item) => item.id === selected.id) * 2;
  const segmentCopy = { hook: ["钩子分析", `00:00–00:${String(t1).padStart(2, "0")} · ${profile.t1Reason}`], transition: ["过渡分析", selected.transition === "无过渡" ? "本素材无独立过渡段" : `00:${String(t1).padStart(2, "0")}–00:${String(t2).padStart(2, "0")} · ${profile.bridge}`], body: ["主体剧情", `00:${String(t2).padStart(2, "0")} 起 · ${profile.t2Reason}`], climax: ["高潮", `${selected.episode} · ${selected.emotion}峰值`], cliff: ["卡点", `${profile.promise}前截断`] }[activeSegment];
  const changeSelected = (id: string) => { const next = materials.find((item) => item.id === id) ?? selected; setSelected(id); setLines(buildTranscript(next)); setEditing(null); setActiveSegment("hook"); setSuggestionsApplied(false); };
  return <div className={styles.analysisPage}>
    <div className={styles.instancePicker}><label>分析实例<select value={selected.id} onChange={(e) => changeSelected(e.target.value)}>{materials.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><span>分析置信度 <b>{selected.confidence}%</b></span><span className={selected.review === "已通过" ? styles.success : styles.warning}>{selected.review}</span></div>
    <section className={styles.overview}><div className={`${styles.adPreview} ${styles[selected.color]}`}><span>完整广告 · 02:03</span><button aria-label={playing ? "暂停完整广告" : "播放完整广告"} aria-pressed={playing} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button><em>{selected.platform} / {selected.market}</em></div><div><div className={styles.tags}><span>{selected.type}</span><span>{selected.language}</span><span>{selected.theme}</span></div><h2>{selected.title}</h2><p>{selected.id} · 对应《{profile.drama}》 · {selected.episode}</p><dl><div><dt>曝光</dt><dd>{fmt(selected.exposure)}</dd></div><div><dt>连续跑量</dt><dd>{selected.days} 天</dd></div><div><dt>抓取时间</dt><dd>{selected.captured}</dd></div><div><dt>分析状态</dt><dd>{selected.analysis}</dd></div></dl></div></section>

    <section className={styles.structure}><SectionHead step="01" title="整条素材结构" subtitle="先理解全片；点击任一段切换下方分析" /><div className={styles.structureTrack}><button className={`${styles.hookSegment} ${activeSegment === "hook" ? styles.segmentSelected : ""}`} onClick={() => setActiveSegment("hook")} style={{ flex: t1 }}>钩子<small>00:00–00:{String(t1).padStart(2,"0")} · T1</small></button>{selected.transition !== "无过渡" && <button className={`${styles.transitionSegment} ${activeSegment === "transition" ? styles.segmentSelected : ""}`} onClick={() => setActiveSegment("transition")} style={{ flex: 6 }}>过渡<small>00:{String(t1).padStart(2,"0")}–00:{String(t2).padStart(2,"0")}</small></button>}<button className={`${styles.bodySegment} ${activeSegment === "body" ? styles.segmentSelected : ""}`} onClick={() => setActiveSegment("body")} style={{ flex: 76 }}>正片<small>00:{String(t2).padStart(2,"0")} 起 · T2</small></button><button aria-label="查看高潮" onClick={() => setActiveSegment("climax")} className={styles.climax}>高潮<small>{selected.episode}</small></button><button aria-label="查看卡点" onClick={() => setActiveSegment("cliff")} className={styles.cliff}>卡点<small>结尾</small></button></div><div className={styles.segmentFocus}><b>{segmentCopy[0]}</b><span>{segmentCopy[1]}</span><button onClick={() => setPlaying((value) => !value)}>{playing ? "暂停此段" : "播放此段"}</button></div><div className={styles.boundaries}><span><b>T1</b> {profile.t1Reason}</span><span><b>T2</b> {profile.t2Reason}</span><span><b>连通性 {Math.max(72, 88 - metricOffset)}</b> {profile.promise}</span></div></section>

    <section className={styles.transcript}><SectionHead step="02" title="三色文本轨道" subtitle="ASR、OCR、解说与对应画面已按结构对齐" action="人工调整文本" onAction={() => setEditing(0)} /><div className={styles.transcriptLegend}><span><i className={styles.hookDot} />钩子文本</span><span><i className={styles.transitionDot} />过渡文本</span><span><i className={styles.bodyDot} />正片文本</span></div><div className={styles.transcriptTable}><div className={styles.transcriptHead}><span>时间码 / 说话人</span><span>对白 / 解说（ASR）</span><span>画面字幕（OCR）</span><span>对应画面</span><span>段落</span></div>{lines.map((line,index) => <div className={`${styles.transcriptRow} ${styles[line.tone]}`} key={line.time}><span><b>{line.time}</b><small>{line.speaker}</small></span><span>{editing === index ? <input value={line.asr} onChange={(e) => setLines((current) => current.map((value,i) => i === index ? {...value,asr:e.target.value} : value))} /> : line.asr}</span><span>{editing === index ? <input value={line.ocr} onChange={(e) => setLines((current) => current.map((value,i) => i === index ? {...value,ocr:e.target.value} : value))} /> : line.ocr}</span><span>{line.visual}</span><span>{editing === index ? <select value={line.segment} onChange={(e) => setLines((current) => current.map((value,i) => i === index ? {...value,segment:e.target.value,tone:e.target.value === "钩子" ? "hook" : e.target.value === "过渡" ? "transition" : "body"} : value))}><option>钩子</option><option>过渡</option><option>正片</option></select> : <em>{line.segment}</em>}<button onClick={() => setEditing(editing === index ? null : index)}>{editing === index ? "保存" : "✎"}</button></span></div>)}</div></section>

    <section className={styles.cockpit}><SectionHead step="03" title="钩子驾驶舱" subtitle="停滑、留存与正片承诺的证据化诊断" action="导出分析报告" />
      <div className={styles.hookSummary}><div><span className={styles.label}>钩子事件概括</span><h3>{profile.summary}</h3><p>人物身份＋典型场景＋核心事件＋后续预期</p></div><div className={styles.gate}><span>统一钩子质检门</span><strong>{selected.review === "已通过" ? "可以直接生成" : "建议优化后生成"}</strong><small>{selected.hookType}清晰；{selected.confidence < 85 ? "边界仍需复核" : "信息负荷可控"}</small></div></div>
      <div className={styles.metrics}>{metricData.map(([name, score], index) => { const value = Math.max(65, score - metricOffset + (index % 2)); return <article key={name}><div><span>{name}</span><b>{value}</b></div><i><em style={{ width: `${value}%` }} /></i><small>证据 · 00:{String(index * 2).padStart(2,"0")} {selected.hookType} / {selected.emotion}</small></article>; })}</div>
      <div className={styles.dashboardGrid}>
        <article className={styles.firstFrame}><span className={styles.label}>第一帧 · 00:00</span><div className={styles.frame}><div className={`${styles.frameImage} ${styles[selected.color]}`}><span>{profile.subject}</span><b>字幕安全区 ✓</b></div><ul><li><b>{selected.avLead}</b>，{selected.hookType}在第一镜建立</li><li>{selected.theme}色彩与主体形成高对比焦点</li><li>静音可理解度 <strong>{Math.max(68, 82-metricOffset)}%</strong>，{selected.confidence < 85 ? "建议补充关系词" : "主体信息明确"}</li></ul></div></article>
        <article><span className={styles.label}>第一句 · 00:02.1</span><blockquote>“{profile.firstLine}”</blockquote><p>{profile.firstLine.length} 个字 · 关系信息明确 · 情绪烈度 {Math.max(72,88-metricOffset)}<br />第一句与下一反应镜头共同完成{selected.hookType}。</p><strong className={styles.good}>钩子词命中：{selected.hookType} / {selected.emotion}</strong></article>
        <article><span className={styles.label}>强情绪 / 戏剧 / 人物关系</span><h3>{selected.emotion} {Math.max(76,92-metricOffset)} · 戏剧 {Math.max(72,90-metricOffset)}</h3><p>{selected.theme}事件持续递进，正片提供明确情绪出口。</p><div className={styles.relation}>{profile.relation}</div></article>
        <article><span className={styles.label}>感官刺激</span><div className={styles.chips}><span>{selected.sensory} 00:00</span><span>{selected.avLead} 00:02</span><span>{selected.hookType} 00:05</span></div><p>刺激均关联证据帧；当前内容与{selected.theme}题材一致。</p></article>
        <article><span className={styles.label}>音画匹配</span><Score score="87" /><ul><li>杯碎音效与切镜误差 1 帧</li><li>“Adrian”重音对齐未婚夫反应镜头</li><li>BGM 在冲突前 0.4s 起势，形成预期</li><li className={styles.risk}>06.2s 人声被 BGM 短暂遮盖</li></ul></article>
        <article><span className={styles.label}>画面运镜</span><h3>12 镜 · 平均 1.5s / 镜</h3><p>特写 42% · 近景 33% · 中景 25%<br />推镜 4 · 正反打 5 · 固定 2 · 甩镜 1</p><strong className={styles.good}>运镜服务关系地位变化</strong></article>
        <article><span className={styles.label}>节奏与信息密度</span><h3>前 8 秒：{(1.75-metricOffset*.04).toFixed(2)} 个信息点 / 秒</h3><div className={styles.eventLine}>{["停滑 0.0s","关系 2.1s","冲突 3.4s",`峰值 ${Math.min(9,t1/2).toFixed(1)}s`,`T1 ${t1}s`].map((item) => <i key={item}>{item}</i>)}</div><p className={styles.risk}>{selected.confidence < 85 ? "边界与人物匹配仍需人工确认。" : "信息密度高且理解路径清晰。"}</p></article>
        <article className={styles.curveCard}><span className={styles.label}>情绪 / 冲突 / 信息 / 悬念曲线</span><div className={styles.curveChart}><svg viewBox="0 0 600 150" role="img" aria-label="四项曲线"><path d="M0 125 C80 92 100 104 160 62 S270 45 330 27 S450 40 600 18" /><path d="M0 138 C90 130 120 90 200 83 S310 20 390 35 S500 44 600 31" /><path d="M0 110 C70 48 110 35 180 70 S260 38 350 84 S470 65 600 59" /><path d="M0 140 C120 133 160 106 230 96 S380 58 440 37 S530 24 600 12" /></svg><span className={styles.riskZone}>06–08s<br />滑走风险</span></div><div className={styles.curveLegend}><span>— 情绪唤醒</span><span>— 冲突强度</span><span>— 信息密度</span><span>— 悬念强度</span></div></article>
        <article className={styles.connectivity}><span className={styles.label}>钩子—正片连通性</span><div><Score score={String(Math.max(72,88-metricOffset))} /><ul><li><b>叙事逻辑</b>：{profile.promise}</li><li><b>情绪动线</b>：{selected.emotion}向正片核心矛盾自然延续</li><li><b>视听锚点</b>：{profile.bridge}</li><li><b>承诺兑现</b>：{profile.t2Reason}</li><li className={styles.risk}><b>留存风险</b>：{selected.confidence < 85 ? "人物或边界置信度偏低" : "当前未发现严重错位"}</li></ul></div></article>
      </div>
      <div className={`${styles.recommendations} ${suggestionsApplied ? styles.applied : ""}`}><div><span className={styles.label}>可执行诊断建议</span><ol><li>强化“{selected.hookType}”在前 3 秒的视觉证据。</li><li>以“{profile.bridge}”作为结构锚点。</li><li>{selected.confidence < 85 ? "提交边界与人物复核后再批量生成。" : `保留“${profile.firstLine}”的重音与反应镜头。`}</li></ol></div><button onClick={() => setSuggestionsApplied(true)}>{suggestionsApplied ? "✓ 已应用到草稿" : "一键应用 3 项建议"}</button></div>
    </section>

    <section className={styles.modeAnalysis}><SectionHead step="04" title="模式专项分析" subtitle={selected.type} /><div className={styles.modeCards}><article><span>人物一致性</span><b>72</b><p>钩子女主与正片女主演员造型接近，脸部匹配仍需复核。</p></article><article><span>矛盾与情绪承接</span><b>91</b><p>关系背叛 → 被迫交易，都是信任破裂，情绪出口明确。</p></article><article><span>视听锚点</span><b>88</b><p>戒指 → 印章的形状匹配清楚，环境音衔接自然。</p></article><article><span>承诺兑现 / 货不对板</span><b>84</b><p>主承诺可兑现；外搭婚礼场面在正片中较晚出现，存在轻微错位。</p></article></div><div className={styles.modeFooter}><span><b>结论：</b>可生成单条测试素材，不建议直接批量。先修正人声遮盖和人物一致性风险。</span><button onClick={onFactory}>进入内容工厂 →</button></div></section>
  </div>;
}

function ReviewView({ t1, t2, setT1, setT2, type, setType, onSubmit }: { t1: number; t2: number; setT1: (value: number) => void; setT2: (value: number) => void; type: MaterialType; setType: (value: MaterialType) => void; status: string; onSubmit: () => void }) {
  const queue = [materials[2], materials[4], materials[0]];
  const [activeReview, setActiveReview] = useState(0);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [prototypeAction, setPrototypeAction] = useState("审判现场血脉反转");
  const [queueTab, setQueueTab] = useState<"pending" | "saved" | "completed">("pending");
  const [taskStates, setTaskStates] = useState<Array<"pending" | "saved" | "completed">>(["pending", "saved", "completed"]);
  const [playing, setPlaying] = useState(false);
  const active = queue[activeReview];
  const reasons = ["T1 / T2 边界冲突", "正片匹配置信度低", "钩子原型聚类冲突"];
  const taskDetails = [
    { t1: 23, t2: 29, type: "正片剧集解说" as MaterialType, prototype: "审判现场血脉反转", transition: "解说承接", source: "EP03 00:41", relation: "被审判的禁忌新娘 × 狼族首领｜隐秘血脉 / 族群禁忌", note: "T1 以血脉奇观完成为准；狼王宣布暂停处决构成 T2。", event: "狼王宣布暂停处决" },
    { t1: 21, t2: 27, type: "外搭钩子＋本剧正片" as MaterialType, prototype: "萌宝识父触发旧秘密", transition: "匹配剪辑", source: "EP02 00:18", relation: "萌宝 × 隐婚母亲 × 总裁父亲｜亲子秘密 / 身份错位", note: "T1 以亲子疑问完成为准；总裁追问母亲身份构成 T2。", event: "总裁追问孩子母亲身份" },
    { t1: 18, t2: 24, type: "外搭钩子＋本剧正片" as MaterialType, prototype: "公开场合关系崩塌", transition: "声音桥接", source: "EP01 00:42", relation: "新娘 × 隐秘旧爱 × 未婚夫｜公开背叛 / 旧事悬念", note: "T1 以旧爱进入画面为准；合同交易构成 T2。", event: "女主面对旧日合同" },
  ];
  const detail = taskDetails[activeReview];
  const visibleQueue = queue.map((item, index) => ({ item, index })).filter(({ index }) => taskStates[index] === queueTab);
  const displayStatus = taskStates[activeReview] === "completed" ? "已复核" : taskStates[activeReview] === "saved" ? "已暂存" : "待复核";
  const chooseTask = (index: number) => { const next = taskDetails[index]; setActiveReview(index); setT1(next.t1); setT2(next.t2); setType(next.type); setPrototypeAction(next.prototype); };
  const chooseTab = (next: "pending" | "saved" | "completed") => { setQueueTab(next); const index = taskStates.findIndex((state) => state === next); if (index >= 0) chooseTask(index); };
  return <div className={styles.reviewLayout}><aside className={styles.reviewQueue}><div className={styles.panelTitle}><span><small>REVIEW QUEUE</small><h2>复核任务</h2></span><em>{queue.length}</em></div><div className={styles.queueFilters}>{([['pending','待处理'],['saved','我暂存的'],['completed','已完成']] as const).map(([key,label]) => <button key={key} className={queueTab === key ? styles.activeQueueFilter : ""} onClick={() => chooseTab(key)}>{label} {taskStates.filter((state) => state === key).length}</button>)}</div>{visibleQueue.map(({item,index}) => <button key={item.id} className={index === activeReview ? styles.activeItem : ""} onClick={() => chooseTask(index)}><i className={`${styles.reviewThumb} ${styles[item.color]}`}>▶</i><span><b>{item.title}</b><small>{reasons[index]}</small></span><em>{item.confidence}%</em></button>)}</aside>
    <main key={active.id} className={styles.reviewPanel}><div className={styles.reviewHeader}><div><span className={styles.eyebrow}>{active.id} · {reasons[activeReview]}</span><h2>{active.title}</h2></div><span className={displayStatus === "已复核" ? styles.success : styles.warning}>{displayStatus}</span></div>
      <section className={styles.boundaryEditor}><div className={`${styles.reviewVideo} ${styles[active.color]}`}><button aria-label={playing ? "暂停复核素材" : "播放复核素材"} aria-pressed={playing} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button><span>当前帧 00:{t1.toString().padStart(2,"0")}</span></div><div className={styles.rangeEditor}><span className={styles.label}>拖动调整结构边界</span><div className={styles.reviewTrack}><i style={{ width: `${t1 / 60 * 100}%` }} /><i style={{ left: `${t1 / 60 * 100}%`, width: `${(t2 - t1) / 60 * 100}%` }} /><i style={{ left: `${t2 / 60 * 100}%` }} /></div><label>T1 · 钩子结束 <b>00:{t1.toString().padStart(2,"0")}</b><input type="range" min="8" max="28" value={t1} onChange={(e) => setT1(Math.min(Number(e.target.value), t2 - 1))} /></label><label>T2 · 正片事件开始 <b>00:{t2.toString().padStart(2,"0")}</b><input type="range" min="12" max="40" value={t2} onChange={(e) => setT2(Math.max(Number(e.target.value), t1 + 1))} /></label><p>T1 与 T2 之间 {t2 - t1}s 已标记为过渡；正片首个可理解事件为“{detail.event}”。</p></div></section>
      <section className={styles.reviewForm}><label>素材类型<select value={type} onChange={(e) => setType(e.target.value as MaterialType)}><option>正片剧集拼接</option><option>正片剧集解说</option><option>外搭钩子＋本剧正片</option></select></label><label>钩子原型／拆分<select value={prototypeAction} onChange={(e) => setPrototypeAction(e.target.value)}><option>{detail.prototype}</option><option>修改为：极端生产血脉奇观</option><option>新建独立原型</option><option>拆分当前原型</option></select></label><label>过渡类型<select defaultValue={detail.transition}><option>解说承接</option><option>声音桥接</option><option>匹配剪辑</option><option>字幕承接</option><option>无过渡</option></select></label><label>正片来源集数<select defaultValue={detail.source}><option>{detail.source}</option><option>EP04 00:06</option><option>EP05 01:12</option><option>无法确认</option></select></label><label className={styles.fullField}>人物与关系<input defaultValue={detail.relation} /></label><label className={styles.fullField}>三色文本段落修正<select defaultValue={`${String(t1).padStart(2,"0")}–${String(t2).padStart(2,"0")} 调整为过渡`}><option>{String(t1).padStart(2,"0")}–{String(t2).padStart(2,"0")} 调整为过渡</option><option>从 T1 起调整为正片</option><option>保持算法结果</option></select></label><label className={styles.fullField}>复核说明<textarea defaultValue={detail.note} /></label><label className={styles.fullField}>确认依据<div className={styles.checkGrid}><span><input type="checkbox" defaultChecked /> 人脸匹配</span><span><input type="checkbox" defaultChecked /> 镜头指纹</span><span><input type="checkbox" defaultChecked /> 对白匹配</span><span><input type="checkbox" /> 音频指纹</span></div></label></section>
      {prototypeAction === "拆分当前原型" && <div className={styles.splitNotice}><b>将创建新原型分支</b><span>当前实例会从“审判现场血脉反转”移至新分支，历史实例不会被删除。</span><input placeholder="输入新原型名称" defaultValue="审判现场继承人感知" /></div>}
      <div className={styles.conflicts}><span>⚠ 音画分析冲突</span><p>ASR 判断 00:20 为正片对话，但人脸与镜头来源匹配显示本剧从 00:24 开始。已采用“可理解事件”规则，以 00:24 作为 T2。</p><button onClick={() => setEvidenceOpen(true)}>查看证据帧</button></div>
      <footer className={styles.reviewActions}><span>最近自动保存：刚刚</span><button onClick={() => setTaskStates((current) => current.map((value,index) => index === activeReview ? "saved" : value))}>暂存复核</button><button className={styles.primary} onClick={() => { setTaskStates((current) => current.map((value,index) => index === activeReview ? "completed" : value)); onSubmit(); }}>提交复核结果</button></footer>
      {evidenceOpen && <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="证据帧"><div className={styles.evidenceModal}><header><div><span className={styles.eyebrow}>EVIDENCE FRAMES</span><h3>T1 / T2 边界证据</h3></div><button onClick={() => setEvidenceOpen(false)}>×</button></header><div className={styles.evidenceGrid}>{["00:18 血脉奇观完成","00:20 解说仍在继续","00:24 狼王宣布暂停处决"].map((label,index) => <article key={label}><div className={`${styles.evidenceFrame} ${index === 1 ? styles.blue : styles.cyan}`}>帧 {index+1}</div><b>{label}</b><small>{index === 2 ? "人脸 96% · 镜头指纹 93% · 首个可理解事件" : "ASR / OCR / 场景变化证据"}</small></article>)}</div><footer><button onClick={() => setEvidenceOpen(false)}>关闭</button><button className={styles.primary} onClick={() => { setT2(24); setEvidenceOpen(false); }}>采用 00:24 为 T2</button></footer></div></div>}
    </main>
  </div>;
}

function SectionHead({ step, title, subtitle, action, onAction }: { step: string; title: string; subtitle: string; action?: string; onAction?: () => void }) {
  return <div className={styles.sectionHead}><span>{step}</span><div><h2>{title}</h2><p>{subtitle}</p></div>{action && <button onClick={onAction}>{action}</button>}</div>;
}

function StatePanel({ icon, title, detail, action, onAction }: { icon: string; title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div className={styles.statePanel}><i>{icon}</i><h3>{title}</h3><p>{detail}</p>{action && <button onClick={onAction}>{action}</button>}</div>;
}

function Score({ score }: { score: string }) { return <div className={styles.score}><strong>{score}</strong><small>/ 100</small></div>; }

export default InspirationWorkspace;
