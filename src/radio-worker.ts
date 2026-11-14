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
let model:Promise<{tts:KokoroTTS;device:Device}>|null=null;
// Report the weights download only (the tiny config and tokenizer files would make the bar jump back and forth).
const progress=(p:{status:string;progress?:number;file?:string;loaded?:number;total?:number})=>{if('progress' in p&&/onnx/.test(String(p.file??'')))self.postMessage({type:'progress',file:p.file,loaded:p.loaded,total:p.total,progress:p.progress});};
// Each loading phase is reported, so the page can tell a slow load from a stalled one.
const stage=(name:'gpu'|'probe'|'cpu')=>self.postMessage({type:'stage',stage:name});
function useSelfHostedWasm(){
  if(!env.backends.onnx.wasm)return;
  env.backends.onnx.wasm.numThreads=1;
  env.backends.onnx.wasm.wasmPaths={mjs:new URL(`${BASE}voice-runtime/ort-wasm-simd-threaded.mjs`,self.location.origin).href,wasm:new URL(`${BASE}voice-runtime/ort-wasm-simd-threaded.wasm`,self.location.origin).href};
}
async function open(prefer:Device){
  if(prefer==='webgpu'){
    stage('gpu');
    const gpu=(self.navigator as Navigator&{gpu?:{requestAdapter():Promise<unknown>}}).gpu;
    if(await gpu?.requestAdapter().catch(()=>null)){
      // WebGPU keeps transformers.js' default runtime from its CDN (too large to self-host).
      try{
        const tts=await KokoroTTS.from_pretrained(MODEL,{dtype:GPU_DTYPE,device:'webgpu',progress_callback:progress});
        // Warm-up render: compiles shaders before the race and proves this GPU produces real audio.
        stage('probe');
        const probe=await tts.generate('Radio check.',{voice:'am_michael'});
        if(audible(Float32Array.from(Array.isArray(probe.audio)?probe.audio[0]:probe.audio)))return {tts,device:'webgpu' as const};
      }catch{/* fall back to the CPU path below */}
    }else useSelfHostedWasm();
  }else useSelfHostedWasm();
  stage('cpu');
  return {tts:await KokoroTTS.from_pretrained(MODEL,{dtype:'q8',device:'wasm',progress_callback:progress}),device:'wasm' as const};
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
      const {tts,device}=await load(prefer??'wasm');
      if(type==='load'){self.postMessage({id,type:'ready',device});return;}
      self.postMessage({id,type:'begin'});
      const profile=voiceProfile(speaker);
      const result=await tts.generate(spokenText(text),{voice:profile.voice,speed:profile.rate});
      const audio=Float32Array.from(Array.isArray(result.audio)?result.audio[0]:result.audio);
      if(!audible(audio))throw new Error('Voice generation returned silent or invalid audio. Try reloading the headset.');
      self.postMessage({id,type:'audio',audio,rate:result.sampling_rate},{transfer:[audio.buffer]});
    }catch(e){self.postMessage({id,type:'error',error:e instanceof Error?e.message:String(e)});}
  });
};
