import {KokoroTTS} from 'kokoro-js';
import {env} from '@huggingface/transformers';
import {voiceProfile,spokenText} from './radio-profile.ts';
import {audible} from './radio-audio.ts';
import {routeToLocal} from './local-models.ts';
import {BASE} from './base.ts';
import type {LocalModels} from './local-models.ts';
env.allowLocalModels=false;
const MODEL='onnx-community/Kokoro-82M-v1.0-ONNX';
// Measured in Chrome: q8 on the single-thread WASM runtime renders ~3x slower than real time, so
// live lines arrived late or went stale. fp32 on WebGPU renders 2.5–5x faster than real time.
// fp16 on WebGPU produced silent audio in testing, so it is not used.
const GPU_DTYPE='fp32';
type Device='webgpu'|'wasm';
/** fallback: why the CPU voices were used on a GPU attempt (a real GPU problem, never a network one). */
type Opened={tts:KokoroTTS;device:Device;fallback?:string};
let model:Promise<Opened>|null=null;
// A download can fail for a moment (a 503 from the CDN). That is retried, and then reported so the page offers a
// retry; it is never a reason to give up on the GPU, since the CPU voices would need the network too.
const NETWORK=/fetch|network|load failed|status|\b(429|50[0-9])\b|could not locate|timed? ?out|aborted/i;
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
async function retry<T>(fn:()=>Promise<T>,tries=3):Promise<T>{
  for(let i=1;;i++){
    try{return await fn();}
    catch(e){if(i>=tries||!NETWORK.test(message(e)))throw e;await new Promise(resolve=>setTimeout(resolve,1500*i));}
  }
}
// Report the weights download only (the tiny config and tokenizer files would make the bar jump back and forth).
const progress=(p:{status:string;progress?:number;file?:string;loaded?:number;total?:number})=>{if('progress' in p&&/onnx/.test(String(p.file??'')))self.postMessage({type:'progress',file:p.file,loaded:p.loaded,total:p.total,progress:p.progress});};
// Each loading phase is reported, so the page can tell a slow load from a stalled one.
const stage=(name:'gpu'|'probe'|'cpu')=>self.postMessage({type:'stage',stage:name});
function useSelfHostedWasm(){
  if(!env.backends.onnx.wasm)return;
  env.backends.onnx.wasm.numThreads=1;
  env.backends.onnx.wasm.wasmPaths={mjs:new URL(`${BASE}voice-runtime/ort-wasm-simd-threaded.mjs`,self.location.origin).href,wasm:new URL(`${BASE}voice-runtime/ort-wasm-simd-threaded.wasm`,self.location.origin).href};
}
async function open(prefer:Device):Promise<Opened>{
  const cpu=()=>retry(()=>KokoroTTS.from_pretrained(MODEL,{dtype:'q8',device:'wasm',progress_callback:progress}));
  let fallback:string|undefined;
  if(prefer==='webgpu'){
    stage('gpu');
    const gpu=(self.navigator as Navigator&{gpu?:{requestAdapter():Promise<unknown>}}).gpu;
    if(await gpu?.requestAdapter().catch(()=>null)){
      // WebGPU keeps transformers.js' default runtime from its CDN (too large to self-host).
      const tts=await retry(()=>KokoroTTS.from_pretrained(MODEL,{dtype:GPU_DTYPE,device:'webgpu',progress_callback:progress}))
        .catch(e=>{if(NETWORK.test(message(e)))throw e;fallback=`GPU voices failed to start: ${message(e)}`;return null;});
      if(tts){
        try{
          // Warm-up render: compiles shaders before the race and proves this GPU produces real audio.
          stage('probe');
          const probe=await tts.generate('Radio check.',{voice:'am_michael'});
          if(audible(Float32Array.from(Array.isArray(probe.audio)?probe.audio[0]:probe.audio)))return {tts,device:'webgpu'};
          fallback='GPU voices rendered silence';
        }catch(e){fallback=`GPU test render failed: ${message(e)}`;}
      }
    }else{fallback='no GPU adapter for the voice worker';useSelfHostedWasm();}
  }else useSelfHostedWasm();
  stage('cpu');
  return {tts:await cpu(),device:'wasm',fallback};
}
function load(prefer:Device){
  if(!model)model=open(prefer).catch(e=>{model=null;throw e;});
  return model;
}
// Serial inference avoids overlapping runs. Jobs the UI cancelled while queued are skipped,
// so a reply to the player never waits behind stale lines.
let chain=Promise.resolve();
const cancelled=new Set<number>();
self.onmessage=(event:MessageEvent<{id:number;type:'load'|'speak'|'cancel';text:string;speaker:string;ids?:number[];prefer?:Device;local?:LocalModels|null}>)=>{
  const {id,type,text,speaker,ids,prefer,local}=event.data;
  if(type==='cancel'){for(const x of ids??[])cancelled.add(x);return;}
  // Saved model files load from this computer (npm run models); anything missing still downloads.
  if(type==='load')routeToLocal(local??null,env,[`${MODEL}/onnx/model_quantized.onnx`,...(prefer==='webgpu'?[`${MODEL}/onnx/model.onnx`]:[])]);
  chain=chain.then(async()=>{
    if(cancelled.delete(id))return;
    try{
      const {tts,device,fallback}=await load(prefer??'wasm');
      if(type==='load'){self.postMessage({id,type:'ready',device,fallback});return;}
      self.postMessage({id,type:'begin'});
      const profile=voiceProfile(speaker);
      const started=performance.now();
      const result=await tts.generate(spokenText(text),{voice:profile.voice,speed:profile.rate});
      const ms=performance.now()-started;
      const audio=Float32Array.from(Array.isArray(result.audio)?result.audio[0]:result.audio);
      if(!audible(audio))throw new Error('Voice generation returned silent or invalid audio. Try reloading the headset.');
      self.postMessage({id,type:'audio',audio,rate:result.sampling_rate,ms},{transfer:[audio.buffer]});
    }catch(e){self.postMessage({id,type:'error',error:e instanceof Error?e.message:String(e)});}
  });
};
