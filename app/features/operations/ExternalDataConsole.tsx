"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { saveExternalInspirationReference } from "../../lib/inspiration-material-store";
import { saveExternalDramaToPocketBase } from "../../lib/pocketbase-drama-store";
import styles from "./external-data-console.module.css";
import selectionStyles from "./external-data-selection.module.css";

type QueryMode = "rankings" | "playback" | "materials";
type Envelope<T = unknown> = { code: number; message: string; data: T | null; request_id?: string };
type RankingItem = { ranking:number; playletId:number; playletName:string; coverOss:string; materialCnt:number; playletTags:string[] };
type RankingData = { month: string; queried_at: string; items: RankingItem[] };
type PlaybackData = { query_name:string; expires_at:string; items:Array<{platform:string;source_id:string;name:string;total_episodes:number;episodes:Array<{episode:number;url:string}>}> };
type MaterialsData = { queried_at:string; upstream:{page:{pageId:number;pageSize:number;totalRecords:number};content:{totalRecord:number;searchList:Array<Record<string,unknown>>}} };

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  const payload = await response.json().catch(() => null) as Envelope<T> | null;
  if (!payload) throw new Error(`接口返回无效数据（HTTP ${response.status}）`);
  if (!response.ok || payload.code !== 0) throw new Error(payload.message || `查询失败（HTTP ${response.status}）`);
  return payload;
}

function text(value: unknown, fallback = "—") { return typeof value === "string" && value.trim() ? value : fallback; }
function number(value: unknown) { const parsed=Number(value); return Number.isFinite(parsed)?parsed:0; }
function strings(value: unknown) { return Array.isArray(value)?value.filter((item):item is string=>typeof item==="string"):[]; }
function plainText(value:unknown,fallback="暂无创意文案"){return text(value,"").replace(/<[^>]*>/g,"").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim()||fallback}
function metric(value:unknown){const amount=number(value);return amount>=1_000_000?`${(amount/1_000_000).toFixed(amount>=10_000_000?0:1)}M`:amount>=1_000?`${(amount/1_000).toFixed(amount>=100_000?0:1)}K`:amount.toLocaleString()}
function duration(value:unknown){const seconds=Math.round(number(value)/1000);return seconds?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`:"—"}
function dramaNames(value:string){return [...new Set(value.split(/[，,、;；\n]+/).map(name=>name.trim()).filter(Boolean))]}
function intakeDateCode(date=new Date()){return `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,"0")}${String(date.getDate()).padStart(2,"0")}`}
function importedMaterialTitle(item:Record<string,unknown>,fallbackRank:number){
  const drama=text(item.playletName,text(item.batchDramaName,plainText(item.title1,"ADX 素材")));
  const rank=Math.max(1,Math.trunc(number(item.materialRanking)||fallbackRank));
  return `${drama}-${intakeDateCode()}-${String(rank).padStart(2,"0")}`;
}

export function ExternalDataConsole({onNotify}:{onNotify?:(message:string)=>void}) {
  const snapshotReady=useRef(false);
  const [mode,setMode]=useState<QueryMode>("rankings");
  const [month,setMonth]=useState("2026-07");
  const [playbackName,setPlaybackName]=useState("");
  const [dramaName,setDramaName]=useState("");
  const [country,setCountry]=useState("");
  const [startDate,setStartDate]=useState("");
  const [endDate,setEndDate]=useState("");
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [result,setResult]=useState<Envelope<RankingData|PlaybackData|MaterialsData>|null>(null);
  const [selectedMaterialIds,setSelectedMaterialIds]=useState<string[]>([]);
  const [selectedRankingIds,setSelectedRankingIds]=useState<number[]>([]);
  const [importing,setImporting]=useState(false);
  const [autoAnalyze,setAutoAnalyze]=useState(true);
  const [dramaImporting,setDramaImporting]=useState("");
  const [notice,setNotice]=useState("");
  const [dramaImportProgress,setDramaImportProgress]=useState("");

  useEffect(()=>{
    try{
      const raw=sessionStorage.getItem("lumina.external-data.snapshot.v1");
      if(raw){
        const saved=JSON.parse(raw) as {mode?:QueryMode;month?:string;playbackName?:string;dramaName?:string;country?:string;startDate?:string;endDate?:string;page?:number;result?:Envelope<RankingData|PlaybackData|MaterialsData>|null;selectedMaterialIds?:string[];selectedRankingIds?:number[];autoAnalyze?:boolean;notice?:string;wasImporting?:boolean};
        if(saved.mode)setMode(saved.mode);if(saved.month)setMonth(saved.month);if(saved.playbackName!==undefined)setPlaybackName(saved.playbackName);if(saved.dramaName!==undefined)setDramaName(saved.dramaName);if(saved.country!==undefined)setCountry(saved.country);if(saved.startDate!==undefined)setStartDate(saved.startDate);if(saved.endDate!==undefined)setEndDate(saved.endDate);if(saved.page)setPage(saved.page);if(saved.result)setResult(saved.result);if(saved.selectedMaterialIds)setSelectedMaterialIds(saved.selectedMaterialIds);if(saved.selectedRankingIds)setSelectedRankingIds(saved.selectedRankingIds);if(saved.autoAnalyze!==undefined)setAutoAnalyze(saved.autoAnalyze);if(saved.wasImporting)setNotice("上次页面刷新时入库尚未完成，已恢复结果和选择；请点击“加入灵感大屏”续传，已入库素材会自动去重。");else if(saved.notice)setNotice(saved.notice);
      }
    }catch{sessionStorage.removeItem("lumina.external-data.snapshot.v1")}
    snapshotReady.current=true;
  },[]);

  useEffect(()=>{
    if(!snapshotReady.current)return;
    try{sessionStorage.setItem("lumina.external-data.snapshot.v1",JSON.stringify({mode,month,playbackName,dramaName,country,startDate,endDate,page,result,selectedMaterialIds,selectedRankingIds,autoAnalyze,notice,wasImporting:importing}))}catch{/* 查询结果过大时仍保留常驻组件内存状态。 */}
  },[mode,month,playbackName,dramaName,country,startDate,endDate,page,result,selectedMaterialIds,selectedRankingIds,autoAnalyze,notice,importing]);

  const fetchMaterialsQueue=async(names:string[],pageId=1)=>{
    const values:MaterialsData[]=[];const failures:Array<{name:string;message:string}>=[];
    for(const [index,name] of names.entries()){
      setNotice(`素材请求排队中 ${index+1} / ${names.length}：${name}`);
      try{
        const response=await fetch("/api/external-data/materials",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({drama_name:name,...(country?{country_id:Number(country)}:{}),...(startDate?{start_date:startDate}:{}),...(endDate?{end_date:endDate}:{}),page:pageId,page_size:40})});
        const payload=await readEnvelope<MaterialsData>(response);
        if(!payload.data)throw new Error(`${name} 未返回素材`);
        let videoRanking=(pageId-1)*payload.data.upstream.page.pageSize;
        values.push({...payload.data,upstream:{...payload.data.upstream,content:{...payload.data.upstream.content,searchList:payload.data.upstream.content.searchList.map(material=>({...material,playletName:text(material.playletName,name),batchDramaName:name,materialRanking:strings(material.videoList)[0]?++videoRanking:0}))}}});
      }catch(reason){failures.push({name,message:reason instanceof Error?reason.message:"未知接口错误"})}
    }
    if(!values.length)throw new Error("所选剧目均未查询到素材");
    const searchList=values.flatMap(value=>value.upstream.content.searchList);
    const totalRecord=values.reduce((sum,value)=>sum+value.upstream.content.totalRecord,0);
    return {data:{queried_at:new Date().toISOString(),upstream:{page:{pageId,pageSize:searchList.length,totalRecords:totalRecord},content:{totalRecord,searchList}}} satisfies MaterialsData,failures};
  };

  const importSeries=async(series:PlaybackData["items"][number],metadata:Record<string,unknown>={},episodeLimit?:number)=>{
    const key=`${series.platform}:${series.source_id}`;setDramaImporting(key);setNotice("");setError("");
    try{await saveExternalDramaToPocketBase({name:series.name,platform:series.platform,sourceId:series.source_id,totalEpisodes:series.total_episodes,coverUrl:text(metadata.cover_url,""),sourceMetadata:{...metadata,playback_platform:series.platform},episodes:series.episodes,episodeLimit,onProgress:(completed,total)=>setDramaImportProgress(`正在录入分集 ${completed} / ${total}`)});setNotice(`“${series.name}”的${episodeLimit?`前 ${Math.min(episodeLimit,series.episodes.length)} 集`:`${series.total_episodes} 集`}视频已加入剧库；请在剧库详情手动开始分析。`)}catch(reason){setError(reason instanceof Error?reason.message:"加入剧库失败")}finally{setDramaImporting("");setDramaImportProgress("")}
  };
  const enrichAndImport=async(name:string,metadata:Record<string,unknown>)=>{
    setDramaImporting(name);setNotice("");setError("");
    try{const response=await fetch(`/api/external-data/playback?name=${encodeURIComponent(name)}`,{cache:"no-store"});const payload=await readEnvelope<PlaybackData>(response);const series=payload.data?.items?.[0];if(!series)throw new Error("没有找到全集就绪的平台版本");await importSeries(series,metadata)}catch(reason){setError(reason instanceof Error?reason.message:"补查全集信息失败")}finally{setDramaImporting("")}
  };

  const importRankedSeries=async(items:RankingItem[],rankingMonth:string)=>{
    setDramaImporting("batch");setNotice("");setError("");
    let imported=0,failed=0;
    try{
      for(const [index,item] of items.entries()){
        setDramaImportProgress(`正在处理 ${index+1} / ${items.length}：${item.playletName}`);
        try{
          const response=await fetch(`/api/external-data/playback?name=${encodeURIComponent(item.playletName)}`,{cache:"no-store"});
          const payload=await readEnvelope<PlaybackData>(response);
          const series=payload.data?.items?.[0];
          if(!series)throw new Error("未找到全集版本");
          await saveExternalDramaToPocketBase({name:series.name,platform:series.platform,sourceId:series.source_id,totalEpisodes:series.total_episodes,coverUrl:item.coverOss,sourceMetadata:{dataeye_playlet_id:item.playletId,ranking:item.ranking,ranking_month:rankingMonth,material_count:item.materialCnt,playlet_tags:item.playletTags,playback_platform:series.platform},episodes:series.episodes,onProgress:(completed,total)=>setDramaImportProgress(`正在处理 ${index+1} / ${items.length}：${item.playletName} · 分集 ${completed} / ${total}`)});
          imported++;
        }catch{failed++}
      }
      setNotice(`批量全集入库完成：成功 ${imported} 部${failed?`，失败 ${failed} 部`:""}。可前往剧库查看并手动开始分析。`);
      if(imported)setSelectedRankingIds([]);
    }finally{setDramaImporting("");setDramaImportProgress("")}
  };

  const queryRankedMaterials=async(items:RankingItem[])=>{
    setLoading(true);setError("");setNotice("");setSelectedMaterialIds([]);
    try{
      const outcome=await fetchMaterialsQueue(items.map(item=>item.playletName));
      const idByName=new Map(items.map(item=>[item.playletName,item.playletId]));
      outcome.data.upstream.content.searchList=outcome.data.upstream.content.searchList.map(material=>({...material,rankingPlayletId:idByName.get(text(material.batchDramaName,""))}));
      setResult({code:0,message:"ok",data:outcome.data});setDramaName("");setMode("materials");
      const failureText=outcome.failures.map(item=>`“${item.name}”：${item.message}`).join("；");
      setNotice(`排队请求完成：已汇总 ${items.length-outcome.failures.length} 部剧目的 ${outcome.data.upstream.content.searchList.length} 条当前页素材${failureText?`；失败 ${outcome.failures.length} 部——${failureText}`:""}。`);
    }catch(reason){setError(reason instanceof Error?reason.message:"批量查询素材失败")}
    finally{setLoading(false)}
  };

  const importMaterials=async(items:Array<Record<string,unknown>>)=>{
    setImporting(true);setError("");setNotice("");
    let imported=0,duplicates=0,skipped=0,queued=0,completed=0;
    const failures:string[]=[];
    const concurrency=6;
    const uploadOne=async(item:Record<string,unknown>,index:number)=>{
      const videoUrl=strings(item.videoList)[0];
      if(!videoUrl){skipped++;completed++;setNotice(`素材并发入库中 ${completed} / ${items.length} · ${concurrency} 路并发`);return}
      try{
        const countries=Array.isArray(item.countries)?item.countries.map(country=>country&&typeof country==="object"?text((country as Record<string,unknown>).countryName,""):"").filter(Boolean):[];
        const market=countries.length?`${countries.slice(0,3).join(" / ")}${countries.length>3?` +${countries.length-3}`:""}`:"ADX 市场";
        const outcome=await saveExternalInspirationReference({externalId:text(item.materialId,text(item.id,"")),title:importedMaterialTitle(item,index+1),sourceUrl:videoUrl,market,exposure:number(item.exposureNum),days:number(item.releaseDay),durationSeconds:number(item.durationMillis)/1000},autoAnalyze);
        if(outcome.created)imported++;else duplicates++;if(outcome.analysisQueued)queued++;
      }catch(reason){failures.push(`#${text(item.materialId,text(item.id,String(index+1)))}：${reason instanceof Error?reason.message:"未知错误"}`)}
      finally{completed++;setNotice(`素材并发入库中 ${completed} / ${items.length} · ${concurrency} 路并发`)}
    };
    try{
      let cursor=0;
      const workers=Array.from({length:Math.min(concurrency,items.length)},async()=>{while(cursor<items.length){const index=cursor++;await uploadOne(items[index],index)}});
      await Promise.all(workers);
      const message=`入库完成：新增 ${imported} 条${queued?`，分析排队 ${queued} 条`:""}${duplicates?`，去重 ${duplicates} 条`:""}${skipped?`，无视频 ${skipped} 条`:""}${failures.length?`，失败 ${failures.length} 条——${failures.slice(0,3).join("；")}${failures.length>3?`；另 ${failures.length-3} 条`:""}`:""}。`;
      setNotice(message);onNotify?.(message);if(!failures.length)setSelectedMaterialIds([]);
    }finally{setImporting(false)}
  };

  const run=async(event:FormEvent)=>{
    event.preventDefault();setLoading(true);setError("");setResult(null);setSelectedMaterialIds([]);setSelectedRankingIds([]);
    try{
      let response:Response;
      if(mode==="rankings") response=await fetch(`/api/external-data/rankings?month=${encodeURIComponent(month)}`,{cache:"no-store"});
      else if(mode==="playback") response=await fetch(`/api/external-data/playback?name=${encodeURIComponent(playbackName.trim())}`,{cache:"no-store"});
      else {
        const names=dramaNames(dramaName);
        const outcome=await fetchMaterialsQueue(names,page);
        setResult({code:0,message:"ok",data:outcome.data});
        const failureText=outcome.failures.map(item=>`“${item.name}”：${item.message}`).join("；");
        setNotice(`排队请求完成：成功 ${names.length-outcome.failures.length} 部，共汇总 ${outcome.data.upstream.content.searchList.length} 条当前页素材${failureText?`；失败 ${outcome.failures.length} 部——${failureText}`:""}。`);
        return;
      }
      setResult(await readEnvelope<RankingData|PlaybackData|MaterialsData>(response));
    }catch(reason){setError(reason instanceof Error?reason.message:"查询失败");}
    finally{setLoading(false)}
  };

  const switchMode=(next:QueryMode)=>{setMode(next);setResult(null);setError("")};
  return <section className={styles.console} aria-label="外部短剧数据手动查询">
    <header><div><small>EXTERNAL OPEN API</small><h2>外部短剧数据 · 查询与入库</h2><p>ADX 广告素材加入灵感大屏；短剧全集加入剧库。两类资产分开管理。</p></div><span className={styles.connected}><i/> 查询时验证安全连接</span></header>
    <nav>{([['rankings','月度短剧榜'],['playback','全集播放地址'],['materials','ADX 素材']] as const).map(([key,label])=><button key={key} className={mode===key?styles.active:""} onClick={()=>switchMode(key)}>{label}</button>)}</nav>
    <form onSubmit={run}>
      {mode==="rankings"&&<label><span>榜单月份</span><input type="month" required value={month} onChange={event=>setMonth(event.target.value)}/></label>}
      {mode==="playback"&&<label className={styles.wide}><span>完整短剧名称</span><input required maxLength={500} value={playbackName} onChange={event=>setPlaybackName(event.target.value)} placeholder="输入正式剧名或完整别名"/></label>}
      {mode==="materials"&&<><label className={styles.wide}><span>短剧名称（多个剧名用逗号、顿号或换行分隔，将自动排队）</span><input required maxLength={2000} value={dramaName} onChange={event=>setDramaName(event.target.value)} placeholder="输入一个或多个完整短剧名称"/></label><label><span>国家 / 地区</span><select value={country} onChange={event=>setCountry(event.target.value)}><option value="">不限国家</option><option value="1">美国</option><option value="13">日本</option><option value="24">韩国</option></select></label><label><span>开始日期（可选）</span><input type="date" value={startDate} onChange={event=>setStartDate(event.target.value)}/></label><label><span>结束日期（可选）</span><input type="date" value={endDate} onChange={event=>setEndDate(event.target.value)}/></label><label><span>页码</span><input type="number" min={1} value={page} onChange={event=>setPage(Math.max(1,Number(event.target.value)||1))}/></label></>}
      <button className={styles.submit} disabled={loading}>{loading?"查询中…":"手动查询"}</button>
    </form>
    {error&&<div className={styles.error}>操作失败：{error}</div>}
    {notice&&<div className={styles.notice}>{notice}</div>}
    {dramaImportProgress&&<div className={styles.notice}>{dramaImportProgress}，请勿关闭页面</div>}
    {result?.data&&<Result mode={mode} data={result.data} selectedIds={selectedMaterialIds} onSelectedIds={setSelectedMaterialIds} selectedRankingIds={selectedRankingIds} onSelectedRankingIds={setSelectedRankingIds} importing={importing} autoAnalyze={autoAnalyze} onAutoAnalyze={setAutoAnalyze} dramaImporting={dramaImporting} onImportSeries={importSeries} onEnrichImport={enrichAndImport} onImportRankedSeries={importRankedSeries} onQueryRankedMaterials={queryRankedMaterials} onImport={importMaterials}/>} 
  </section>
}

function Result({mode,data,selectedIds,onSelectedIds,selectedRankingIds,onSelectedRankingIds,importing,autoAnalyze,onAutoAnalyze,dramaImporting,onImportSeries,onEnrichImport,onImportRankedSeries,onQueryRankedMaterials,onImport}:{mode:QueryMode;data:RankingData|PlaybackData|MaterialsData;selectedIds:string[];onSelectedIds:(ids:string[])=>void;selectedRankingIds:number[];onSelectedRankingIds:(ids:number[])=>void;importing:boolean;autoAnalyze:boolean;onAutoAnalyze:(value:boolean)=>void;dramaImporting:string;onImportSeries:(series:PlaybackData["items"][number],metadata?:Record<string,unknown>,episodeLimit?:number)=>Promise<void>;onEnrichImport:(name:string,metadata:Record<string,unknown>)=>Promise<void>;onImportRankedSeries:(items:RankingItem[],month:string)=>Promise<void>;onQueryRankedMaterials:(items:RankingItem[])=>Promise<void>;onImport:(items:Array<Record<string,unknown>>)=>Promise<void>}){
  if(mode==="rankings"){
    const value=data as RankingData;
    const allSelected=value.items.length>0&&value.items.every(item=>selectedRankingIds.includes(item.playletId));
    const selected=value.items.filter(item=>selectedRankingIds.includes(item.playletId));
    return <div className={styles.results}><div className={styles.resultMeta}><b>{value.month} 月榜</b><span>返回 {value.items.length} 部短剧 · 查询时间 {new Date(value.queried_at).toLocaleString("zh-CN")}</span></div><div className={selectionStyles.bar}><label><input type="checkbox" checked={allSelected} onChange={()=>onSelectedRankingIds(allSelected?[]:value.items.map(item=>item.playletId))}/> 全选当前榜单</label><span>已选 {selected.length} 部</span><button disabled={!selected.length||Boolean(dramaImporting)} onClick={()=>void onImportRankedSeries(selected,value.month)}>{dramaImporting==="batch"?"全集加入剧库中…":"批量将全集加入剧库"}</button><button className={selectionStyles.download} disabled={!selected.length||Boolean(dramaImporting)} onClick={()=>void onQueryRankedMaterials(selected)}>查询所选剧目素材</button></div><div className={styles.table}><div><b>选择 / 排名</b><b>短剧</b><b>素材数</b><b>标签 / 操作</b></div>{value.items.map(item=><div className={selectedRankingIds.includes(item.playletId)?styles.selectedRow:""} key={item.playletId}><strong><input aria-label={`选择${item.playletName}`} type="checkbox" checked={selectedRankingIds.includes(item.playletId)} onChange={()=>onSelectedRankingIds(selectedRankingIds.includes(item.playletId)?selectedRankingIds.filter(id=>id!==item.playletId):[...selectedRankingIds,item.playletId])}/> #{item.ranking}</strong><span>{item.playletName}<small>DataEye ID {item.playletId}</small></span><span>{item.materialCnt.toLocaleString()}</span><span className={styles.rowAction}>{item.playletTags?.slice(0,3).join(" / ")||"—"}<button disabled={Boolean(dramaImporting)} onClick={()=>void onEnrichImport(item.playletName,{dataeye_playlet_id:item.playletId,ranking:item.ranking,ranking_month:value.month,material_count:item.materialCnt,playlet_tags:item.playletTags,cover_url:item.coverOss})}>{dramaImporting===item.playletName?"全集加入中…":"全集加入剧库"}</button></span></div>)}</div></div>;
  }
  if(mode==="playback"){
    const value=data as PlaybackData;
    return <div className={styles.results}><div className={styles.resultMeta}><b>{value.query_name}</b><span>地址最早失效时间：{new Date(value.expires_at).toLocaleString("zh-CN")}</span></div>{value.items.map(series=><article className={styles.series} key={`${series.platform}-${series.source_id}`}><header><div><b>{series.name}</b><small>{series.platform} · {series.source_id}</small></div><div className={styles.seriesActions}><strong>{series.total_episodes} 集</strong><button disabled={Boolean(dramaImporting)||series.episodes.length<10} onClick={()=>void onImportSeries(series,{query_name:value.query_name,expires_at:value.expires_at,acceptance_scope:"first_10"},10)}>{dramaImporting===`${series.platform}:${series.source_id}`?"前10集加入中…":"前10集验收入库"}</button><button disabled={Boolean(dramaImporting)} onClick={()=>void onImportSeries(series,{query_name:value.query_name,expires_at:value.expires_at})}>{dramaImporting===`${series.platform}:${series.source_id}`?"全集加入中…":"全集加入剧库"}</button></div></header><div>{series.episodes.map(episode=><a key={episode.episode} href={episode.url} target="_blank" rel="noreferrer">EP{episode.episode}</a>)}</div></article>)}</div>;
  }
  const value=data as MaterialsData,items=value.upstream.content.searchList;
  const itemKey=(item:Record<string,unknown>,index:number)=>`${item.rankingPlayletId===undefined?text(item.playletName,"drama"):String(item.rankingPlayletId)}:${text(item.id,String(index))}`;
  const selectableIds=items.map((item,index)=>(strings(item.videoList)[0]||strings(item.picList)[0])?itemKey(item,index):"").filter(Boolean),allSelected=selectableIds.length>0&&selectableIds.every(id=>selectedIds.includes(id));
  const selectedItems=items.filter((item,index)=>selectedIds.includes(itemKey(item,index)));
  const downloadSelected=()=>{for(const [index,item] of selectedItems.entries()){const url=strings(item.videoList)[0]||strings(item.picList)[0];if(!url)continue;window.setTimeout(()=>{const anchor=document.createElement("a");anchor.href=url;anchor.target="_blank";anchor.rel="noreferrer";anchor.download=`adx-${text(item.materialId,text(item.id,String(index)))}.${strings(item.videoList)[0]?"mp4":"jpg"}`;document.body.appendChild(anchor);anchor.click();anchor.remove()},index*250)}};
  return <div className={styles.results}>
    <div className={styles.resultMeta}><div><b>ADX 素材结果</b><small>按曝光量排序 · 实时查询结果</small></div><span>第 {value.upstream.page.pageId} 页 · 共 {value.upstream.content.totalRecord.toLocaleString()} 条 · 当前 {items.length} 条</span></div>
    <div className={selectionStyles.bar}><label><input type="checkbox" checked={allSelected} disabled={!selectableIds.length} onChange={()=>onSelectedIds(allSelected?[]:selectableIds)}/> 全选当前页素材</label><label className={selectionStyles.analysis}><input type="checkbox" checked={autoAnalyze} onChange={event=>onAutoAnalyze(event.target.checked)}/> 加入后自动分析</label><span>已选 {selectedIds.length} 条</span><button disabled={!selectedIds.length||importing} onClick={()=>void onImport(selectedItems)}>{importing?"正在处理…":"加入灵感大屏"}</button><button className={selectionStyles.download} disabled={!selectedIds.length} onClick={downloadSelected}>下载到本地</button></div>
    <div className={styles.materialGrid}>{items.map((item,index)=>{
      const id=itemKey(item,index),videos=strings(item.videoList),pictures=strings(item.picList),isVideo=videos.length>0,width=number(item.materialWidth),height=number(item.materialHeight),selected=selectedIds.includes(id);
      const media=item.media&&typeof item.media==="object"?item.media as Record<string,unknown>:{};
      const product=item.product&&typeof item.product==="object"?item.product as Record<string,unknown>:{};
      const countries=Array.isArray(item.countries)?item.countries.map(country=>country&&typeof country==="object"?text((country as Record<string,unknown>).countryName,""):"").filter(Boolean):[];
      return <article className={`${styles.materialCard} ${selected?selectionStyles.selected:""}`} key={id}>
        <label className={selectionStyles.check}><input type="checkbox" checked={selected} disabled={!isVideo&&!pictures[0]} onChange={()=>onSelectedIds(selected?selectedIds.filter(value=>value!==id):[...selectedIds,id])}/><span>{isVideo||pictures[0]?"选择":"无媒体"}</span></label>
        <div className={styles.preview} style={{"--media-ratio":width>0&&height>0?`${width} / ${height}`:"9 / 16"} as CSSProperties}>
          {isVideo?<video src={videos[0]} controls preload="none" playsInline/>:pictures[0]?<img src={pictures[0]} loading="lazy" alt={`${text(item.playletName,"短剧")} 素材预览`}/>:<span>暂无预览</span>}
          <div className={styles.previewBadges}><em>{isVideo?"视频":"图片"}</em><em>{text(media.mediaName,"未知媒体")}</em></div>
          <span className={styles.previewMeta}>{width&&height?`${width}×${height}`:"尺寸未知"}{isVideo&&number(item.durationMillis)>0?` · ${duration(item.durationMillis)}`:""}</span>
        </div>
        <div className={styles.materialBody}>
          <div className={styles.cardTitle}><div><small>{text(product.productName,"未关联产品")}</small><b title={text(item.playletName,"未关联短剧")}>{text(item.playletName,"未关联短剧")}</b></div><span>#{text(item.materialId,text(item.id,String(index)))}</span></div>
          <p title={plainText(item.title1)}>{plainText(item.title1)}</p>
          <div className={styles.metrics}><div><small>曝光</small><strong>{metric(item.exposureNum)}</strong></div><div><small>播放</small><strong>{metric(item.playNum)}</strong></div><div><small>热度</small><strong>{metric(item.heatNum)}</strong></div><div><small>投放</small><strong>{number(item.releaseDay)}天</strong></div></div>
          <footer><span title={countries.join("、")}>⌖ {countries.slice(0,2).join("、")||"地区未知"}{countries.length>2?` +${countries.length-2}`:""}</span><time>{text(item.firstSeen)} — {text(item.lastSeen)}</time></footer>
          <button className={styles.cardImport} disabled={importing||!isVideo} onClick={()=>void onImport([item])}>{importing?"正在处理…":isVideo?"加入灵感大屏":"无视频，不能加入"}</button>
        </div>
      </article>})}</div>
  </div>;
}

export default ExternalDataConsole;
