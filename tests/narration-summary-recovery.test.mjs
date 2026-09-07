import test from 'node:test';
import assert from 'node:assert/strict';
import {completeFields} from '../scripts/recover-narration-summary-fields.mjs';
test('recover only syntactically complete summary fields, never invent a suffix',()=>{
 assert.deepEqual(completeFields('{"summary":"主角遭遇危机","conflict":"家庭矛盾","identity":"断在这里'),{summary:'主角遭遇危机',conflict:'家庭矛盾',promise:'',identity:''});
 assert.equal(completeFields('{"summary":"未完成').summary,'');
 assert.equal(completeFields('{"summary":"她说\\"别走\\"","identity":').summary,'她说"别走"');
});
