import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRace,step,applyCommand,playerCar,order,wetness,slickFor,lapsLeftOn} from '../src/sim.ts';
import type {Race,RaceSetup} from '../src/sim.ts';
import {SCENARIOS,CIRCUITS,CALENDAR_2026,schematicPath,pathOf,qualifying,ROSTER,TEAMS} from '../src/scenarios.ts';
import {onTarget} from '../src/race-view.ts';
import {newSeason,nextRound,seasonOver,seasonSetup,standings,recordRace,simulateRound,loadSeason,saveSeason,briefFor,POINTS} from '../src/season.ts';
import {Conversation} from '../src/conversation.ts';
import {parseIntent} from '../src/intent.ts';

test('the grid is 11 fictional teams of two, with Apex as the player team',()=>{
  assert.equal(ROSTER.length,22);assert.equal(TEAMS.length,11);
  for(const t of TEAMS)assert.equal(ROSTER.filter(d=>d.team===t.name).length,2,t.name);
  assert.equal(new Set(ROSTER.map(d=>d.code)).size,22);assert.equal(new Set(TEAMS.map(t=>t.color)).size,11);
  assert.deepEqual(ROSTER.filter(d=>d.team==='Apex').map(d=>d.id),[1,4]);
});
test('the 2026 calendar has 23 rounds in order, each at a known circuit',()=>{
  assert.equal(CALENDAR_2026.length,23);
  CALENDAR_2026.forEach((r,i)=>{assert.equal(r.round,i+1);assert(CIRCUITS[r.circuit],r.circuit);});
  assert.equal(CALENDAR_2026[0].circuit,'melbourne');assert.equal(CALENDAR_2026.at(-1)!.circuit,'yasmarina');
  assert.match(CALENDAR_2026.find(r=>r.circuit==='sepang')!.note!,/Sakhir/);
  assert(!CALENDAR_2026.some(r=>/Saudi/.test(r.gp)),'Jeddah was cancelled');
});
test('generated circuit outlines are closed, stay inside the map, and never change',()=>{
  for(const c of Object.values(CIRCUITS)){
    const d=pathOf(c);assert(d.startsWith('M ')&&d.endsWith('Z'),c.id);
    const nums=d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for(let i=0;i<nums.length;i+=2){assert(nums[i]>=40&&nums[i]<=480,`${c.id} x ${nums[i]}`);assert(nums[i+1]>=5&&nums[i+1]<=280,`${c.id} y ${nums[i+1]}`);}
  }
  assert.equal(schematicPath('spa'),schematicPath('spa'));assert.notEqual(schematicPath('spa'),schematicPath('baku'));
});
test('qualifying follows car pace with a little seeded luck',()=>{
  const setup=(seed:number):RaceSetup=>({scenario:'monza',mode:'full',circuit:'monza',distance:'half',seed});
  const grids=[1,2,3,4,5,6,7,8].map(seed=>qualifying(setup(seed)));
  assert(new Set(grids.map(g=>g.join())).size>4,'different seeds shuffle the order');
  const backmarkers=ROSTER.filter(d=>d.team==='Meridian').map(d=>d.id);
  for(const g of grids)assert(backmarkers.every(id=>g.indexOf(id)>=12),'the slowest team does not start at the front');
});
test('a season runs round by round, scores 25-18-15…, and can be saved and resumed',()=>{
  let s=newSeason('sprint',4242);
  assert.equal(nextRound(s)!.round,1);assert.match(seasonSetup(s)!.brief!,/Round one, Australian Grand Prix/);
  const first=simulateRound(s);s=first.season;
  assert.equal(s.results.length,1);assert.equal(first.race!.cars.length,22);
  assert.equal(standings(s).drivers.reduce((a,d)=>a+d.points,0),POINTS.reduce((a,b)=>a+b,0));
  assert.equal(recordRace(s,first.race!),s,'the same round is never recorded twice');
  const store=new Map<string,string>();const storage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
  saveSeason(s,storage);assert.deepEqual(loadSeason(storage),s);
  while(!seasonOver(s))s=simulateRound(s).season;
  assert.equal(s.results.length,23);assert.equal(nextRound(s),null);
  const table=standings(s);assert.equal(table.drivers.reduce((a,d)=>a+d.points,0),23*101);
  assert.equal(table.teams.reduce((a,t)=>a+t.points,0),23*101);
  assert.match(briefFor(s,CALENDAR_2026[22]),/championship/);
});
test('a raced season round records the real result',()=>{
  let s=newSeason('sprint',99);const r=createRace(seasonSetup(s)!);r.status='running';
  while(r.status==='running')step(r);
  s=recordRace(s,r);assert.deepEqual(s.results[0].order,order(r).map(c=>c.id));assert.equal(s.results[0].simulated,false);
});
test('season rounds open with the championship picture on the radio',()=>{
  let s=newSeason('sprint',7);s=simulateRound(s).season;
  const r=createRace(seasonSetup(s)!);r.status='running';const c=new Conversation(r);c.start(r);
  assert.match(c.lines[0].text,/Round 2, Chinese Grand Prix\. Theo is P\d+ in the championship.*Lights out!/);
});
test('every rival on the grid can be asked about by name',()=>{
  assert.deepEqual(parseIntent('is Okafor pitting?',1),{kind:'question',topic:'rival',car:1,rival:'Okafor'});
  assert.deepEqual(parseIntent('where is Varga?',2),{kind:'question',topic:'rival',car:2,rival:'Varga'});
});

// The calls the tuning sweep found for each new scenario (see DECISIONS.md).
type Plan={at?:number|'sc';compound?:any;mode?:string;again?:boolean;swap?:boolean;inters?:boolean};
function play(id:string,theo:Plan,nico:Plan){
  const s=SCENARIOS.find(x=>x.id===id)!;
  const r=createRace({scenario:id,mode:'scenario',distance:'half',seed:s.seed});r.status='running';
  const done=new Set<string>();
  for(const [n,p] of [[1,theo],[2,nico]] as const)if(p.mode)applyCommand(r,{car:n,action:p.mode as any});
  while(r.status==='running'&&r.tick<40000){
    for(const [n,p] of [[1,theo],[2,nico]] as const){
      const car=playerCar(r,n)!;if(car.finishedAt!==null||car.pitRemaining||car.pitOrder)continue;const left=r.config.totalLaps-car.distance;
      if(p.swap&&n===1&&!done.has('swap')){const mate=playerCar(r,2)!,o=order(r);if(o.indexOf(mate)===o.indexOf(car)+1&&(car.distance-mate.distance)*80<1.2&&applyCommand(r,{car:1,action:'swap'})==='ok')done.add('swap');}
      if(p.inters){const w=wetness(r);if(car.compound!=='inter'&&w>0.28&&left>1)applyCommand(r,{car:n,action:'pit',compound:'inter'});else if(car.compound==='inter'&&w<0.2&&left>2)applyCommand(r,{car:n,action:'pit',compound:slickFor(r,left)});continue;}
      if(done.has('p'+n)){if(p.again&&!done.has('q'+n)&&car.wear>0.85&&lapsLeftOn(r,car)<left&&left>2){applyCommand(r,{car:n,action:'pit',compound:p.compound});done.add('q'+n);}continue;}
      if(p.at===undefined)continue;
      const fire=p.at==='sc'?r.flag==='safety':car.distance>=s.startLap+p.at-1;
      if(fire){applyCommand(r,{car:n,action:'pit',compound:p.compound});done.add('p'+n);}
    }
    step(r);
  }
  return [onTarget(r,1),onTarget(r,2)];
}
test('each new scenario: doing nothing misses a goal, and the call it is built around meets both',()=>{
  const plans:Record<string,[Plan,Plan]>={
    melbourne:[{at:'sc',compound:'soft',mode:'push'},{at:1,compound:'soft',mode:'conserve'}],
    suzuka:[{at:3,compound:'hard',mode:'push'},{at:1,compound:'hard'}],
    sepang:[{at:1,compound:'hard',mode:'push'},{at:3,compound:'medium',mode:'push',again:true}],
    baku:[{at:'sc',compound:'medium',mode:'push'},{at:1,compound:'soft',mode:'conserve'}],
    spa:[{inters:true,mode:'push'},{inters:true}],
    hungaroring:[{swap:true,at:3,compound:'hard',mode:'push'},{at:7,compound:'soft',mode:'push'}],
    zandvoort:[{at:3,compound:'soft'},{at:7,compound:'medium'}],
    singapore:[{at:'sc',compound:'soft',mode:'push'},{at:1,compound:'soft',mode:'push'}],
    interlagos:[{inters:true},{inters:true}],
    lasvegas:[{at:3,compound:'soft',mode:'push'},{at:5,compound:'hard',mode:'push'}],
  };
  for(const [id,[theo,nico]] of Object.entries(plans)){
    assert(!play(id,{},{}).every(Boolean),`${id}: doing nothing should miss a goal`);
    assert.deepEqual(play(id,theo,nico),[true,true],`${id}: the intended calls should meet both goals`);
  }
  assert.equal(SCENARIOS.length,15);assert.equal(new Set(SCENARIOS.map(s=>s.circuit)).size,15);
});
