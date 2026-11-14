import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localURL,findLocalModels,routeToLocal} from '../src/local-models.ts';
import {voiceProfile} from '../src/radio-profile.ts';
import {BRAIN_MODEL} from '../src/brain.ts';
// @ts-ignore plain JS build scripts
import {MODEL_FILES,KOKORO} from '../scripts/model-files.mjs';
// @ts-ignore plain JS build scripts
import {modelsMiddleware} from '../scripts/models-middleware.mjs';

const local={base:'http://127.0.0.1:5173/models/',files:['onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx','onnx-community/Kokoro-82M-v1.0-ONNX/voices/am_michael.bin']};
test('Hugging Face file URLs map to the saved copy, and only for files that were saved',()=>{
  assert.equal(localURL('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx',local),'http://127.0.0.1:5173/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx');
  assert.equal(localURL('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_michael.bin',local),'http://127.0.0.1:5173/models/onnx-community/Kokoro-82M-v1.0-ONNX/voices/am_michael.bin');
  assert.equal(localURL('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q4.onnx',local),null);
  assert.equal(localURL('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.wasm',local),null);
  assert.equal(localURL('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx',null),null);
});
test('the download list covers every radio voice and the team chat weights',()=>{
  for(const speaker of ['LAU','REY','STRATEGIST','TYRE SPECIALIST','DATA ENGINEER','RACE CONTROL','PIT CREW','ENGINEER'])
    assert.ok(MODEL_FILES.includes(`${KOKORO}/voices/${voiceProfile(speaker).voice}.bin`),speaker);
  for(const file of ['onnx/model.onnx','onnx/model_quantized.onnx'])assert.ok(MODEL_FILES.includes(`${KOKORO}/${file}`));
  for(const file of [`onnx/model_${BRAIN_MODEL.dtype}.onnx`,`onnx/model_${BRAIN_MODEL.dtype}.onnx_data`])assert.ok(MODEL_FILES.includes(`${BRAIN_MODEL.id}/${file}`));
});
test('local models are used only when the server returns the JSON manifest, not a fallback page',async()=>{
  const original=globalThis.fetch;(globalThis as any).location={href:'http://127.0.0.1:5173/'};
  try{
    globalThis.fetch=(async()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}})) as typeof fetch;
    assert.equal(await findLocalModels(),null);
    globalThis.fetch=(async()=>new Response('missing',{status:404})) as typeof fetch;
    assert.equal(await findLocalModels(),null);
    globalThis.fetch=(async()=>Response.json({version:1,files:local.files})) as typeof fetch;
    assert.deepEqual(await findLocalModels(),local);
  }finally{globalThis.fetch=original;delete (globalThis as any).location;}
});
test('worker fetches for saved files go to this computer; the browser cache is skipped only when everything needed is saved',async()=>{
  const original=globalThis.fetch;const asked:string[]=[];
  globalThis.fetch=(async(input:RequestInfo|URL)=>{asked.push(String(input));return new Response('ok');}) as typeof fetch;
  try{
    const env={fetch:globalThis.fetch,useBrowserCache:true};
    assert.equal(routeToLocal(local,env,[`${KOKORO}/onnx/model.onnx`,`${KOKORO}/onnx/model_quantized.onnx`]),false);
    assert.equal(env.useBrowserCache,true);
    await env.fetch('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx');
    await env.fetch('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx');
    // kokoro-js fetches voice files with the global fetch.
    await globalThis.fetch('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_michael.bin');
    assert.deepEqual(asked,['http://127.0.0.1:5173/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx','https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx','http://127.0.0.1:5173/models/onnx-community/Kokoro-82M-v1.0-ONNX/voices/am_michael.bin']);
    assert.equal(routeToLocal(local,env,[`${KOKORO}/onnx/model.onnx`]),true);
    assert.equal(env.useBrowserCache,false);
  }finally{globalThis.fetch=original;}
});
test('the model server answers size probes with a byte range and never serves outside models/',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pitwall-models-'));mkdirSync(join(root,'repo/onnx'),{recursive:true});
  writeFileSync(join(root,'repo/onnx/model.onnx'),Buffer.alloc(1000,7));writeFileSync(join(root,'manifest.json'),'{"files":[]}');
  const handle=modelsMiddleware(root);
  const server=createServer((req,res)=>handle(req,res,()=>{res.statusCode=418;res.end();}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  try{
    const probe=await fetch(`${base}/models/repo/onnx/model.onnx`,{headers:{Range:'bytes=0-0'}});
    assert.equal(probe.status,206);assert.equal(probe.headers.get('content-range'),'bytes 0-0/1000');assert.equal((await probe.arrayBuffer()).byteLength,1);
    const full=await fetch(`${base}/models/repo/onnx/model.onnx`);
    assert.equal(full.status,200);assert.equal((await full.arrayBuffer()).byteLength,1000);
    const manifest=await fetch(`${base}/models/manifest.json`);assert.match(manifest.headers.get('content-type')!,/json/);await manifest.text();
    assert.equal((await fetch(`${base}/models/repo/missing.onnx`)).status,404);
    assert.equal((await fetch(`${base}/models/..%2F..%2Fetc%2Fpasswd`)).status,403);
    assert.equal((await fetch(`${base}/index.html`)).status,418);
  }finally{server.close();}
});
