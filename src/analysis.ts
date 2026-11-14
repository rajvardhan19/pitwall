import {createRace,step,applyCommand,playerCar,order,replay,wetness,slickFor,lapsLeftOn} from './sim.ts';
import type {Race,Compound,Command,RaceSetup} from './sim.ts';
import {onTarget} from './race-view.ts';
export type Schedule=Race['decisions'];
export interface Result {positions:number[];times:number[];stops:number[];points:number;objectives:number}
export interface StrategyResult {name:string;result:Result;calls:Schedule;plan:string}
export interface Alternative {index:number;car:number;action:string;direction:'earlier'|'later';originalAt:number;shiftedAt:number|null;result:Result|null;secondsGained:number|null;note:string}
export interface DebriefAnalysis {actual:Result;baseline:StrategyResult;best:StrategyResult;candidates:number;alternatives:Alternative[];method:string}
const POINTS=[25,18,15,12,10,8,6,4,2,1];
export function summarize(r:Race):Result {
  if(r.status!=='finished')throw new Error('Analysis requires a completed race.');
  const sorted=order(r),cars=[playerCar(r,1)!,playerCar(r,2)!];
  const positions=cars.map(c=>sorted.findIndex(x=>x.id===c.id)+1);
  return {positions,times:cars.map(c=>c.finishedAt!),stops:cars.map(c=>c.stops),points:positions.reduce((sum,p)=>sum+(POINTS[p-1]??0),0),objectives:Number(onTarget(r,1,positions[0]))+Number(onTarget(r,2,positions[1]))};
}
function simulate(setup:RaceSetup|number,policy:(r:Race)=>void):Race {
  const r=createRace(setup);r.status='running';
  while(r.status==='running'&&r.tick<40000){policy(r);step(r);}
  if(r.cars.some(car=>car.finishedAt===null))throw new Error('Replay did not finish within the simulation limit.');
  return r;
}
/** A pit-wall policy for one car: when to stop, what to fit, and when to switch for rain. */
interface Policy {threshold:number;prefer:'auto'|Compound;interAt:number;slickAt:number}
const ENGINEER:Policy={threshold:0.78,prefer:'auto',interAt:0.3,slickAt:0.2};
function applyPolicy(r:Race,number:1|2,p:Policy){
  const car=playerCar(r,number)!;
  if(car.finishedAt!==null||car.pitRemaining||car.pitOrder)return;
  const left=r.config.totalLaps-car.distance;
  if(left<=3)return;
  if(r.config.weather){
    const wet=wetness(r);
    if(car.compound!=='inter'&&wet>p.interAt){applyCommand(r,{car:number,action:'pit',compound:'inter'});return;}
    if(car.compound==='inter'){if(wet<p.slickAt)applyCommand(r,{car:number,action:'pit',compound:slickFor(r,left)});return;}
  }
  // Stop only when this set will not reach the flag; take the cheap stop under a safety car.
  if(car.wear>=(r.flag==='safety'?.5:p.threshold)&&lapsLeftOn(r,car)<left){
    const compound=p.prefer==='auto'?slickFor(r,left):p.prefer;
    applyCommand(r,{car:number,action:'pit',compound});
  }
}
/** One tick of the default engineer for both cars: used for the debrief benchmark and simulated season rounds. */
export function engineerStep(r:Race){applyPolicy(r,1,ENGINEER);applyPolicy(r,2,ENGINEER);}
export function defaultStrategy(setup:RaceSetup|number):StrategyResult {
  const r=simulate(setup,r=>{applyPolicy(r,1,ENGINEER);applyPolicy(r,2,ENGINEER);});
  return {name:'Default engineer',result:summarize(r),calls:r.decisions,plan:`Balanced pace. Pit at 78% tyre wear, or 50% under the safety car, when the tyres will not reach the flag; fit mediums if they reach the finish, otherwise hards.${r.config.weather?' Switch to inters above 30% track wetness and back to slicks below 20%.':''} Stay out for the final three laps.`};
}
export function better(a:Result,b:Result) {
  // Honour the scenario objectives, then constructor points, then combined finish time.
  return a.objectives>b.objectives || a.objectives===b.objectives&&(a.points>b.points || a.points===b.points&&a.times.reduce((x,y)=>x+y,0)<b.times.reduce((x,y)=>x+y,0));
}
interface Plan {lap:number;compound:Compound}
function plannedRace(setup:RaceSetup|number,plans:Plan[]):StrategyResult {
  const issued=new Set<number>();
  const r=simulate(setup,r=>{
    for(const number of [1,2]){
      const car=playerCar(r,number)!,plan=plans[number-1];
      if(!issued.has(number)&&car.distance>=plan.lap-1){applyCommand(r,{car:number,action:'pit',compound:plan.compound});issued.add(number);}
    }
  });
  return {name:'One-stop search',result:summarize(r),calls:r.decisions,plan:plans.map((p,i)=>`${i===0?'Theo':'Nico'}: box at end of lap ${p.lap} for ${p.compound}s`).join(' · ')+'. Balanced pace.'};
}
function describe(p:Policy,wet:boolean){
  const fit=p.prefer==='auto'?'mediums if they reach the flag, otherwise hards':`${p.prefer}s`;
  return `pit at ${Math.round(p.threshold*100)}% wear for ${fit}${wet?`, inters above ${Math.round(p.interAt*100)}% wetness, slicks below ${Math.round(p.slickAt*100)}%`:''}`;
}
function policyRace(setup:RaceSetup|number,policies:[Policy,Policy]):StrategyResult {
  const r=simulate(setup,r=>{applyPolicy(r,1,policies[0]);applyPolicy(r,2,policies[1]);});
  const wet=!!r.config.weather;
  return {name:'Policy search',result:summarize(r),calls:r.decisions,plan:`Theo: ${describe(policies[0],wet)} · Nico: ${describe(policies[1],wet)}. Balanced pace.`};
}
function commandName(command:Command) {return command.action==='pit'?`box for ${command.compound}s`:command.action==='stay'?'stay out':command.action==='swap'?'let teammate by':command.action;}
export function alternatives(setup:RaceSetup|number,decisions:Schedule,actual:Result):Alternative[] {
  // Capture each driver's original distance vs time. A lap is a distance delta of 1,
  // not a guessed 90 seconds (important during safety cars and pit stops).
  const r=createRace(setup);r.status='running';const traces:number[][]=[[],[]];let index=0;
  const distances:number[]=[];
  while(r.status==='running'&&r.tick<40000){
    traces[0][r.elapsed]=playerCar(r,1)!.distance;traces[1][r.elapsed]=playerCar(r,2)!.distance;
    while(index<decisions.length&&decisions[index].at<=r.elapsed){distances[index]=playerCar(r,decisions[index].command.car)!.distance;applyCommand(r,decisions[index].command);index++;}
    step(r);
  }
  const output:Alternative[]=[];
  for(let i=0;i<decisions.length;i++)for(const direction of ['earlier','later'] as const){
    const call=decisions[i],target=distances[i]+(direction==='earlier'?-1:1),trace=traces[call.command.car-1];
    const outside=!Number.isFinite(target)||target<trace[0]||target>=r.config.totalLaps;
    const shiftedAt=outside?-1:trace.findIndex(d=>d>=target);
    if(shiftedAt<0){output.push({index:i,car:call.command.car,action:commandName(call.command),direction,originalAt:call.at,shiftedAt:null,result:null,secondsGained:null,note:direction==='earlier'?'A lap earlier falls before this race begins.':'A lap later falls beyond this driver’s race.'});continue;}
    const shifted=decisions.map((d,j)=>({at:j===i?shiftedAt:d.at,command:{...d.command}})).sort((a,b)=>a.at-b.at);
    const alternativeRace=replay(setup,shifted),result=summarize(alternativeRace);
    const executed=alternativeRace.decisions.some(d=>d.at===shiftedAt&&JSON.stringify(d.command)===JSON.stringify(call.command));
    const crossed=decisions.some((d,j)=>j!==i&&d.command.car===call.command.car&&d.at>=Math.min(call.at,shiftedAt)&&d.at<=Math.max(call.at,shiftedAt));
    output.push({index:i,car:call.command.car,action:commandName(call.command),direction,originalAt:call.at,shiftedAt,result,secondsGained:actual.times[call.command.car-1]-result.times[call.command.car-1],note:!executed?'The shifted call could not execute in the altered race (for example, already in the pit lane).':crossed?'This shift crosses another call for this driver; their order and interaction change.':'Only this call moved. All other calls keep their original simulation times.'});
  }
  return output;
}
export function analyze(setup:RaceSetup|number,decisions:Schedule,progress?:(done:number,total:number)=>void):DebriefAnalysis {
  const race=createRace(setup),cfg=race.config;
  const actual=summarize(replay(setup,decisions)),baseline=defaultStrategy(setup);
  let best:StrategyResult={name:'Your strategy',result:actual,calls:structuredClone(decisions),plan:'Your recorded calls.'};
  if(better(baseline.result,best.result))best=baseline;
  const runs:(()=>StrategyResult)[]=[];
  const methods:string[]=[];
  if(cfg.startLap>0){
    // Late-race scenarios: every two-car one-stop plan over the next seven laps.
    const plans:Plan[]=[];for(let lap=cfg.startLap;lap<=cfg.startLap+6;lap++)for(const compound of ['soft','medium','hard'] as Compound[])plans.push({lap,compound});
    for(const first of plans)for(const second of plans)runs.push(()=>plannedRace(setup,[first,second]));
    methods.push(`one-stop plans at laps ${cfg.startLap}–${cfg.startLap+6} with all three slick compounds`);
  }
  if(cfg.startLap===0||cfg.weather){
    // Full races and wet races need more than one stop: search pit-wall policies per car instead.
    const policies:Policy[]=[];
    const weatherSteps=cfg.weather?[[0.25,0.15],[0.3,0.2],[0.4,0.2]]:[[0.3,0.2]];
    for(const threshold of cfg.startLap===0?[0.6,0.7,0.8,0.9]:[0.78])for(const prefer of (cfg.startLap===0?['auto','soft','hard']:['auto']) as Policy['prefer'][])for(const [interAt,slickAt] of weatherSteps)policies.push({threshold,prefer,interAt,slickAt});
    for(const a of policies)for(const b of policies)runs.push(()=>policyRace(setup,[a,b]));
    methods.push(cfg.startLap===0?'pit policies per car (stop at 60–90% wear; mediums-or-hards, softs, or hards)':'pit policies per car for the switch to inters and back')+(cfg.weather&&cfg.startLap===0?', with three inters crossover timings':'');
  }
  let candidates=2;const total=runs.length+2;
  for(const run of runs){const candidate=run();if(better(candidate.result,best.result))best=candidate;candidates++;if(candidates%20===0)progress?.(candidates,total);}
  progress?.(total,total);
  const shifts=alternatives(setup,decisions,actual);
  for(const shift of shifts){if(!shift.result)continue;candidates++;if(better(shift.result,best.result)){
    best={name:'Call-shift search',result:shift.result,calls:decisions.map((d,i)=>({at:i===shift.index?shift.shiftedAt!:d.at,command:{...d.command}})).sort((a,b)=>a.at-b.at),plan:`Your strategy, with ${shift.car===1?'Theo':'Nico'}’s ${shift.action} call one lap ${shift.direction}. All other calls unchanged.`};
  }}
  const method=`Search includes your race, the default engineer, ${methods.join(', and ')} at balanced pace, and the call shifts below.`;
  return {actual,baseline,best,candidates,alternatives:shifts,method};
}
