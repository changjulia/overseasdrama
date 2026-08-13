"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createInspirationMaterialVideoUrl, listInspirationMaterials, readVideoDuration, saveInspirationMaterial, type InspirationMaterial, type InspirationMaterialType } from "../../lib/inspiration-material-store";
import styles from "./InspirationWorkspace.module.css";

export type InspirationTab = "feed" | "prototypes" | "analysis" | "review";
type View = "grid" | "table";
type Material = InspirationMaterial;
type MaterialType = InspirationMaterialType;

export type InspirationWorkspaceProps = {
  initialTab?: InspirationTab;
  onOpenFactory?: (materialId: string) => void;
  onFavoriteChange?: (materialId: string, favorite: boolean) => void;
  onAddMonitorSource?: () => void;
};

const analyzed = (item: Material) => item.analysisStatus === "succeeded";
const fmt = (value: number) => value >= 10000000 ? `${(value / 10000000).toFixed(1)}千万` : `${(value / 10000).toFixed(value >= 10000 ? 0 : 1)}万`;

export function InspirationWorkspace({ initialTab="feed", onOpenFactory, onFavoriteChange, onAddMonitorSource }: InspirationWorkspaceProps) {
  const [tab,setTab]=useState<InspirationTab>(initialTab);
  const [materials,setMaterials]=useState<Material[]>([]);
  const [view,setView]=useState<View>("grid");
  const [query,setQuery]=useState("");
  const [type,setType]=useState("全部类型");
  const [language,setLanguage]=useState("全部语种");
  const [selectedId,setSelectedId]=useState("");
  const [favorites,setFavorites]=useState<string[]>([]);
  const [uploadOpen,setUploadOpen]=useState(false);
  const [toast,setToast]=useState("");
  const [loadError,setLoadError]=useState("");
  const refreshMaterials=async(signal?:AbortSignal)=>{try{const items=await listInspirationMaterials(signal);setMaterials(items);setLoadError("")}catch(reason){if(!signal?.aborted)setLoadError(reason instanceof Error?reason.message:"素材读取失败")}};
  useEffect(()=>{const controller=new AbortController();void refreshMaterials(controller.signal);const timer=window.setInterval(()=>void refreshMaterials(controller.signal),3000);return()=>{controller.abort();window.clearInterval(timer)}},[]);
  const filtered=useMemo(()=>materials.filter(item=>(type==="全部类型"||item.type===type)&&(language==="全部语种"||item.language===language)&&(!query||`${item.title} ${item.theme} ${item.platform}`.toLowerCase().includes(query.toLowerCase()))),[materials,type,language,query]);
  const analyzedItems=materials.filter(analyzed);
  const reviewItems=analyzedItems.filter(item=>item.review!=="已通过");
  const prototypeItems=analyzedItems.filter(item=>item.prototype&&item.prototype!=="待分析");
  const selected=analyzedItems.find(item=>item.id===selectedId)??analyzedItems[0];
  const counts={feed:materials.length,prototypes:new Set(prototypeItems.map(item=>item.prototype)).size,analysis:analyzedItems.length,review:reviewItems.length};
  const flash=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),2200)};
  const toggleFavorite=(id:string)=>{const next=!favorites.includes(id);setFavorites(current=>next?[...current,id]:current.filter(value=>value!==id));onFavoriteChange?.(id,next)};
  return <section className={styles.workspace} aria-label="灵感大屏工作区">
    <header className={styles.header}><div><span className={styles.eyebrow}>市场素材情报中心</span><h1>灵感大屏</h1><p>所有展示均来自手动上传或已连接的数据源。</p></div><div className={styles.headerActions}>{onAddMonitorSource&&<button className={styles.secondary} onClick={onAddMonitorSource}>＋ 添加监测源</button>}<button className={styles.primary} onClick={()=>setUploadOpen(true)}>＋ 手动上传爆款素材</button></div></header>
    <nav className={styles.tabs}>{([['feed','跑量素材'],['prototypes','钩子原型'],['analysis','素材分析'],['review','人工复核']] as const).map(([key,label])=><button key={key} className={tab===key?styles.activeTab:""} onClick={()=>setTab(key)}><span>{label}</span><em>{counts[key]}</em></button>)}</nav>
    {tab==="feed"&&<><div className={styles.stats}>{[["素材总数",materials.length],["已完成分析",analyzedItems.length],["钩子原型",counts.prototypes],["长效素材",materials.filter(item=>item.days>=30).length],["待人工复核",reviewItems.length],["覆盖范围",`${new Set(materials.map(i=>i.market).filter(Boolean)).size} 市场 / ${new Set(materials.map(i=>i.language).filter(Boolean)).size} 语种`]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className={styles.toolbar}><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索标题、题材或平台"/><select value={type} onChange={e=>setType(e.target.value)}><option>全部类型</option><option>正片剧集拼接</option><option>正片剧集解说</option><option>外搭钩子＋本剧正片</option></select><select value={language} onChange={e=>setLanguage(e.target.value)}><option>全部语种</option>{[...new Set(materials.map(i=>i.language).filter(Boolean))].map(v=><option key={v}>{v}</option>)}</select><span className={styles.spacer}/><div className={styles.viewSwitch}><button className={view==="grid"?styles.selected:""} onClick={()=>setView("grid")}>▦</button><button className={view==="table"?styles.selected:""} onClick={()=>setView("table")}>☷</button></div></div>{loadError?<StatePanel icon="!" title="素材加载失败" detail={loadError}/>:filtered.length?(view==="grid"?<div className={styles.grid}>{filtered.map(item=><MaterialCard key={item.id} item={item} favorite={favorites.includes(item.id)} onFavorite={()=>toggleFavorite(item.id)} onAnalyze={()=>{setSelectedId(item.id);setTab("analysis")}}/>)}</div>:<MaterialTable items={filtered} onAnalyze={id=>{setSelectedId(id);setTab("analysis")}}/>):<StatePanel icon="◇" title={materials.length?"没有符合条件的素材":"还没有爆款素材"} detail={materials.length?"请调整搜索或筛选条件。":"使用右上角入口上传真实视频素材。"}/>}</>}
    {tab==="prototypes"&&(prototypeItems.length?<PrototypeView materials={prototypeItems} onFactory={id=>onOpenFactory?.(id)}/>:<StatePanel icon="◇" title="暂无钩子原型" detail="真实分析形成原型聚类后会显示在这里。"/>)}
    {tab==="analysis"&&(selected?<AnalysisView item={selected} all={analyzedItems} onSelect={setSelectedId} onFactory={()=>onOpenFactory?.(selected.id)}/>:<StatePanel icon="◇" title={materials.length?"暂无分析结果":"请先上传素材"} detail={materials.length?"素材已保存，完成真实分析后才展示指标和证据。":"上传真实视频后才可发起分析。"}/>)}
    {tab==="review"&&(reviewItems.length?<ReviewView items={reviewItems}/>:<StatePanel icon="✓" title="暂无待复核素材" detail="只有真实分析标记为待复核的素材才会进入这里。"/>)}
    {uploadOpen&&<MaterialUploadModal onClose={()=>setUploadOpen(false)} onSaved={item=>{setMaterials(current=>[item,...current.filter(v=>v.id!==item.id)]);setUploadOpen(false);flash("素材已保存并进入真实分析队列");void refreshMaterials()}}/>}{toast&&<div className={styles.toast}>✓ {toast}</div>}
  </section>
}

function MaterialCard({item,favorite,onFavorite,onAnalyze}:{item:Material;favorite:boolean;onFavorite:()=>void;onAnalyze:()=>void}){
  const [url,setUrl]=useState<string|null>(null);const video=useRef<HTMLVideoElement>(null);const [playing,setPlaying]=useState(false);const [playbackError,setPlaybackError]=useState("");
  useEffect(()=>{setPlaybackError("");setUrl(createInspirationMaterialVideoUrl(item));},[item]);
  const play=async()=>{const player=video.current;if(!player)return;setPlaybackError("");if(!player.paused){player.pause();return}try{await player.play()}catch{setPlaybackError("浏览器无法解码该视频，请使用 H.264/AAC 编码的 MP4")}};
  return <article className={styles.card}><div className={`${styles.cover} ${styles[item.color]}`}>{url&&<video ref={video} className={styles.materialVideo} src={url} preload="metadata" controls onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onError={()=>setPlaybackError("视频编码不受浏览器支持，请转为 H.264/AAC MP4 后重新上传")}/>}<span className={styles.source}>{item.source} · {item.platform}</span>{!playing&&<button className={styles.play} disabled={!url} onClick={()=>void play()}>{url?"▶":"!"}</button>}<em>{item.media?formatDuration(item.media.duration):"暂无片源"}</em><button className={`${styles.favorite} ${favorite?styles.favorited:""}`} onClick={onFavorite}>{favorite?"♥":"♡"}</button>{playbackError&&<div className={styles.playbackError}>{playbackError}</div>}</div><div className={styles.cardBody}><div className={styles.tags}><span>{item.type}</span><span>{item.language}</span><span>{item.theme}</span></div><h3>{item.title}</h3><p>{item.analysis} · {item.review}</p><dl><div><dt>曝光</dt><dd>{fmt(item.exposure)}</dd></div><div><dt>跑量</dt><dd>{item.days} 天</dd></div><div><dt>原型</dt><dd>{item.prototype}</dd></div></dl><div className={styles.cardFooter}><span>{item.captured}</span><button onClick={onAnalyze}>{analyzed(item)?"进入分析 →":"等待分析"}</button></div></div></article>
}

function MaterialTable({items,onAnalyze}:{items:Material[];onAnalyze:(id:string)=>void}){return <div className={styles.tableWrap}><div className={`${styles.row} ${styles.rowHead}`}><span>素材</span><span>类型</span><span>原型</span><span>片源</span><span>曝光 / 跑量</span><span>状态</span></div>{items.map(item=><button type="button" key={item.id} className={styles.row} onClick={()=>onAnalyze(item.id)}><span><b>{item.title}<small>{item.platform} · {item.language}</small></b></span><span>{item.type}</span><span>{item.prototype}</span><span>{item.media?formatDuration(item.media.duration):"无视频"}</span><span>{fmt(item.exposure)}<small>{item.days} 天</small></span><span><em>{item.analysis}</em><small>{item.review}</small></span></button>)}</div>}

function PrototypeView({materials,onFactory}:{materials:Material[];onFactory:(id:string)=>void}){const groups=[...new Set(materials.map(i=>i.prototype))].map(name=>({name,items:materials.filter(i=>i.prototype===name)}));return <div className={styles.prototypeInsights}>{groups.map(group=><article key={group.name}><span className={styles.label}>真实分析聚类</span><h3>{group.name}</h3><p>{group.items.length} 个素材实例 · 总曝光 {fmt(group.items.reduce((sum,item)=>sum+item.exposure,0))}</p><div className={styles.chips}>{[...new Set(group.items.map(i=>i.language).filter(Boolean))].map(v=><span key={v}>{v}</span>)}</div><button onClick={()=>onFactory(group.items[0].id)}>用首个实例进入内容工厂</button></article>)}</div>}

function AnalysisView({item,all,onSelect,onFactory}:{item:Material;all:Material[];onSelect:(id:string)=>void;onFactory:()=>void}){return <div className={styles.analysisPage}><div className={styles.instancePicker}><label>分析实例<select value={item.id} onChange={e=>onSelect(e.target.value)}>{all.map(v=><option key={v.id} value={v.id}>{v.title}</option>)}</select></label><span>分析置信度 <b>{item.confidence}%</b></span><span className={item.review==="已通过"?styles.success:styles.warning}>{item.review}</span></div><section className={styles.overview}><div className={`${styles.adPreview} ${styles[item.color]}`}><span>{item.platform} · {item.market}</span></div><div><span className={styles.eyebrow}>PERSISTED ANALYSIS</span><h2>{item.title}</h2><p>以下字段来自持久化分析结果，不生成缺失证据。</p><dl><div><dt>钩子类型</dt><dd>{item.hookType}</dd></div><div><dt>钩子时长</dt><dd>{item.hookDuration}s</dd></div><div><dt>过渡</dt><dd>{item.transition}</dd></div><div><dt>原型</dt><dd>{item.prototype}</dd></div></dl><div className={styles.actions}><button onClick={onFactory}>进入内容工厂 →</button></div></div></section></div>}

function ReviewView({items}:{items:Material[]}){return <div className={styles.reviewQueue}><div className={styles.panelTitle}><span><small>REVIEW QUEUE</small><h2>待复核素材</h2></span><em>{items.length}</em></div>{items.map(item=><div key={item.id} className={styles.row}><span><b>{item.title}</b><small>{item.analysis}</small></span><span>{item.review}</span><span>置信度 {item.confidence}%</span><span>等待证据数据</span></div>)}</div>}

function formatDuration(seconds:number){return `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(Math.round(seconds%60)).padStart(2,"0")}`}

function MaterialUploadModal({onClose,onSaved}:{onClose:()=>void;onSaved:(material:Material)=>void}){const [file,setFile]=useState<File|null>(null);const [error,setError]=useState("");const [saving,setSaving]=useState(false);const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);if(!file){setError("请选择一个视频文件");return}setSaving(true);try{const duration=await readVideoDuration(file);const now=new Date();const material:Material={id:`LOCAL-${now.getTime()}`,title:String(form.get("title")||file.name.replace(/\.[^.]+$/,"")),type:String(form.get("type")) as MaterialType,source:"外部",platform:String(form.get("platform")||"手动上传"),market:String(form.get("market")||"未知市场"),language:String(form.get("language")||"未知语种"),theme:String(form.get("theme")||"待分析"),emotion:"待分析",hookType:"待分析",hookDuration:0,transition:"待分析",episode:"本地素材",exposure:Math.max(0,Number(form.get("exposure")||0)),days:Math.max(0,Number(form.get("days")||0)),captured:now.toLocaleString("zh-CN"),prototype:"待分析",reuse:0,confidence:0,review:"待分析",analysis:"等待真实分析",color:"blue",sensory:"待分析",relation:"待分析",highlight:"待分析",hookRelation:"待分析",avLead:"待分析",ageDays:0,highPerformanceRatio:0,media:{name:file.name,type:file.type||"video/mp4",size:file.size,duration},createdAt:now.toISOString()};await saveInspirationMaterial(material,file);onSaved(material)}catch(reason){setError(reason instanceof Error?reason.message:"素材保存失败");setSaving(false)}};return <div className={styles.modalBackdrop}><form className={styles.uploadModal} onSubmit={submit}><header><div><span className={styles.eyebrow}>LOCAL MATERIAL</span><h2>手动上传爆款素材</h2></div><button type="button" onClick={onClose}>×</button></header><div className={styles.uploadFields}><label className={styles.fullField}>视频文件<input type="file" accept="video/*" required onChange={e=>setFile(e.target.files?.[0]??null)}/></label><label>素材标题<input name="title" placeholder="默认使用文件名"/></label><label>素材类型<select name="type" defaultValue="外搭钩子＋本剧正片"><option>正片剧集拼接</option><option>正片剧集解说</option><option>外搭钩子＋本剧正片</option></select></label><label>平台<input name="platform"/></label><label>市场<input name="market"/></label><label>语种<input name="language"/></label><label>题材<input name="theme"/></label><label>曝光量<input name="exposure" type="number" min="0"/></label><label>跑量天数<input name="days" type="number" min="0"/></label></div>{error&&<p className={styles.uploadError}>{error}</p>}<footer><button type="button" onClick={onClose}>取消</button><button className={styles.primary} disabled={saving}>{saving?"正在保存…":"保存并加入素材库"}</button></footer></form></div>}

function StatePanel({icon,title,detail}:{icon:string;title:string;detail:string}){return <div className={styles.statePanel}><i>{icon}</i><h3>{title}</h3><p>{detail}</p></div>}

export default InspirationWorkspace;
