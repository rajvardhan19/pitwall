import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseTier,probeDevice,setupProgress,lightsOn,weightsProgress} from '../src/team-setup.ts';

const desktop={mobile:false,webgpu:true,fallbackAdapter:false,memoryGB:8};
test('capable desktops get the full radio; phones and weak devices get text radio with recorded clips',()=>{
  assert.equal(chooseTier(desktop).tier,'full');
  assert.equal(chooseTier({...desktop,memoryGB:undefined}).tier,'full'); // Safari and Firefox do not report memory
  assert.deepEqual(chooseTier({...desktop,mobile:true}),{tier:'lite',reason:'phone or tablet',forced:false});
  assert.equal(chooseTier({...desktop,webgpu:false}).tier,'lite');
  assert.equal(chooseTier({...desktop,fallbackAdapter:true}).tier,'lite');
  assert.equal(chooseTier({...desktop,memoryGB:2}).tier,'lite');
  // The player's choice wins either way.
  assert.equal(chooseTier({...desktop,mobile:true},'full').tier,'full');
  assert.equal(chooseTier(desktop,'lite').tier,'lite');
  assert.equal(chooseTier(desktop,'something else').tier,'full');
});
const nav=(o:Record<string,unknown>)=>({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',maxTouchPoints:0,...o}) as never;
const gpu=(adapter:unknown)=>({requestAdapter:async()=>adapter});
test('device probe: phones, iPads that report a Mac, and missing or software GPUs',async()=>{
  assert.deepEqual(await probeDevice(nav({gpu:gpu({}),deviceMemory:8})),{mobile:false,webgpu:true,fallbackAdapter:false,memoryGB:8});
  assert.equal((await probeDevice(nav({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'}))).mobile,true);
  assert.equal((await probeDevice(nav({maxTouchPoints:5,gpu:gpu({})}))).mobile,true); // iPadOS
  assert.equal((await probeDevice(nav({userAgentData:{mobile:true},gpu:gpu({})}))).mobile,true);
  assert.equal((await probeDevice(nav({}))).webgpu,false);
  assert.equal((await probeDevice(nav({gpu:gpu(null)}))).webgpu,false);
  assert.equal((await probeDevice(nav({gpu:{requestAdapter:async()=>{throw new Error('blocked');}}}))).webgpu,false);
  assert.equal((await probeDevice(nav({gpu:gpu({info:{isFallbackAdapter:true}})}))).fallbackAdapter,true);
});
test('setup progress follows the downloads, and all five lights need both voices and team chat ready',()=>{
  const at=(v:number,vr:boolean,c:number,w:boolean,cr:boolean)=>setupProgress({voice:{progress:v,ready:vr},chat:{progress:c,warming:w,ready:cr}});
  assert.equal(at(0,false,0,false,false),0);
  assert.ok(at(1,true,0,false,false)<0.3,'voices alone are a quarter of the setup');
  const steps=[at(0.5,false,0,false,false),at(1,false,0,false,false),at(1,true,0,false,false),at(1,true,0.5,false,false),at(1,true,1,false,false),at(1,true,1,true,false),at(1,true,1,true,true)];
  for(let i=1;i<steps.length;i++)assert.ok(steps[i]>steps[i-1],`step ${i} moves forward`);
  assert.equal(at(1,true,1,true,true),1);
  assert.ok(lightsOn(at(1,true,1,true,false))<5,'the last light waits for the team to be ready');
  assert.equal(lightsOn(1),5);assert.equal(lightsOn(0),0);assert.equal(lightsOn(0.4),2);
});
test('download progress counts the weights, not the small files that finish first',()=>{
  const files=new Map([['onnx/model_q4f16.onnx',{loaded:149790,total:149790}]]);
  assert.equal(weightsProgress(files),0,'a finished 150 KB graph file is not progress');
  files.set('onnx/model_q4f16.onnx_data',{loaded:272e6,total:1089e6});
  assert.ok(Math.abs(weightsProgress(files)-0.25)<0.01);
  files.set('onnx/model_q4f16.onnx_data',{loaded:1089e6,total:1089e6});assert.equal(weightsProgress(files),1);
});
