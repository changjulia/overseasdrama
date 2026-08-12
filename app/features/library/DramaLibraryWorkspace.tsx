"use client";

import { useMemo, useState, type CSSProperties } from "react";
import styles from "./library.module.css";

type ParseState = "解析完成" | "解析中" | "待解析";
type DetailTab = "overview" | "characters" | "story" | "highlights" | "ranges";
type ParseTier = { label: string; short: string; progress: number; scope: string };
type Drama = {
  id: number;
  title: string;
  cn: string;
  genre: string;
  language: string;
  episodes: number;
  freeEpisodes: number;
  state: ParseState;
  color: string;
  people: number;
  ranges: number;
  highlights: number;
  drafts: number;
  factoryUses: number;
  parse: ParseTier[];
};

const dramas: Drama[] = [
  { id: 1, title: "Goodbye, My Billionaire Husband", cn: "再见，我的亿万富翁丈夫", genre: "都市情感", language: "英语", episodes: 82, freeEpisodes: 15, state: "解析完成", color: "#2563eb", people: 12, ranges: 8, highlights: 17, drafts: 6, factoryUses: 24, parse: [{label:"粗解析",short:"粗",progress:100,scope:"前 15 集"},{label:"重点集细解析",short:"细",progress:100,scope:"前 5 集 + 重点集"},{label:"高光区间精解析",short:"精",progress:76,scope:"13 个候选区间"}] },
  { id: 2, title: "The Alpha's Forbidden Bride", cn: "狼王的禁忌新娘", genre: "狼人奇幻", language: "英语 / 德语", episodes: 76, freeEpisodes: 18, state: "解析中", color: "#0f766e", people: 16, ranges: 5, highlights: 12, drafts: 3, factoryUses: 13, parse: [{label:"粗解析",short:"粗",progress:100,scope:"前 18 集"},{label:"重点集细解析",short:"细",progress:72,scope:"前 5 集 + 4 个重点集"},{label:"高光区间精解析",short:"精",progress:38,scope:"8 个候选区间"}] },
  { id: 3, title: "Revenge Wears Red", cn: "复仇穿红裙", genre: "女性复仇", language: "葡萄牙语", episodes: 68, freeEpisodes: 12, state: "解析中", color: "#dc2626", people: 9, ranges: 6, highlights: 9, drafts: 4, factoryUses: 18, parse: [{label:"粗解析",short:"粗",progress:100,scope:"前 12 集"},{label:"重点集细解析",short:"细",progress:46,scope:"前 5 集"},{label:"高光区间精解析",short:"精",progress:22,scope:"5 个候选区间"}] },
  { id: 4, title: "Contracted to the CEO", cn: "契约总裁", genre: "豪门甜宠", language: "英语", episodes: 91, freeEpisodes: 15, state: "待解析", color: "#7c3aed", people: 7, ranges: 0, highlights: 0, drafts: 0, factoryUses: 0, parse: [{label:"粗解析",short:"粗",progress:18,scope:"正在处理第 3 集"},{label:"重点集细解析",short:"细",progress:0,scope:"待粗解析定位"},{label:"高光区间精解析",short:"精",progress:0,scope:"待候选区间"}] },
];

const tabs: { id: DetailTab; label: string; count?: number }[] = [
  { id: "overview", label: "剧集概览" }, { id: "characters", label: "人物关系", count: 12 },
  { id: "story", label: "剧情理解" }, { id: "highlights", label: "高光候选", count: 17 },
  { id: "ranges", label: "可投放区间", count: 8 },
];

const highlights = [
  { id:1, category:"中段高光", episode:"第 03 集", time:"04:12–04:34", title:"宴会当众揭穿假千金身份", emotion:"屈辱 → 震惊 → 爽感", event:"身份反转", retention:94, spoiler:"低", setup:"充分", cut:"女主亮出股权书后 1.2s", color:"#2563eb" },
  { id:2, category:"强情绪片段", episode:"第 05 集", time:"06:45–07:18", title:"母亲认出失散多年的女儿", emotion:"压抑 → 崩溃 → 释然", event:"亲情重逢", retention:91, spoiler:"中", setup:"充分", cut:"母女相拥前切断", color:"#0891b2" },
  { id:3, category:"特殊人物关系片段", episode:"第 08 集", time:"02:06–02:29", title:"前夫第一次站在女主一边", emotion:"敌意 → 犹疑 → 暧昧", event:"关系逆转", retention:88, spoiler:"低", setup:"一般", cut:"男主说出“她是我的人”", color:"#7c3aed" },
  { id:4, category:"跨集远期爽点", episode:"第 14–15 集", time:"07:31–00:42", title:"女主带着收购协议重返董事会", emotion:"危机 → 掌控 → 爆发", event:"复仇兑现", retention:96, spoiler:"高", setup:"充分", cut:"全员起立后转黑", color:"#dc2626" },
];

const ranges = [
  { id:1, episodes:"第 01–03 集", title:"婚姻破裂与隐藏身份首次揭晓", summary:"从离婚羞辱进入宴会冲突，以女主股东身份曝光为第一阶段爽点。", people:"Elena、Adrian、Sophia", continuity:96, editability:92, modes:["正片剧集拼接","正片剧集解说"], curve:"低谷 → 对抗 → 反转", paywall:"第 3 集 07:42" },
  { id:2, episodes:"第 04–05 集", title:"身世线开启与母女相认", summary:"用旧项链伏笔推进身世调查，情绪浓度高，结尾留出 DNA 结果悬念。", people:"Elena、Margaret", continuity:91, editability:86, modes:["正片剧集解说","高光前置"], curve:"疑惑 → 悲恸 → 悬念", paywall:"第 5 集 07:26" },
  { id:3, episodes:"第 07–09 集", title:"前夫倒戈与董事会危机", summary:"关系立场反复变化，外部钩子可直接承接第 7 集宴会入口。", people:"Elena、Adrian、Victor", continuity:89, editability:94, modes:["外搭钩子+本剧正片","正片剧集拼接"], curve:"敌对 → 暧昧 → 危机", paywall:"第 9 集 07:51" },
];

function Progress({ tier, color }: { tier: ParseTier; color: string }) {
  return <div className={styles.progressRow}><span className={styles.tierDot} style={{"--tier-color":color} as CSSProperties}>{tier.short}</span><div><b>{tier.label}</b><small>{tier.scope}</small></div><div className={styles.progressTrack}><i style={{width:`${tier.progress}%`,background:color}} /></div><strong>{tier.progress}%</strong></div>;
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return <div className={styles.metric}><small>{label}</small><b>{value}</b>{hint && <span>{hint}</span>}</div>;
}

export type DramaLibraryWorkspaceProps = {
  onEnterFactory?: (payload: { dramaId: number; mode: string; sourceId?: number }) => void;
  onImportDrama?: () => void;
};

export function DramaLibraryWorkspace({ onEnterFactory, onImportDrama }: DramaLibraryWorkspaceProps) {
  const [selected, setSelected] = useState<Drama | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("全部题材");
  const [language, setLanguage] = useState("全部语种");
  const [parseState, setParseState] = useState("全部状态");
  const [highlightType, setHighlightType] = useState("全部类型");
  const [toast, setToast] = useState("");
  const [activeEpisode, setActiveEpisode] = useState(3);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2300); };
  const filtered = useMemo(() => dramas.filter((d) => {
    const term = query.trim().toLowerCase();
    return (!term || `${d.title}${d.cn}${d.genre}${d.language}`.toLowerCase().includes(term)) &&
      (genre === "全部题材" || d.genre === genre) &&
      (language === "全部语种" || d.language.includes(language)) &&
      (parseState === "全部状态" || d.state === parseState);
  }), [query, genre, language, parseState]);
  const visibleHighlights = highlightType === "全部类型" ? highlights : highlights.filter(h => h.category === highlightType);

  const enterFactory = (mode: string, sourceId?: number) => {
    if (selected) onEnterFactory?.({ dramaId: selected.id, mode, sourceId });
    notify(`已将「${selected?.cn ?? "短剧"}」带入${mode}`);
  };

  if (!selected) return <section className={styles.workspace}>
    <header className={styles.pageHeader}><div><span className={styles.eyebrow}>DRAMA INTELLIGENCE LIBRARY</span><h1>剧库</h1><p>从剧集理解到可生产资产，用三级解析控制成本并持续沉淀高光与可投放区间。</p></div><button className={styles.primary} onClick={() => onImportDrama?.()}>＋ 导入短剧</button></header>
    <div className={styles.statStrip}><Metric label="已入库短剧" value="36" hint="2,842 集"/><Metric label="解析中" value="7" hint="3 个任务今日完成"/><Metric label="高光候选" value="486" hint="精解析 213 段"/><Metric label="可投放区间" value="128" hint="本周新增 18 个"/></div>
    <div className={styles.filters}>
      <label className={styles.search}>⌕<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索剧名、题材或语种"/></label>
      <select value={genre} onChange={e=>setGenre(e.target.value)}><option>全部题材</option>{[...new Set(dramas.map(d=>d.genre))].map(x=><option key={x}>{x}</option>)}</select>
      <select value={language} onChange={e=>setLanguage(e.target.value)}><option>全部语种</option><option>英语</option><option>德语</option><option>葡萄牙语</option></select>
      <select value={parseState} onChange={e=>setParseState(e.target.value)}><option>全部状态</option><option>解析完成</option><option>解析中</option><option>待解析</option></select>
      <button onClick={()=>{setQuery("");setGenre("全部题材");setLanguage("全部语种");setParseState("全部状态")}}>重置</button><span>{filtered.length} 部短剧</span>
    </div>
    <div className={styles.cardGrid}>{filtered.map(d=><article className={styles.dramaCard} key={d.id} onClick={()=>{setSelected(d);setTab("overview")}}>
      <div className={styles.cover} style={{"--accent":d.color} as CSSProperties}><span>LUMINA ORIGINAL</span><b>{d.title.split(" ").slice(0,3).join(" ")}</b><small>{d.genre} · {d.episodes} EPISODES</small><i>→</i></div>
      <div className={styles.cardBody}><div className={styles.cardTitle}><div><h2>{d.title}</h2><p>{d.cn} · {d.language}</p></div><span data-state={d.state}>{d.state}</span></div>
      <div className={styles.parseStack}>{d.parse.map(t=><Progress key={t.label} tier={t} color={d.color}/>)}</div>
      <div className={styles.assetCounts}><span><b>{d.people}</b> 人物</span><span><b>{d.ranges}</b> 可投区间</span><span><b>{d.highlights}</b> 高光</span><span><b>{d.drafts}</b> 草稿</span></div></div>
    </article>)}</div>
    {toast && <div className={styles.toast}>✓ {toast}</div>}
  </section>;

  return <section className={styles.workspace}>
    <button className={styles.back} onClick={()=>setSelected(null)}>← 返回剧库</button>
    <div className={styles.detailHero}><div className={styles.detailCover} style={{"--accent":selected.color} as CSSProperties}><small>LUMINA ORIGINAL</small><strong>{selected.title.split(" ").slice(0,3).join(" ")}</strong><span>{selected.episodes} EPISODES</span></div><div className={styles.heroCopy}><span className={styles.eyebrow}>DRAMA PROFILE · ID {String(selected.id).padStart(4,"0")}</span><h1>{selected.title}</h1><h2>{selected.cn}</h2><p>她以为离开是故事的终点，却不知道隐藏身份与家族权力斗争才刚刚开始。三级解析将原始剧集转化为可检索、可判断、可生产的剧情资产。</p><div className={styles.heroMeta}><span>{selected.genre}</span><span>{selected.language}</span><span>{selected.episodes} 集</span><span>免费 {selected.freeEpisodes} 集</span></div></div><div className={styles.heroActions}><button onClick={()=>notify("解析任务配置已打开")}>解析配置</button><button className={styles.primary} onClick={()=>enterFactory("内容工厂")}>进入内容工厂 →</button></div></div>
    <nav className={styles.tabs}>{tabs.map(t=><button key={t.id} className={tab===t.id?styles.active:""} onClick={()=>setTab(t.id)}>{t.label}{t.count !== undefined && <em>{t.count}</em>}</button>)}</nav>
    {tab === "overview" && <Overview drama={selected} notify={notify}/>} 
    {tab === "characters" && <Characters />}
    {tab === "story" && <Story active={activeEpisode} setActive={setActiveEpisode}/>} 
    {tab === "highlights" && <Highlights items={visibleHighlights} filter={highlightType} setFilter={setHighlightType} enterFactory={enterFactory}/>} 
    {tab === "ranges" && <Ranges enterFactory={enterFactory}/>} 
    {toast && <div className={styles.toast}>✓ {toast}</div>}
  </section>;
}

function Overview({drama,notify}:{drama:Drama;notify:(s:string)=>void}) {
  return <div className={styles.detailGrid}><main><section className={styles.panel}><div className={styles.panelHead}><div><span className={styles.eyebrow}>THREE-TIER PARSING</span><h2>三级解析进度</h2></div><button onClick={()=>notify("已刷新解析状态")}>刷新状态 ↻</button></div><div className={styles.tierCards}>{drama.parse.map((t,i)=><article key={t.label}><span>0{i+1}</span><h3>{t.label}</h3><p>{i===0?"低频抽帧、ASR、OCR 与文本摘要，支撑全局概览。":i===1?"密集抽帧与完整对白理解，优先处理前 5 集和重点集。":"仅对候选高光做帧级、镜头级、音画级精析。"}</p><strong>{t.progress}%</strong><i><em style={{width:`${t.progress}%`,background:drama.color}}/></i><small>{t.scope}</small></article>)}</div></section><section className={styles.panel}><div className={styles.panelHead}><div><h2>资产概览</h2><p>解析结果已连接广告素材与生产链路</p></div></div><div className={styles.overviewMetrics}><Metric label="已抓取正片" value="15 集" hint="1080p · 字幕完整"/><Metric label="已生成素材" value="48 条" hint="近 7 日 +12"/><Metric label="关联广告实例" value="31 条" hint="跨 3 个市场"/><Metric label="关联钩子原型" value="9 个" hint="身份反转最常用"/></div></section></main><aside><section className={styles.panel}><h2>最近生产记录</h2><div className={styles.activity}>{["身份反转高光前置 V12","01–03 集连贯剧情拼接","董事会剧情解说 V04"].map((x,i)=><div key={x}><i>{i===0?"生成":"草稿"}</i><span><b>{x}</b><small>{i===0?"12 分钟前":"昨天 18:42"}</small></span></div>)}</div></section><section className={styles.costNote}><span>解析成本策略</span><b>先发现，再精析</b><p>粗解析覆盖免费集；细解析只看重点集；精解析聚焦候选区间，避免整剧逐帧处理。</p></section></aside></div>;
}

function Characters() {
  const people=[{n:"Elena Moore",r:"女主 · 隐藏继承人",tags:"白色西装 / 酒店 / 股权书",c:"EM",rel:"Adrian 前妻 · Margaret 失散女儿"},{n:"Adrian Blake",r:"男主 · 财团继承人",tags:"深色西装 / 董事会 / 婚戒",c:"AB",rel:"Elena 前夫 · Victor 商业对手"},{n:"Margaret Moore",r:"关键角色 · 集团董事长",tags:"红宝石项链 / 庄园 / 旧照片",c:"MM",rel:"Elena 生母 · Sophia 养母"},{n:"Sophia Lane",r:"反派 · 假千金",tags:"红裙 / 宴会厅 / 伪造文件",c:"SL",rel:"Elena 身份竞争 · Adrian 联姻对象"}];
  return <div className={styles.peopleLayout}><section className={styles.panel}><div className={styles.panelHead}><div><h2>核心人物</h2><p>人脸、服装、场景与关键道具联合识别</p></div><span className={styles.confidence}>人脸聚合置信度 94%</span></div><div className={styles.peopleGrid}>{people.map((p,i)=><article key={p.n}><div className={styles.avatar} data-tone={i}>{p.c}<i>✓</i></div><h3>{p.n}</h3><b>{p.r}</b><p>{p.tags}</p><small>{p.rel}</small></article>)}</div></section><section className={styles.panel}><div className={styles.panelHead}><div><h2>关系变化</h2><p>随剧情推进追踪立场与身份变化</p></div></div><div className={styles.relationships}><div><b>Elena</b><span>婚姻破裂</span><b>Adrian</b><em>第 1 集 · 敌对</em></div><div><b>Elena</b><span>身份线索</span><b>Margaret</b><em>第 5 集 · 亲密</em></div><div><b>Adrian</b><span>利益冲突</span><b>Victor</b><em>第 8 集 · 对抗</em></div></div><div className={styles.specialTags}><span>先婚后爱</span><span>失散母女</span><span>真假千金</span><span>前任倒戈</span></div></section></div>;
}

function Story({active,setActive}:{active:number;setActive:(n:number)=>void}) {
  return <div className={styles.storyLayout}><aside className={styles.episodeRail}><div><h2>剧集</h2><span>已细析 9 集</span></div>{Array.from({length:15},(_,i)=>i+1).map(n=><button key={n} className={active===n?styles.active:""} onClick={()=>setActive(n)}><i>{String(n).padStart(2,"0")}</i><span><b>第 {n} 集</b><small>{n<=5?"重点集细解析":n<=9?"用户指定重点集":"仅粗解析"}</small></span><em>{n<=9?"✓":"○"}</em></button>)}</aside><main className={styles.storyMain}><section className={styles.storyTitle}><div><span className={styles.eyebrow}>EPISODE {String(active).padStart(2,"0")}</span><h1>{active===3?"宴会上的第二重身份":"隐藏身份线继续推进"}</h1><p>Elena 被当众驱逐时，律师带着股权证明出现。Adrian 第一次意识到这场离婚可能是一个巨大错误。</p></div><span>重点集细解析</span></section><div className={styles.storyCards}><article><small>核心事件</small><h3>股权书进入宴会，女主身份第一次获得公开证明</h3><p>事件完成“压制—证据—反转”的闭环，可独立剪成一段连贯投放剧情。</p></article><article><small>人物关系变化</small><h3>Elena × Adrian：敌对 → 动摇</h3><p>男主开始保护女主，但动机仍不明确，为后续复合线埋下伏笔。</p></article><article><small>情绪与爽点</small><div className={styles.emotionLine}><i/><i/><i/><i/><i/></div><p>屈辱 82 · 紧张 76 · 爽感 94</p></article><article><small>伏笔与付费卡点</small><h3>律师未公布的第二份遗嘱</h3><p>建议在律师打开文件、念出女主名字前卡断。</p></article></div><section className={styles.compress}><div><span>可压缩铺垫</span><b>01:14–02:06</b></div><p>宴会寒暄与配角重复嘲讽，信息增量较低。建议压缩至 12 秒，保留女主观察出口与手握旧项链的镜头。</p><button>标记为剪辑建议</button></section></main></div>;
}

function Highlights({items,filter,setFilter,enterFactory}:{items:typeof highlights;filter:string;setFilter:(v:string)=>void;enterFactory:(m:string,id?:number)=>void}) {
  const categories=["全部类型",...new Set(highlights.map(h=>h.category))];
  return <><div className={styles.subToolbar}><div><h2>高光候选</h2><p>候选由粗解析／重点集细解析发现，经区间精解析验证留客能力与卡断点。</p></div><select value={filter} onChange={e=>setFilter(e.target.value)}>{categories.map(x=><option key={x}>{x}</option>)}</select></div><div className={styles.highlightGrid}>{items.map(h=><article key={h.id}><div className={styles.highlightPreview} style={{"--accent":h.color} as CSSProperties}><span>{h.episode} · {h.time}</span><button>▶</button><em>{h.category}</em></div><div className={styles.highlightBody}><span className={styles.eyebrow}>{h.event}</span><h2>{h.title}</h2><p>{h.emotion}</p><div className={styles.scoreRow}><span><small>留客能力</small><b>{h.retention}</b></span><span><small>剧透风险</small><b>{h.spoiler}</b></span><span><small>伏笔充分度</small><b>{h.setup}</b></span></div><div className={styles.cutPoint}><small>推荐卡断点</small><b>{h.cut}</b></div><button className={styles.primary} onClick={()=>enterFactory("正片剧集拼接",h.id)}>进入剧集拼接 →</button></div></article>)}</div></>;
}

function Ranges({enterFactory}:{enterFactory:(m:string,id?:number)=>void}) {
  const [mode,setMode]=useState("全部模式");
  const shown=mode==="全部模式"?ranges:ranges.filter(r=>r.modes.includes(mode));
  return <><div className={styles.subToolbar}><div><h2>可投放区间</h2><p>已验证剧情连续性、可剪辑性与模式适配，可直接作为生产输入。</p></div><select value={mode} onChange={e=>setMode(e.target.value)}><option>全部模式</option><option>正片剧集拼接</option><option>正片剧集解说</option><option>外搭钩子+本剧正片</option></select></div><div className={styles.rangeList}>{shown.map(r=><article key={r.id}><div className={styles.rangeNo}>0{r.id}<span>{r.episodes}</span></div><div className={styles.rangeCopy}><h2>{r.title}</h2><p>{r.summary}</p><div className={styles.rangeMeta}><span>人物 <b>{r.people}</b></span><span>情绪曲线 <b>{r.curve}</b></span><span>付费卡点 <b>{r.paywall}</b></span></div><div className={styles.modeTags}>{r.modes.map(m=><span key={m}>{m}</span>)}</div></div><div className={styles.rangeScores}><span><small>剧情连续性</small><b>{r.continuity}</b><i><em style={{width:`${r.continuity}%`}}/></i></span><span><small>可剪辑性</small><b>{r.editability}</b><i><em style={{width:`${r.editability}%`}}/></i></span><select aria-label="选择生产模式" defaultValue={r.modes[0]}>{r.modes.map(m=><option key={m}>{m}</option>)}</select><button className={styles.primary} onClick={(e)=>{const select=e.currentTarget.previousElementSibling as HTMLSelectElement;enterFactory(select.value,r.id)}}>进入内容工厂 →</button></div></article>)}</div></>;
}

export default DramaLibraryWorkspace;
