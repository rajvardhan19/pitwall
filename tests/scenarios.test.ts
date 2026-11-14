import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRace,step,applyCommand,playerCar,order,replay,wetness,weatherPenalty,lapPace,slickFor} from '../src/sim.ts';
import type {Race,RaceSetup} from '../src/sim.ts';
import {SCENARIOS,CIRCUITS,buildConfig,fullRaceLaps,qualifying} from '../src/scenarios.ts';
import {onTarget} from '../src/race-view.ts';
import {analyze} from '../src/analysis.ts';
import {Conversation} from '../src/conversation.ts';
import {parseIntent} from '../src/intent.ts';

const scenario=(id:string):RaceSetup=>({scenario:id,mode:'scenario',distance:'half',seed:SCENARIOS.find(s=>s.id===id)!.seed});
const full=(id:string,distance:'sprint'|'half'|'full',seed=777):RaceSetup=>({scenario:id,mode:'full',distance,seed});
function race(setup:RaceSetup,policy:(r:Race)=>void=()=>{}){const r=createRace(setup);r.status='running';while(r.status==='running'&&r.tick<40000){policy(r);step(r);}return r;}
const goals=(r:Race)=>[1,2].map(n=>onTarget(r,n as 1|2));

test('the original scenario is unchanged through the new setup API',()=>{
  assert.deepEqual(createRace(scenario('barcelona')),createRace());
  assert.deepEqual(replay(scenario('barcelona'),[]).cars.map(c=>c.finishedAt),replay(2049,[]).cars.map(c=>c.finishedAt));
});
test('every scenario and every full-race distance runs to the flag and replays exactly',()=>{
  const setups=[...SCENARIOS.map(s=>scenario(s.id)),...Object.keys(CIRCUITS).flatMap(c=>(['sprint','half'] as const).map(d=>full(c,d)))];
  for(const setup of setups){
    const r=race(setup,r=>{if(r.elapsed===30){applyCommand(r,{car:1,action:'push'});applyCommand(r,{car:2,action:'pit',compound:'hard'});}});
    assert.equal(r.status,'finished',JSON.stringify(setup));
    assert(r.cars.every(c=>c.distance===r.config.totalLaps));
    assert.deepEqual(replay(setup,r.decisions).cars.map(c=>c.finishedAt),r.cars.map(c=>c.finishedAt));
  }
});
test('full races start the whole 22-car field from a qualifying grid behind the line',()=>{
  for(const id of Object.keys(CIRCUITS)){
    const setup=full(id,'half'),r=createRace(setup);
    assert.equal(r.cars.length,22);assert.equal(r.config.totalLaps,fullRaceLaps(CIRCUITS[id],'half'));assert.equal(r.config.startLap,0);
    assert(r.cars.every(c=>c.distance>=0&&c.distance<0.1&&c.age===0&&c.wear===0));
    assert.deepEqual(order(r).map(c=>c.id),qualifying(setup));
    r.status='running';for(let i=0;i<40;i++)step(r);assert(r.cars.every(c=>c.lapTimes.length===0),'no phantom first lap');
  }
  const done=race(full('barcelona','full'));assert(done.cars.filter(c=>!c.player).every(c=>c.stops>=2),'a full Barcelona distance needs two stops');
});
test('the seed decides the safety car and the rain, and the same seed repeats them',()=>{
  let safety=0,rain=0;
  for(let seed=1;seed<=200;seed++){const cfg=buildConfig(full('silverstone','full',seed*31));safety+=cfg.safety.length;rain+=cfg.weather?1:0;}
  assert(safety>60&&safety<140,`safety cars in ${safety}/200`);assert(rain>70&&rain<150,`rain in ${rain}/200`);
  assert.deepEqual(buildConfig(full('monaco','full',4242)),buildConfig(full('monaco','full',4242)));
});
test('rain: slicks fall away, inters peak on a wet track and overheat on a dry one',()=>{
  assert(weatherPenalty('soft',0.55)>weatherPenalty('inter',0.55)+4);
  assert(weatherPenalty('medium',0)<weatherPenalty('inter',0));
  const r=createRace(scenario('silverstone'));assert.equal(wetness(r,0),0);assert(wetness(r,600)>0.5);assert(wetness(r,1300)<0.05);
  const done=race(scenario('silverstone'));
  const switched=done.events.filter(e=>e.type==='pit'&&e.compound==='inter').length,back=done.events.filter(e=>e.type==='pit'&&e.compound!=='inter').length;
  assert(switched>=6&&back>=6,`rivals switch to inters (${switched}) and back (${back})`);
  const times=new Set(done.events.filter(e=>e.type==='pit'&&e.compound==='inter').map(e=>e.at));assert(times.size>3,'the field does not switch as one');
});
test('at Monaco, rivals keep track position under the safety car when their tyres last',()=>{
  const r=race(scenario('monaco'));
  const underSc=r.events.filter(e=>e.type==='pit'&&e.at>=900&&e.at<=1045).map(e=>e.type==='pit'?e.car:-1);
  const barcelona=race(scenario('barcelona')).events.filter(e=>e.type==='pit'&&e.at>=270&&e.at<=420).length;
  assert(underSc.length<barcelona,'fewer cheap stops where passing is impossible');
});
test('the title decider objective is about Voss, not a position',()=>{
  const r=createRace(scenario('yasmarina'));
  assert.deepEqual(r.config.objectives[1],{kind:'beat',rival:0});assert.equal(onTarget(r,1),false);
  r.cars.find(c=>c.id===1)!.distance+=0.1;assert.equal(onTarget(r,1),true);
});
test('in every scenario, doing nothing misses a goal and a real decision meets both',()=>{
  const pitAt=(n:number,when:(r:Race,c:ReturnType<typeof playerCar>)=>boolean,compound:any)=>{let done=false;return (r:Race)=>{const c=playerCar(r,n)!;if(!done&&when(r,c)){applyCommand(r,{car:n,action:'pit',compound});done=true;}};};
  const both=(...p:((r:Race)=>void)[])=>(r:Race)=>p.forEach(f=>f(r));
  const interPolicy=(n:number)=>(r:Race)=>{const c=playerCar(r,n)!;if(c.pitRemaining||c.pitOrder)return;const w=wetness(r),left=r.config.totalLaps-c.distance;if(c.compound!=='inter'&&w>0.28&&left>2)applyCommand(r,{car:n,action:'pit',compound:'inter'});else if(c.compound==='inter'&&w<0.2&&left>2)applyCommand(r,{car:n,action:'pit',compound:slickFor(r,left)});};
  const plans:Record<string,(r:Race)=>void>={
    monza:both(pitAt(1,(r,c)=>c!.distance>=39,'soft'),pitAt(2,(r,c)=>c!.distance>=39,'soft')),
    monaco:pitAt(1,r=>r.flag==='safety','soft'),
    silverstone:both(r=>{if(r.elapsed===0){applyCommand(r,{car:1,action:'push'});applyCommand(r,{car:2,action:'push'});}},interPolicy(1),interPolicy(2)),
    yasmarina:both(r=>{if(r.elapsed===0)applyCommand(r,{car:1,action:'push'});},pitAt(1,r=>r.flag==='safety','soft')),
  };
  for(const [id,plan] of Object.entries(plans)){
    assert(!goals(race(scenario(id))).every(Boolean),`${id}: doing nothing should miss a goal`);
    assert.deepEqual(goals(race(scenario(id),plan)),[true,true],`${id}: the intended call should meet both goals`);
  }
});
test('the debrief search adapts to full races and wet races',()=>{
  const sprint=analyze(full('monza','sprint'),[]);
  assert.match(sprint.method,/pit policies/);assert(sprint.candidates>100);
  const wet=analyze(scenario('silverstone'),[]);
  assert.match(wet.method,/inters/);assert(wet.best.result.objectives>=wet.baseline.result.objectives);
});
test('lights out: the team opens with the start, then reviews it after lap one',()=>{
  const r=createRace(full('barcelona','sprint'));r.status='running';const c=new Conversation(r);c.start(r);
  assert.match(c.lines[0].text,/Lights out/);
  for(let i=0;i<200;i++){step(r);c.observe(r);}
  assert(c.lines.some(l=>(l.speaker==='LAU'||l.speaker==='REY')&&/start|launch|off the line/i.test(l.text)));
  assert(!c.lines.some(l=>/Starting to lose grip/.test(l.text)),'no worn-tyre opening on fresh tyres');
});
test('rain on the radar, then the strategist asks for inters, and a yes fits them',()=>{
  const r=createRace(scenario('silverstone'));r.status='running';const c=new Conversation(r);c.start(r);
  let asked=null as any;
  for(let i=0;i<1200&&!asked;i++){step(r);c.observe(r);asked=c.questions.find(q=>q.kind==='plan'&&q.commands?.[0].action==='pit'&&(q.commands[0] as any).compound==='inter');}
  assert(c.lines.some(l=>/Radar update/.test(l.text)),'radar warning before the rain');
  assert(asked,'James asks for the crossover');
  c.hear(r,'yes');assert.equal(playerCar(r,asked.car)!.pitOrder,'inter');
  assert.match(c.weatherReport(r),/wet|damp/i);
});
test('inters are a call only when the race has weather',()=>{
  assert.equal(parseIntent('Nico, box for inters',undefined,undefined,false).kind,'clarify');
  assert.deepEqual(parseIntent('Nico, box for inters',undefined,undefined,true),{kind:'command',command:{car:2,action:'pit',compound:'inter'}});
  assert.equal(parseIntent('Nico, box for full wets',undefined,undefined,true).kind,'clarify');
});
test('scenario facts reach the pace model: overtaking difficulty, pit loss and wear differ by circuit',()=>{
  const monaco=createRace(scenario('monaco')),monza=createRace(scenario('monza'));
  assert(monaco.config.overtake>monza.config.overtake*3);assert(monza.config.pitLoss>monaco.config.pitLoss);
  const car=playerCar(monza,1)!;assert(lapPace(car,monza)<lapPace(playerCar(monaco,1)!,monaco)+20);
});
