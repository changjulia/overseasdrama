import test from 'node:test';
import assert from 'node:assert/strict';
import { getPocketBaseTaskLog, listPocketBaseAnalysisTasks } from '../app/lib/pocketbase-analysis-store.ts';
import { listPocketBaseDramas } from '../app/lib/pocketbase-drama-store.ts';

test('task listing pages through lightweight records without nested result blobs', async () => {
 const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async input=>{const u=new URL(String(input),'http://localhost');calls.push(u);const page=Number(u.searchParams.get('page'));return Response.json({totalPages:2,items:[{id:`${u.pathname}-${page}`,status:'queued',stage:'coarse',progress:0,attempt:0,max_attempts:3,expand:{drama:{title:'Test'},match:{expand:{drama:{title:'Test'}}},match_job:{expand:{drama:{title:'Test'}}}}}]});};
 try {const tasks=await listPocketBaseAnalysisTasks();assert.equal(tasks.length,8);assert.equal(calls.length,8);assert.ok(calls.every(u=>u.pathname.includes('/api/lumina/task-summaries/')));assert.ok(calls.every(u=>!u.searchParams.has('expand')));assert.ok(tasks.every(t=>t.title.includes('Test')));}
 finally {globalThis.fetch=original;}
});

test('concurrent library consumers share a request; failures remain retryable',async()=>{
 const original=globalThis.fetch;let calls=0;let fail=true;
 globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return fail?new Response('{}',{status:502}):Response.json({items:[],totalPages:1});};
 try {const first=await Promise.allSettled([listPocketBaseDramas(),listPocketBaseDramas()]);assert.ok(first.every(x=>x.status==='rejected'));assert.equal(calls,1);fail=false;assert.deepEqual(await listPocketBaseDramas(),[]);assert.equal(calls,2);}
 finally{globalThis.fetch=original;}
});

test('task logs come from the matching backend collection and surface read failures', async () => {
 const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async input=>{const url=new URL(String(input),'http://localhost');calls.push(url);return calls.length===4?new Response('{}',{status:502}):Response.json({status:'succeeded',logs:{actual:'worker trace'}});};
 try {
  for (const [stage,collection] of [['coarse','analysis_jobs'],['hook_match','hook_match_jobs'],['entry_precision','entry_precision_jobs']]) {
   const result=await getPocketBaseTaskLog({backendId:'example-record',stage});
   assert.equal(result.logs.actual,'worker trace');
   assert.ok(calls.at(-1).pathname.includes(`/collections/${collection}/records/`));
   assert.equal(calls.at(-1).searchParams.get('fields'),'id,status,error,logs');
  }
  await assert.rejects(getPocketBaseTaskLog({backendId:'example-record',stage:'supplemental_highlight'}),/502/);
 } finally {globalThis.fetch=original;}
});
