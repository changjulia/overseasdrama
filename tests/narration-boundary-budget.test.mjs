import test from 'node:test';
import assert from 'node:assert/strict';
import {reservation,candidateEnds,buildPrompt,TOKEN_CAP} from '../scripts/narration-boundary-budget.mjs';
import {buildOpening} from '../scripts/import-narration-openings.mjs';
import {validLocalizedHook} from '../app/lib/hook-asset-store.ts';
test('hard bound includes previous usage, UTF8 input, overhead and maximum output',()=>{
  assert.equal(reservation('中'.repeat(100),380,1200).allowed,false);
  assert.equal(reservation('text',380,0).allowed,true);
  assert.equal(reservation('x',1,TOKEN_CAP).allowed,false);
});
test('candidate endpoints follow actual speech, not 15/60 second windows',()=>{
  const s=[{start:0,end:14.9,text:'An unfinished sentence'},{start:15,end:65.2,text:'The setup is now complete.'},{start:67,end:179.9,text:'More narration.'}];
  const c=candidateEnds(s,180,300);
  assert.deepEqual(c.map(x=>x.end),[65.2]);
  const p=buildPrompt(s,c,0);
  assert.ok(p);assert.equal(reservation(p.prompt,p.maxOutput).allowed,true);
  assert.equal(buildPrompt(s,c,2079),null);
});
test('sentence crossing old cache window is retained without fake timecodes',()=>{
  const row=buildOpening({key:'x',type:'解说'}, {url:'https://example.com/x.mp4',segments:[{start:6.48,end:10.56,text:'a'},{start:10.56,end:15.46,text:'b'}]});
  assert.equal(row.coverageEnd,15.46);assert.equal(row.transcript.at(-1).end,15.46);
});
test('long narration does not relax other source limits',()=>{
  assert.equal(validLocalizedHook({start:0,end:75,sourceClass:'narration_opening'}),true);
  assert.equal(validLocalizedHook({start:0,end:181,sourceClass:'narration_opening'}),false);
  assert.equal(validLocalizedHook({start:0,end:75,sourceClass:'external_material'}),false);
});
