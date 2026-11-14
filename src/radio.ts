import {voiceProfile} from './radio-profile.ts';
import {radioCue} from './radio-cues.ts';
import type {LocalModels} from './local-models.ts';
import {BASE} from './base.ts';
import {weightsProgress} from './team-setup.ts';
import type {Downloads} from './team-setup.ts';
export {voiceProfile} from './radio-profile.ts';

/** A line offered to the radio. `at` and `ttl` are race seconds, so staleness follows the race, not the wall clock. */
export interface RadioLine {text:string;speaker:string;priority:number;at:number;ttl:number}
type Clip={audio:Float32Array;rate:number};
interface Part {text:string;request?:number;clip?:Promise<Clip>}
interface Item extends RadioLine {parts:Part[]}

const MAX_QUEUE=12;        // anything further back would be stale by the time it played
const PREFETCH=2;         // synthesise the next line while the current one plays
const CACHE_SIZE=96;
const STALLED='GPU voices stalled';
const TIMED_OUT='A radio voice took too long to render.';
const AUDIO_SUSPENDED='Audio output is paused by the system. Toggle Audio off, then on.';
const MAX_RECOVERIES=3;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const STAGES={gpu:'Starting voices on this device’s GPU…',probe:'Testing the radio voices…',cpu:'Loading CPU voices · replies may lag'};
// A browser whose GPU voices stalled once goes straight to the CPU voices next time. Keyed to the
// user agent, so a browser update gets a fresh try.
const CPU_KEY='pitwall.voice.cpu';
function store(){try{return typeof localStorage==='undefined'?null:localStorage;}catch{return null;}}
function gpuAllowed(){return typeof navigator!=='undefined'&&'gpu' in navigator&&store()?.getItem(CPU_KEY)!==navigator.userAgent;}
function preferCpu(){try{store()?.setItem(CPU_KEY,navigator.userAgent);}catch{/* private mode */}}

/**
 * Long lines are spoken sentence by sentence, so the first sentence airs as soon as it is
 * rendered instead of waiting for the whole line. Fragments like “Copy.” stay attached to the
 * next sentence to keep the delivery natural.
 */
export function sentences(text:string):string[]{
  const raw=text.split(/(?<=[.!?…])\s+(?=[A-Z0-9“"])/);
  const parts:string[]=[];
  for(const piece of raw){
    if(parts.length&&parts[parts.length-1].length<12)parts[parts.length-1]+=' '+piece;
    else parts.push(piece);
  }
  // A short closing fragment (“Copy.”, “Box him?”) rides with the sentence before it: each render has a fixed GPU cost.
  if (parts.length > 1 && parts[parts.length - 1].length < 12) parts[parts.length - 2] += ' ' + parts.pop();
  return parts;
}

/**
 * The radio director: decides what goes on air. Highest priority first, stale lines dropped,
 * the next clip prepared while the current one plays, and queued work cancelled when the
 * player keys the mic.
 */
export class RadioVoice {
  enabled=false;blocked=false;ready=false;
  /** Until the live voices load, play only the bundled clips and leave every other line as text, so nothing holds the race. */
  textUntilReady=false;
  /** Give up on the GPU voices after this long without any sign of progress, and load the CPU voices instead. */
  stallMs=20000;
  /** One render's time limit, counted from when the worker starts it, not while it waits its turn. */
  renderMs=60000;
  /** How long past a clip's length to wait for it to end before treating the audio output as stalled. */
  playSlackMs=2000;
  /** False on phones and weak devices: nothing is downloaded; recorded team clips play and every other line stays text. */
  neural=true;
  /** Download progress of the voice model, 0–1, for the setup screen. */
  progress=0;
  /** Model files saved on this computer, if the page looked for them (resolved before the first load). */
  local:Promise<LocalModels|null>|null=null;
  private onDisk:LocalModels|null=null;
  /** Where voices render: the GPU when the browser offers WebGPU, otherwise the CPU (about 3x slower than speech). */
  device:'webgpu'|'wasm'|null=null;
  /** Current race time in seconds. */
  clock:()=>number=()=>0;
  onAir:(speaker:string,text:string)=>void=()=>{};onSilent:()=>void=()=>{};
  onStatus:(text:string,error?:boolean)=>void=()=>{};
  private queue:Item[]=[];private current:Item|null=null;private speaking=false;private generation=0;
  private worker:Worker|null=null;private serial=0;private loading:Promise<void>|null=null;
  private watchdog:ReturnType<typeof setTimeout>|null=null;private stage='';
  private downloads:Downloads=new Map();private everReady=false;private recoveries=0;private failures=0;
  private pending=new Map<number,{resolve:(clip:Clip)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private context:AudioContext|null=null;private source:AudioBufferSourceNode|null=null;
  private cache=new Map<string,Clip>();
  /** Something is on air or waiting to be. */
  get busy(){return this.speaking||this.queue.length>0;}
  /** Slow to real time while rendering; speech generation must never stop the race. */
  get buffering(){return this.busy&&this.source===null;}
  pace(requested:number){return !this.enabled?requested:this.blocked?0:this.busy?1:requested;}

  unlock(){
    if(!this.context){
      const context=new AudioContext();this.context=context;
      // Safari suspends or interrupts output (headphones switched, another app took audio): take it back.
      context.onstatechange=()=>{const state=context.state as string;if(this.enabled&&(state==='suspended'||state==='interrupted'))void context.resume().catch(()=>{});};
    }
    void this.context.resume().catch(()=>this.onStatus('Click Audio on to enable playback.',true));
  }
  private request(type:'load'|'speak',text='',speaker='ENGINEER',onId?:(id:number)=>void,prefer?:'webgpu'|'wasm'):Promise<Clip>{
    if(!this.worker){
      this.worker=new Worker(new URL('./radio-worker.ts',import.meta.url),{type:'module'});
      this.worker.onmessage=({data})=>{
        if(data.type==='progress'||data.type==='stage'){
          if(this.watchdog)this.arm();
          if(data.type==='stage'){this.stage=data.stage;if(data.stage==='cpu'){this.downloads.clear();this.progress=0;}}
          else{this.downloads.set(String(data.file),{loaded:data.loaded??0,total:data.total??0});this.progress=weightsProgress(this.downloads);}
          // Progress also counts files read from the browser cache, so it says loading, not downloading.
          if(!this.ready)this.onStatus(data.type==='stage'?STAGES[data.stage as keyof typeof STAGES]:`Loading ${this.stage==='cpu'?'CPU ':''}neural voices${this.onDisk?' from this computer':''} · ${Math.round(this.progress*100)}%`);
          return;
        }
        if(data.type==='begin'){
          // Time the render itself; waiting behind earlier lines (slow on the CPU) is not a failure.
          const p=this.pending.get(data.id);if(p){clearTimeout(p.timer);p.timer=setTimeout(()=>this.dropOut(TIMED_OUT),this.renderMs);}
          return;
        }
        if(data.type==='ready')this.device=data.device??'wasm';
        const p=this.pending.get(data.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(data.id);
        if(data.type==='error')p.reject(new Error(data.error));else p.resolve({audio:data.audio,rate:data.rate});
      };
      this.worker.onerror=()=>this.dropOut('The neural voice worker stopped.');
    }
    const id=++this.serial;onId?.(id);
    return new Promise((resolve,reject)=>{
      // Loads get four minutes; a render is re-timed when the worker starts it (see 'begin').
      const timer=setTimeout(()=>this.dropOut(type==='load'?'Neural voice loading timed out.':TIMED_OUT),type==='load'?240000:300000);
      this.pending.set(id,{resolve,reject,timer});this.worker!.postMessage({id,type,text,speaker,prefer,local:type==='load'?this.onDisk:undefined});
    });
  }
  private cancel(ids:number[]){
    const live=[...new Set(ids)].filter(id=>this.pending.has(id));
    if(!live.length)return;
    for(const id of live){const p=this.pending.get(id)!;clearTimeout(p.timer);this.pending.delete(id);p.reject(new Error('cancelled'));}
    this.worker?.postMessage({type:'cancel',ids:live});
  }
  private resetWorker(reason:string){
    this.stopWorker(reason);this.ready=false;this.loading=null;
  }
  private stopWorker(reason:string){
    this.disarm();this.worker?.terminate();this.worker=null;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}this.pending.clear();
  }
  /**
   * The voices broke mid-race: a render timed out, the worker stopped, or renders keep failing.
   * Lines stay on screen as text (textUntilReady) while the voices reload in the background.
   */
  private dropOut(reason:string){
    const device=this.device;
    this.resetWorker(reason);
    if(!this.everReady||!this.enabled)return;
    if(this.recoveries>=MAX_RECOVERIES){this.onStatus('Voices keep failing in this browser · text radio continues. Toggle Audio off and on to try again.',true);return;}
    this.recoveries++;
    // Dropping out twice on the GPU: the CPU voices are slower but steadier.
    if(device==='webgpu'&&this.recoveries>=2)preferCpu();
    this.onStatus('Radio dropped out · reconnecting the voices; team radio shows as text meanwhile');
    void this.preload().catch(()=>{/* status shows the failure */});
  }
  private arm(){this.disarm();this.watchdog=setTimeout(()=>{this.watchdog=null;this.stopWorker(STALLED);},this.stallMs);}
  private disarm(){if(this.watchdog)clearTimeout(this.watchdog);this.watchdog=null;}
  /** Load the voices on the GPU if the browser offers one; if that stalls or fails, use the CPU voices. */
  private async open(){
    if(this.local)this.onDisk=await this.local;
    this.onStatus(this.onDisk?'Loading neural voices from this computer…':'Loading neural voices · the first visit downloads about 90 MB on CPU, 310 MB with a GPU');
    if(gpuAllowed()){
      this.arm();
      try{
        await this.request('load','','ENGINEER',undefined,'webgpu');
        // The worker fell back to the CPU itself (GPU error or silent audio): skip the GPU next time.
        if(this.device!=='webgpu')preferCpu();
        return;
      }catch(e){
        if(!(e instanceof Error&&e.message===STALLED))throw e;
        preferCpu();this.stage='cpu';this.downloads.clear();this.progress=0;this.onStatus('GPU voices stalled in this browser · switching to CPU voices');
      }finally{this.disarm();}
    }
    await this.request('load','','ENGINEER',undefined,'wasm');
  }
  async connect(){
    this.unlock();
    const text='Team, radio check. Theo, Nico. Talk to us.';
    this.remember(this.key('STRATEGIST',text),await this.loadCue('james-opening'));
    this.onStatus(this.neural?'Team radio connected · live reports load on this device':'Team radio connected · text radio with recorded team clips');
    // Start loading the live voices now, so the first unscripted line is not stuck behind the download.
    await this.prepare();
  }
  prepare():Promise<void>{
    this.unlock();
    // An explicit request (start, Audio on, voice preview) gets a fresh set of recoveries.
    this.recoveries=0;
    return this.preload();
  }
  /** Warm the model on page load without requesting audio playback before a user gesture. */
  preload():Promise<void>{
    if(this.ready||!this.neural)return Promise.resolve();
    if(!this.loading){
      this.onStatus('Loading neural voices…');
      this.loading=this.open().then(()=>{this.ready=true;this.everReady=true;this.failures=0;this.onStatus(this.device==='webgpu'?'Neural radio ready · rendered on this device’s GPU':'Neural radio ready · CPU mode, replies may lag');}).catch(e=>{this.loading=null;this.onStatus(`Voices unavailable: ${e.message}`,true);throw e;});
    }
    return this.loading;
  }
  /** Make sure audio output is running before (and after) a clip; Safari can suspend it at any time. */
  private async wake(ctx:AudioContext){
    if(ctx.state==='running')return;
    await Promise.race([ctx.resume().catch(()=>{}),wait(1500)]);
    // resume() may have changed the state since the check above.
    if((ctx.state as string)!=='running')throw new Error(AUDIO_SUSPENDED);
  }
  private key(speaker:string,text:string){return voiceProfile(speaker).voice+':'+text;}
  private remember(key:string,clip:Clip){
    this.cache.delete(key);this.cache.set(key,clip);
    if(this.cache.size>CACHE_SIZE)this.cache.delete(this.cache.keys().next().value!);
  }
  private stale(item:Item){return this.clock()-item.at>item.ttl;}
  /** Start synthesis for the items that will play soonest, first sentence first. */
  private prefetch(){
    // Only the first sentence of each upcoming turn. Rendering every sentence at once
    // queued enough work to hit timeouts before later teammates got their first word.
    for(const item of this.queue.slice(0,PREFETCH))this.renderPart(item,item.parts[0]);
  }
  private renderPart(item:Item,part:Part){
    if(part.clip)return;
    const key=this.key(item.speaker,part.text),cached=this.cache.get(key);
    if(cached){part.clip=Promise.resolve(cached);return;}
    const generation=this.generation,cue=radioCue(item.speaker,part.text);
    const render=()=>this.prepare().then(()=>{
      if(generation!==this.generation)throw new Error('cancelled');
      return this.request('speak',part.text,item.speaker,id=>{part.request=id;});
    });
    part.clip=(cue?this.loadCue(cue.file).catch(()=>render()):render()).then(clip=>{this.remember(key,clip);return clip;});
    part.clip.catch(()=>{});
  }
  private async loadCue(file:string):Promise<Clip>{
    this.unlock();const response=await fetch(`${BASE}audio/team/${file}.wav`);if(!response.ok)throw new Error('Radio clip unavailable');
    const buffer=await this.context!.decodeAudioData(await response.arrayBuffer());
    return {audio:buffer.getChannelData(0),rate:buffer.sampleRate};
  }
  private drop(items:Item[]){this.cancel(items.flatMap(i=>i.parts.flatMap(p=>p.request?[p.request]:[])));}

  /** Offer a line to the radio. */
  line(l:RadioLine){
    if(!this.enabled||this.blocked)return;
    if((this.textUntilReady||!this.neural)&&!this.ready&&!radioCue(l.speaker,l.text))return;
    // A pre-rendered cue covers the whole line; otherwise speak it sentence by sentence.
    const parts=(radioCue(l.speaker,l.text)?[l.text]:sentences(l.text)).map(text=>({text}));
    const item:Item={...l,parts};
    this.drop(this.queue.filter(i=>this.stale(i)));
    this.queue=this.queue.filter(i=>!this.stale(i));
    this.queue.push(item);
    this.queue.sort((a,b)=>b.priority-a.priority||a.at-b.at);
    if(this.queue.length>MAX_QUEUE)this.drop(this.queue.splice(MAX_QUEUE));
    this.prefetch();void this.next();
  }
  /** Convenience for previews and one-off calls. */
  say(text:string,speaker='ENGINEER',urgent=false){
    this.line({text,speaker,priority:urgent?3:['LAU','REY'].includes(speaker)?2:1,at:this.clock(),ttl:30});
  }
  interrupt(){
    this.generation++;
    this.drop(this.current&&!this.queue.includes(this.current)?[...this.queue,this.current]:this.queue);this.queue=[];this.current=null;this.speaking=false;
    if(this.source){this.source.stop();this.source=null;}
    // Retain the downloaded model, but never play a cancelled generation.
    this.onSilent();
  }
  private async next(){
    if(this.speaking||!this.queue.length||!this.enabled||this.blocked)return;
    const expired=this.queue.filter(i=>this.stale(i));this.drop(expired);
    this.queue=this.queue.filter(i=>!this.stale(i));
    this.prefetch();
    let item=this.queue[0];if(!item)return;
    this.speaking=true;this.current=item;const generation=this.generation;
    try{
      this.onStatus(`Preparing ${voiceProfile(item.speaker).short??item.speaker}’s radio · race continues at 1×`);
      // Wait for the head's first sentence. If a more urgent line was queued meanwhile, it goes first.
      let clip=await item.parts[0].clip!;
      for(;;){
        if(generation!==this.generation||!this.enabled||this.blocked)return;
        this.drop(this.queue.filter(i=>this.stale(i)));this.queue=this.queue.filter(i=>!this.stale(i));
        const head=this.queue[0];
        if(!head)return;
        if(head===item)break;
        item=head;this.current=item;this.prefetch();clip=await item.parts[0].clip!;
      }
      this.queue.shift();this.prefetch();
      const ctx=this.context!;
      await this.wake(ctx);
      const high=ctx.createBiquadFilter();high.type='highpass';high.frequency.value=340;
      const low=ctx.createBiquadFilter();low.type='lowpass';low.frequency.value=['LAU','REY'].includes(item.speaker)?3200:4200;
      const compressor=ctx.createDynamicsCompressor();compressor.threshold.value=-25;compressor.knee.value=12;compressor.ratio.value=4;compressor.attack.value=.003;compressor.release.value=.12;
      const gain=ctx.createGain();gain.gain.value=.85;
      high.connect(low).connect(compressor).connect(gain).connect(ctx.destination);
      this.onAir(item.speaker,item.text);this.onStatus((this.ready?'Neural radio · ':'Team radio · ')+voiceProfile(item.speaker).label);
      try{
        for(let i=0;i<item.parts.length;i++){
          if(i>0){this.renderPart(item,item.parts[i]);clip=await item.parts[i].clip!;}
          if(i+1<item.parts.length)this.renderPart(item,item.parts[i+1]);
          if(generation!==this.generation)return;
          const buffer=ctx.createBuffer(1,clip.audio.length,clip.rate);buffer.copyToChannel(new Float32Array(clip.audio),0);
          const source=ctx.createBufferSource();source.buffer=buffer;this.source=source;source.connect(high);
          // If the clip never reports its end (Safari paused the output), move on rather than hold the radio forever.
          let stalled=false;
          await new Promise<void>(resolve=>{
            const finish=()=>{clearTimeout(guard);source.onended=null;source.disconnect();if(this.source===source)this.source=null;resolve();};
            const guard=setTimeout(()=>{stalled=true;try{source.stop();}catch{/* already stopped */}finish();},clip.audio.length/clip.rate*1000+this.playSlackMs);
            source.onended=finish;source.start();
          });
          if(stalled)await this.wake(ctx);
        }
        this.failures=0;
      }finally{high.disconnect();low.disconnect();compressor.disconnect();gain.disconnect();}
    }catch(e){
      // A failed clip must leave the queue; retrying its rejected promise loops forever.
      if(generation===this.generation)this.queue=this.queue.filter(queued=>queued!==item);
      const message=e instanceof Error?e.message:String(e);
      if(generation===this.generation&&message!=='cancelled'){
        // Two failed renders in a row means the voice model itself is broken (for example, a lost GPU): rebuild it.
        if(message!==AUDIO_SUSPENDED&&this.ready&&++this.failures>=2){this.failures=0;this.dropOut(message);}
        else if(!this.loading||this.ready)this.onStatus(`Radio unavailable: ${message}`,true);
      }
    }
    finally{if(generation===this.generation){this.speaking=false;this.current=null;this.onSilent();void this.next();}}
  }
}
export interface Recognition {
  lang:string;continuous:boolean;interimResults:boolean;
  onstart:(()=>void)|null;
  onresult:((event:{resultIndex:number;results:{length:number;[key:number]:{isFinal:boolean;[key:number]:{transcript:string}}}})=>void)|null;
  onerror:((event:{error:string})=>void)|null;onend:(()=>void)|null;
  start():void;stop():void;abort():void;
}
export function recognitionConstructor():(new()=>Recognition)|undefined {
  const w=window as unknown as {SpeechRecognition?:new()=>Recognition;webkitSpeechRecognition?:new()=>Recognition};return w.SpeechRecognition??w.webkitSpeechRecognition;
}
