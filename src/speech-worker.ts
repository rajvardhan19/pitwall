import { env, AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration } from '@huggingface/transformers';
import type { PreTrainedTokenizer, Processor } from '@huggingface/transformers';
import { SPEECH_PROMPT } from './speech-prompt.ts';
import { routeToLocal } from './local-models.ts';
import {BASE} from './base.ts';
import type { LocalModels } from './local-models.ts';
env.allowLocalModels=false;
// One thread works without cross-origin isolation and keeps the UI responsive in a worker.
if(env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads=1;
  // The smaller synchronous runtime runs inside this worker, on our own origin.
  env.backends.onnx.wasm.wasmPaths={mjs:new URL(`${BASE}voice-runtime/ort-wasm-simd-threaded.mjs`,self.location.origin).href,wasm:new URL(`${BASE}voice-runtime/ort-wasm-simd-threaded.wasm`,self.location.origin).href};
}
const MODEL='onnx-community/whisper-tiny.en';
interface Transcriber { processor: Processor; tokenizer: PreTrainedTokenizer; model: WhisperForConditionalGeneration; start: number[] }
let transcriber: Transcriber | null = null;
let loading: Promise<void> | null = null;
async function load() {
  if(transcriber)return;
  if(!loading) loading=(async()=>{
    const progress_callback=(p:{status:string;progress?:number;file?:string})=>{if('progress' in p)self.postMessage({type:'progress',file:p.file??'model',progress:p.progress});};
    const [processor,tokenizer,model]=await Promise.all([
      AutoProcessor.from_pretrained(MODEL,{progress_callback}),
      AutoTokenizer.from_pretrained(MODEL,{progress_callback}),
      WhisperForConditionalGeneration.from_pretrained(MODEL,{device:'wasm',dtype:'q8',progress_callback}) as Promise<WhisperForConditionalGeneration>,
    ]);
    // The decoder starts from the radio vocabulary as "previous text". On 400 synthetic race calls
    // (8 English voices, clean and with background noise) the right command went from 52% to 86%
    // clean and 26% to 64% noisy. A bigger model (base.en) without it did no better than tiny.en.
    const [previous,transcript,noTimestamps]=tokenizer.convert_tokens_to_ids(['<|startofprev|>','<|startoftranscript|>','<|notimestamps|>']) as number[];
    const start=[previous,...tokenizer.encode(SPEECH_PROMPT,{add_special_tokens:false}),transcript,noTimestamps];
    transcriber={processor,tokenizer,model,start};
  })().catch(error=>{loading=null;throw error;});
  await loading;
}
async function transcribe(audio:Float32Array) {
  const {processor,tokenizer,model,start}=transcriber!;
  const {input_features}=await processor(audio);
  const output=await model.generate({inputs:input_features,decoder_input_ids:start,max_new_tokens:64} as Parameters<typeof model.generate>[0]) as {tolist():(number|bigint)[][]};
  // The output repeats the prompt; only the tokens after it are what the player said.
  const ids=output.tolist()[0].map(Number).slice(start.length);
  return tokenizer.decode(ids,{skip_special_tokens:true}).trim();
}
self.onmessage=async(event:MessageEvent<{id:number;type:'load'|'transcribe';audio?:Float32Array;local?:LocalModels|null}>)=>{
  const {id,type,audio,local}=event.data;
  try {
    // Saved model files load from this computer (npm run models); anything missing still downloads.
    if(type==='load')routeToLocal(local??null,env,[`${MODEL}/onnx/encoder_model_quantized.onnx`,`${MODEL}/onnx/decoder_model_merged_quantized.onnx`]);
    await load();
    if(type==='load'){self.postMessage({id,type:'ready'});return;}
    if(!audio?.length)throw new Error('No audio received.');
    self.postMessage({id,type:'result',text:await transcribe(audio)});
  }catch(error){self.postMessage({id,type:'error',error:error instanceof Error?error.message:String(error)});}
};
