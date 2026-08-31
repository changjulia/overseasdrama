import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const DEFAULT_MAX_BYTES=250*1024*1024;
const DEFAULT_CONNECT_TIMEOUT_MS=10_000;
const DEFAULT_TOTAL_TIMEOUT_MS=120_000;
const DEFAULT_MAX_REDIRECTS=3;

export class RemoteMediaDownloadError extends Error{
  readonly status:number;
  constructor(message:string,status=502){super(message);this.name="RemoteMediaDownloadError";this.status=status}
}

function ipv4Number(address:string){
  const parts=address.split(".").map(Number);
  if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255))return undefined;
  return (((parts[0]*256+parts[1])*256+parts[2])*256+parts[3])>>>0;
}
function ipv4In(address:string,base:string,bits:number){
  const value=ipv4Number(address),network=ipv4Number(base);
  if(value===undefined||network===undefined)return false;
  const divisor=2**(32-bits);
  return Math.floor(value/divisor)===Math.floor(network/divisor);
}
function parseIpv6(address:string){
  const plain=address.split("%")[0].toLowerCase();
  const mapped=plain.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if(mapped)return {mapped:mapped[1]};
  const halves=plain.split("::");
  if(halves.length>2)return undefined;
  const left=halves[0]?halves[0].split(":"):[];
  const right=halves[1]?halves[1].split(":"):[];
  const expand=(part:string)=>{
    if(!part.includes("."))return [part];
    const value=ipv4Number(part);
    return value===undefined?[]:[((value>>>16)&0xffff).toString(16),(value&0xffff).toString(16)];
  };
  const leftWords=left.flatMap(expand),rightWords=right.flatMap(expand);
  const missing=8-leftWords.length-rightWords.length;
  if((halves.length===1&&missing!==0)||missing<0)return undefined;
  const words=[...leftWords,...Array(missing).fill("0"),...rightWords];
  if(words.length!==8||words.some(word=>!/^[0-9a-f]{1,4}$/.test(word)))return undefined;
  const numeric=words.map(word=>Number.parseInt(word,16));
  if(numeric.slice(0,5).every(word=>word===0)&&numeric[5]===0xffff)return {mapped:[numeric[6]>>>8,numeric[6]&255,numeric[7]>>>8,numeric[7]&255].join(".")};
  return {words:numeric};
}

/** Only globally routable destination addresses are accepted. */
export function isPublicDestinationAddress(address:string){
  const family=isIP(address);
  if(family===4){
    return ![
      ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
      ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],
      ["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],
      ["224.0.0.0",4],["240.0.0.0",4],
    ].some(([base,bits])=>ipv4In(address,String(base),Number(bits)));
  }
  if(family!==6)return false;
  const parsed=parseIpv6(address);
  if(!parsed)return false;
  if(parsed.mapped)return isPublicDestinationAddress(parsed.mapped);
  const words=parsed.words!;
  if(words.every(word=>word===0)||(words.slice(0,7).every(word=>word===0)&&words[7]===1))return false;
  if((words[0]&0xfe00)===0xfc00||(words[0]&0xffc0)===0xfe80||(words[0]&0xff00)===0xff00)return false;
  if(words[0]===0x2001&&words[1]===0x0db8)return false;
  // IPv4 translation/tunnelling can otherwise smuggle a private destination.
  if((words[0]===0x64&&words[1]===0xff9b&&words.slice(2,6).every(word=>word===0))||words[0]===0x2002){
    const pair=words[0]===0x2002?[words[1],words[2]]:[words[6],words[7]];
    const embedded=[pair[0]>>>8,pair[0]&255,pair[1]>>>8,pair[1]&255].join(".");
    return isPublicDestinationAddress(embedded);
  }
  return true;
}

type Resolve=(hostname:string)=>Promise<{address:string;family:number}[]>;
type Hop={status:number;headers:Record<string,string|undefined>;body:AsyncIterable<Uint8Array>};
type RequestHop=(url:URL,address:string,deadline:number,connectTimeoutMs:number)=>Promise<Hop>;

async function resolvePublic(url:URL,resolver:Resolve){
  const literalFamily=isIP(url.hostname.replace(/^\[|\]$/g,""));
  const addresses=literalFamily?[{address:url.hostname.replace(/^\[|\]$/g,""),family:literalFamily}]:await resolver(url.hostname);
  if(!addresses.length||addresses.some(item=>!isPublicDestinationAddress(item.address)))throw new RemoteMediaDownloadError("远程素材地址不允许访问内网或保留网络",400);
  return addresses[0].address;
}

async function beforeDeadline<T>(promise:Promise<T>,deadline:number,message:string){
  const remaining=deadline-Date.now();
  if(remaining<=0)throw new RemoteMediaDownloadError(message,504);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new RemoteMediaDownloadError(message,504)),remaining)})])}
  finally{if(timer)clearTimeout(timer)}
}

const defaultResolver:Resolve=async hostname=>(await lookup(hostname,{all:true,verbatim:true})).map(item=>({address:item.address,family:item.family}));
const defaultRequest:RequestHop=(url,address,deadline,connectTimeoutMs)=>new Promise((resolve,reject)=>{
  const transport=url.protocol==="https:"?https:http;
  const request=transport.request(url,{method:"GET",headers:{Accept:"video/*,application/octet-stream;q=0.8","User-Agent":"Lumina-Material-Intake/1.0"},lookup:(_hostname,_options,callback)=>callback(null,address,isIP(address)),agent:false},response=>{
    const headers:Object=Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(", "):value]));
    resolve({status:response.statusCode||502,headers:headers as Record<string,string|undefined>,body:response as Readable});
  });
  request.once("socket",socket=>socket.setTimeout(Math.min(connectTimeoutMs,Math.max(1,deadline-Date.now())),()=>request.destroy(new Error("连接超时"))));
  request.setTimeout(Math.max(1,deadline-Date.now()),()=>request.destroy(new Error("下载超时")));
  request.once("error",reject);
  request.end();
});

export async function downloadRemoteMedia(source:string,options:{maxBytes?:number;maxRedirects?:number;connectTimeoutMs?:number;totalTimeoutMs?:number;resolve?:Resolve;request?:RequestHop}={}){
  const maxBytes=options.maxBytes??DEFAULT_MAX_BYTES,maxRedirects=options.maxRedirects??DEFAULT_MAX_REDIRECTS;
  const deadline=Date.now()+(options.totalTimeoutMs??DEFAULT_TOTAL_TIMEOUT_MS);
  let current:URL;
  try{current=new URL(source)}catch{throw new RemoteMediaDownloadError("远程素材地址无效",400)}
  for(let redirects=0;;redirects++){
    if(!["http:","https:"].includes(current.protocol)||current.username||current.password)throw new RemoteMediaDownloadError("远程素材地址无效",400);
    if(Date.now()>=deadline)throw new RemoteMediaDownloadError("远程视频下载超时",504);
    const address=await beforeDeadline(resolvePublic(current,options.resolve??defaultResolver),deadline,"远程地址解析超时");
    const response=await beforeDeadline((options.request??defaultRequest)(current,address,deadline,options.connectTimeoutMs??DEFAULT_CONNECT_TIMEOUT_MS),deadline,"远程视频下载超时");
    if([301,302,303,307,308].includes(response.status)){
      if(redirects>=maxRedirects)throw new RemoteMediaDownloadError("远程视频重定向过多",502);
      const location=response.headers.location;
      if(!location)throw new RemoteMediaDownloadError("远程视频重定向无效",502);
      if(response.body instanceof Readable)response.body.destroy();
      try{current=new URL(location,current)}catch{throw new RemoteMediaDownloadError("远程视频重定向无效",502)}
      continue;
    }
    if(response.status<200||response.status>=300)throw new RemoteMediaDownloadError(`远程视频下载失败（HTTP ${response.status}）`,502);
    const declared=Number(response.headers["content-length"]||0);
    if(declared>maxBytes)throw new RemoteMediaDownloadError("远程视频超过大小限制",413);
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of response.body){
      if(Date.now()>=deadline)throw new RemoteMediaDownloadError("远程视频下载超时",504);
      size+=chunk.byteLength;
      if(size>maxBytes)throw new RemoteMediaDownloadError("远程视频超过大小限制",413);
      chunks.push(chunk);
    }
    return {bytes:Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))),contentType:response.headers["content-type"]||"video/mp4",finalUrl:current.toString()};
  }
}
