import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RadioVoice} from '../src/radio.ts';
import {spokenText,voiceProfile} from '../src/radio-profile.ts';
class FakeWorker {
  static last:FakeWorker;onmessage:any;onerror:any;requests:any[]=[];
  constructor(){FakeWorker.last=this;}
  postMessage(data:any){this.requests.push(data);}
  terminate(){}
  reply(data:any){this.onmessage({data});}
}
class Node {
  frequency={value:0};gain={value:0};threshold={value:0};knee={value:0};ratio={value:0};attack={value:0};release={value:0};onended:any;
  connect(){return this;}disconnect(){}start(){}stop(){this.onended?.();}
}
class Context {
  state='running';destination={};resume(){return Promise.resolve();}
  createBuffer(){return {copyToChannel(){}};}createBufferSource(){return new Node();}createBiquadFilter(){return new Node();}createDynamicsCompressor(){return new Node();}createGain(){return new Node();}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){Object.assign(globalThis,{Worker:FakeWorker,AudioContext:Context});const radio=new RadioVoice();radio.enabled=true;return radio;}
test('background preload warms voices once without creating an audio context or starting playback',async()=>{
  Object.assign(globalThis,{Worker:FakeWorker,AudioContext:class {constructor(){throw new Error('autoplay before gesture');}}});
  const radio=new RadioVoice();let aired=false;radio.onAir=()=>{aired=true;};
  const first=radio.preload(),second=radio.preload();
  assert.equal(first,second);
  const worker=FakeWorker.last;assert.equal(worker.requests.length,1);
  worker.reply({id:worker.requests[0].id,type:'ready',device:'wasm'});await first;
  await radio.preload();assert.equal(worker.requests.length,1);
  assert.equal(radio.ready,true);assert.equal(radio.enabled,false);assert.equal(aired,false);
  Object.assign(globalThis,{AudioContext:Context});
});
test('radio calls pronounce driver codes, positions and timing units',()=>{assert.equal(spokenText('LAU P2 · REY 2.4s'),'Theo position 2 , Nico 2.4 seconds');});
test('all five team members have stable, distinct neural voices',()=>{assert.equal(new Set(['LAU','REY','STRATEGIST','TYRE SPECIALIST','DATA ENGINEER'].map(s=>voiceProfile(s).voice)).size,5);});
test('interrupt during inference never plays the stale response',async()=>{
  const radio=setup();let air=0;radio.onAir=()=>air++;radio.say('Box now.','LAU');const worker=FakeWorker.last;
  worker.reply({id:worker.requests[0].id,type:'ready'});await flush();const inference=worker.requests.at(-1);assert.equal(inference.type,'speak');radio.interrupt();
  worker.reply({id:inference.id,type:'audio',audio:new Float32Array(24000),rate:24000});await flush();assert.equal(air,0);
});
test('audio off during model loading prevents a synthesis request',async()=>{
  const radio=setup();radio.say('Box now.','LAU');const worker=FakeWorker.last;radio.enabled=false;radio.interrupt();worker.reply({id:worker.requests[0].id,type:'ready'});await flush();assert.equal(worker.requests.length,1);
});
test('ready voice plays PCM and interruption stops it without a stuck queue',async()=>{
  const radio=setup();let air=0;radio.onAir=()=>air++;radio.say('Copy.','REY');const worker=FakeWorker.last;worker.reply({id:worker.requests[0].id,type:'ready'});await flush();worker.reply({id:worker.requests.at(-1).id,type:'audio',audio:new Float32Array(24000),rate:24000});await flush();assert.equal(air,1);radio.interrupt();await flush();radio.say('Copy.','REY');await flush();assert.equal(air,2);radio.interrupt();
});
test('a model error is visible and a later load can retry',async()=>{
  const radio=setup();const statuses:string[]=[];radio.onStatus=t=>statuses.push(t);
  const first=radio.prepare();const worker=FakeWorker.last;worker.reply({id:worker.requests.at(-1).id,type:'error',error:'Download failed'});
  await assert.rejects(first,/Download failed/);assert.match(statuses.at(-1)!,/Voices unavailable/);
  const second=radio.prepare();worker.reply({id:worker.requests.at(-1).id,type:'ready'});await second;assert.equal(radio.ready,true);
});
test('every role on the radio has its own voice',()=>{assert.equal(new Set(['LAU','REY','STRATEGIST','TYRE SPECIALIST','DATA ENGINEER','RACE CONTROL','PIT CREW'].map(s=>voiceProfile(s).voice)).size,7);});
test('lines go stale in race time and urgent lines jump the queue',async()=>{
  const radio=setup();let now=0;radio.clock=()=>now;const aired:string[]=[];radio.onAir=(_s,t)=>aired.push(t);
  radio.line({text:'Old gap update.',speaker:'DATA ENGINEER',priority:1,at:0,ttl:10});
  radio.line({text:'Safety car!',speaker:'RACE CONTROL',priority:3,at:0,ttl:30});
  const worker=FakeWorker.last;worker.reply({id:worker.requests[0].id,type:'ready'});await flush();
  const speak=worker.requests.filter(r=>r.type==='speak');assert.equal(speak.length,2);
  const gap=speak.find(r=>r.text==='Old gap update.'),safety=speak.find(r=>r.text==='Safety car!');
  worker.reply({id:gap.id,type:'audio',audio:new Float32Array(240),rate:24000});await flush();
  assert.deepEqual(aired,[],'the urgent line is still synthesising, so nothing airs yet');
  worker.reply({id:safety.id,type:'audio',audio:new Float32Array(240),rate:24000});await flush();
  assert.deepEqual(aired,['Safety car!']);
  now=20;(radio as any).source.stop();await flush();
  assert.deepEqual(aired,['Safety car!'],'the gap update went stale in race time and never airs');
});
test('keying the mic cancels queued synthesis in the worker',async()=>{
  const radio=setup();radio.say('One.','LAU');radio.say('Two.','REY');
  const worker=FakeWorker.last;worker.reply({id:worker.requests[0].id,type:'ready'});await flush();
  const ids=worker.requests.filter(r=>r.type==='speak').map(r=>r.id);assert.equal(ids.length,2);
  radio.interrupt();const cancel=worker.requests.at(-1);
  assert.equal(cancel.type,'cancel');assert.deepEqual([...cancel.ids].sort(),[...ids].sort());
});
test('failed synthesis is dropped and the next transmission can play',async()=>{
  const radio=setup();let air=0;radio.onAir=()=>air++;
  radio.say('First call.','LAU');const worker=FakeWorker.last;
  worker.reply({id:worker.requests[0].id,type:'ready'});await flush();
  worker.reply({id:worker.requests.at(-1).id,type:'error',error:'synthesis failed'});await flush();
  radio.say('Second call.','REY');await flush();
  worker.reply({id:worker.requests.at(-1).id,type:'audio',audio:new Float32Array(24000),rate:24000});await flush();
  assert.equal(air,1);radio.interrupt();
});
test('instant team cues ship with non-empty WAV audio',async()=>{
  const {readFile}=await import('node:fs/promises');const {RADIO_CUES}=await import('../src/radio-cues.ts');
  for(const cue of RADIO_CUES){const data=await readFile(new URL(`../public/audio/team/${cue.file}.wav`,import.meta.url));assert.equal(data.toString('ascii',0,4),'RIFF');assert.equal(data.toString('ascii',8,12),'WAVE');assert(data.length>16000,cue.file);}
});
test('long lines are spoken sentence by sentence; short acknowledgements stay attached',async()=>{
  const {sentences}=await import('../src/radio.ts');
  assert.deepEqual(sentences('Nico, Keller is 1.9 ahead. You’re P5. Keep pushing!'),['Nico, Keller is 1.9 ahead.','You’re P5. Keep pushing!']);
  assert.deepEqual(sentences('Copy. Box this lap, mediums.'),['Copy. Box this lap, mediums.']);
  assert.deepEqual(sentences('Gap is 1.2 seconds.'),['Gap is 1.2 seconds.']);
  assert.deepEqual(sentences('Box this lap, mediums. Copy.'),['Box this lap, mediums. Copy.']);
  assert.deepEqual(sentences('Engineer, I’d box Theo this lap for mediums. Box him?'),['Engineer, I’d box Theo this lap for mediums. Box him?']);
});
test('lap times are spoken as racing engineers say them',()=>{assert.equal(spokenText('Nico, personal best. 1:24.'),'Nico, personal best. 1 24.');});
test('a silent GPU render is detected so the radio falls back to the CPU voice',async()=>{
  const {audible}=await import('../src/radio-audio.ts');
  assert.equal(audible(new Float32Array(24000)),false);assert.equal(audible(new Float32Array(24000).fill(.05)),true);
});
test('headset keeps racing at real time during synthesis and playback, restoring acceleration when idle',async()=>{
  const radio=setup();assert.equal(radio.pace(60),60);
  radio.say('Live report.','DATA ENGINEER');assert.equal(radio.pace(60),1);
  const worker=FakeWorker.last;worker.reply({id:worker.requests[0].id,type:'ready'});await flush();
  assert.equal(radio.buffering,true);
  let elapsed=0; for(let second=0;second<45;second++)elapsed+=radio.pace(60);
  assert.equal(elapsed,45,'an unresponsive renderer cannot freeze the simulation');
  radio.blocked=true;assert.equal(radio.pace(60),0,'microphone capture still holds the race');radio.blocked=false;
  worker.reply({id:worker.requests.at(-1).id,type:'audio',audio:new Float32Array(24000),rate:24000});await flush();
  assert.equal(radio.pace(60),1);(radio as any).source.stop();await flush();assert.equal(radio.pace(60),60);
  radio.enabled=false;radio.blocked=true;assert.equal(radio.pace(60),60);
});
test('wall time alone does not erase a still-relevant report',async()=>{
  const radio=setup();const original=Date.now;let wall=0;Date.now=()=>wall;
  try{let aired=0;radio.onAir=()=>aired++;radio.say('Still relevant.','LAU');const worker=FakeWorker.last;
    worker.reply({id:worker.requests[0].id,type:'ready'});await flush();wall=45000;
    worker.reply({id:worker.requests.at(-1).id,type:'audio',audio:new Float32Array(24000),rate:24000});await flush();assert.equal(aired,1);radio.interrupt();
  }finally{Date.now=original;}
});
test('long turns prefetch their first sentence rather than flooding the worker',async()=>{
  const radio=setup();radio.say('First sentence is long enough. Second sentence is also long enough. Third sentence completes the call.','LAU');
  const worker=FakeWorker.last;worker.reply({id:worker.requests[0].id,type:'ready'});await flush();
  assert.equal(worker.requests.filter(r=>r.type==='speak').length,1);
  worker.reply({id:worker.requests.at(-1).id,type:'audio',audio:new Float32Array(24000),rate:24000});await flush();
  assert.equal(worker.requests.filter(r=>r.type==='speak').length,2);radio.interrupt();
});
// Safari 26 offers WebGPU, but the GPU voice path can sit silent there; the start must never wait on it forever.
function withGpu(fn:(store:Map<string,string>)=>Promise<void>){
  const store=new Map<string,string>();
  const storage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>void store.set(k,v)};
  Object.defineProperty(globalThis.navigator,'gpu',{value:{},configurable:true});
  Object.defineProperty(globalThis,'localStorage',{value:storage,configurable:true});
  return fn(store).finally(()=>{delete (globalThis.navigator as any).gpu;delete (globalThis as any).localStorage;});
}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('a stalled GPU voice load falls back to the CPU voices and remembers it for this browser',()=>withGpu(async store=>{
  const radio=setup();radio.stallMs=30;const statuses:string[]=[];radio.onStatus=t=>statuses.push(t);
  const loading=radio.prepare();const gpuWorker=FakeWorker.last;
  assert.equal(gpuWorker.requests[0].prefer,'webgpu');
  gpuWorker.reply({type:'stage',stage:'gpu'});await wait(60);
  const cpuWorker=FakeWorker.last;assert.notEqual(cpuWorker,gpuWorker);assert.equal(cpuWorker.requests[0].prefer,'wasm');
  assert.ok(statuses.some(s=>/switching to CPU voices/.test(s)));
  cpuWorker.reply({id:cpuWorker.requests[0].id,type:'ready',device:'wasm'});await loading;
  assert.equal(radio.ready,true);assert.equal(radio.device,'wasm');
  assert.equal(store.get('pitwall.voice.cpu'),navigator.userAgent);
  // Next session in the same browser skips the GPU attempt.
  const next=setup();const nextLoad=next.prepare();assert.equal(FakeWorker.last.requests[0].prefer,'wasm');
  FakeWorker.last.reply({id:FakeWorker.last.requests[0].id,type:'ready',device:'wasm'});await nextLoad;
}));
test('a GPU voice download that keeps reporting progress is not mistaken for a stall',()=>withGpu(async store=>{
  const radio=setup();radio.stallMs=40;const loading=radio.prepare();const worker=FakeWorker.last;
  for(let i=0;i<6;i++){await wait(15);worker.reply({type:'progress',progress:i*20});}
  assert.equal(FakeWorker.last,worker);
  worker.reply({id:worker.requests[0].id,type:'ready',device:'webgpu'});await loading;
  assert.equal(radio.device,'webgpu');assert.equal(store.has('pitwall.voice.cpu'),false);
  await wait(60);assert.equal(FakeWorker.last,worker);
}));
test('with text radio until the voices load, an unvoiced line never holds the race',async()=>{
  const radio=setup();radio.textUntilReady=true;const before=FakeWorker.last;
  radio.say('Box this lap, Theo. Mediums.','STRATEGIST');
  assert.equal(radio.busy,false);assert.equal(radio.pace(15),15);assert.equal(FakeWorker.last,before);
});
