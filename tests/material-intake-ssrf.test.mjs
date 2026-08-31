import test from "node:test";
import assert from "node:assert/strict";
import {downloadRemoteMedia,isPublicDestinationAddress,RemoteMediaDownloadError} from "../app/lib/remote-media-download.ts";

const body=(...chunks)=>({async *[Symbol.asyncIterator](){for(const chunk of chunks)yield Buffer.from(chunk)}});
const publicResolver=async()=>[{address:"93.184.216.34",family:4}];

test("rejects loopback, private, link-local, metadata and mapped IPv6 destinations",()=>{
  for(const address of ["127.0.0.1","10.0.0.1","172.31.0.1","192.168.1.1","169.254.169.254","::1","fe80::1","fc00::1","::ffff:127.0.0.1","64:ff9b::a9fe:a9fe"]){
    assert.equal(isPublicDestinationAddress(address),false,address);
  }
  assert.equal(isPublicDestinationAddress("93.184.216.34"),true);
  assert.equal(isPublicDestinationAddress("2606:4700:4700::1111"),true);
});

test("rejects unsupported schemes and credentials",async()=>{
  for(const url of ["file:///etc/passwd","ftp://example.test/video.mp4","http://user:secret@example.test/video.mp4"]){
    await assert.rejects(downloadRemoteMedia(url,{resolve:publicResolver}),error=>error instanceof RemoteMediaDownloadError&&error.status===400);
  }
});

test("validates DNS results before making a request",async()=>{
  let requested=false;
  await assert.rejects(downloadRemoteMedia("https://media.example/video.mp4",{
    resolve:async()=>[{address:"93.184.216.34",family:4},{address:"10.0.0.8",family:4}],
    request:async()=>{requested=true;throw new Error("must not run")},
  }),/\u5185\u7f51|\u4fdd\u7559\u7f51\u7edc/);
  assert.equal(requested,false);
});

test("revalidates every redirect and blocks a redirect to metadata",async()=>{
  let requests=0;
  await assert.rejects(downloadRemoteMedia("https://media.example/video.mp4",{
    resolve:async hostname=>hostname==="media.example"?publicResolver():[{address:"169.254.169.254",family:4}],
    request:async()=>{requests++;return {status:302,headers:{location:"http://metadata.invalid/latest/meta-data"},body:body()}},
  }),/\u5185\u7f51|\u4fdd\u7559\u7f51\u7edc/);
  assert.equal(requests,1);
});

test("downloads a bounded public response and returns its metadata",async()=>{
  const result=await downloadRemoteMedia("https://media.example/video.mp4",{
    resolve:publicResolver,maxBytes:8,
    request:async(_url,address)=>{assert.equal(address,"93.184.216.34");return {status:200,headers:{"content-type":"video/mp4","content-length":"4"},body:body("ab","cd")}},
  });
  assert.equal(result.bytes.toString(),"abcd");
  assert.equal(result.contentType,"video/mp4");
});

test("enforces declared and streamed byte limits",async()=>{
  await assert.rejects(downloadRemoteMedia("https://media.example/a",{resolve:publicResolver,maxBytes:3,request:async()=>({status:200,headers:{"content-length":"4"},body:body("abcd")})}),error=>error.status===413);
  await assert.rejects(downloadRemoteMedia("https://media.example/b",{resolve:publicResolver,maxBytes:3,request:async()=>({status:200,headers:{},body:body("ab","cd")})}),error=>error.status===413);
});

test("limits redirects",async()=>{
  await assert.rejects(downloadRemoteMedia("https://media.example/a",{resolve:publicResolver,maxRedirects:1,request:async url=>({status:302,headers:{location:url.pathname==="/a"?"/b":"/c"},body:body()})}),/\u91cd\u5b9a\u5411\u8fc7\u591a/);
});
