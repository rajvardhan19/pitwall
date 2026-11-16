import './style.css';
import { createRace, step, order, playerCar, lapPace, formatTime, TYRES, SLICKS, pitForecast, pitLoss, wetness } from './sim.ts';
import { SCENARIOS, CIRCUITS, CALENDAR_2026, DEFAULT_SETUP, scenarioById, circuitOf, fullRaceLaps, objectiveLabel, raceTitle, roundOf, ROSTER, pathOf } from './scenarios.ts';
import { newSeason, nextRound, seasonOver, seasonSetup, standings, recordRace, simulateRound, loadSeason, saveSeason } from './season.ts';
import type { Season } from './season.ts';
import type { RaceSetup, Objective, Distance } from './scenarios.ts';
import { onTarget, positionOf, trackState } from './race-view.ts';
import type { Car, Compound, Command } from './sim.ts';
import {parseIntent} from './intent.ts';
import {RadioVoice, voiceProfile} from './radio.ts';
import {VoiceInput} from './voice-input.ts';
import {PitwallSound} from './sound.ts';
import {driverNumber,layoutMarkers} from './map.ts';
import {Conversation} from './conversation.ts';
import type {BrainCall, Line} from './conversation.ts';
import {TeamBrain, BRAIN_MODEL} from './brain.ts';
import {findLocalModels} from './local-models.ts';
import {chooseTier,probeDevice,setupProgress,lightsOn} from './team-setup.ts';
import type {TierChoice} from './team-setup.ts';
import {raceFacts} from './brain-prompt.ts';
import type {DebriefAnalysis,Result} from './analysis.ts';

// The player's chosen race is remembered between visits. Full races get a fresh seed each time.
const SETUP_KEY='pitwall.setup';
const newSeed=()=>Math.floor(Math.random()*900000)+100000;
let season:Season|null=loadSeason();
let seasonDraft={distance:'half' as Distance,start:{1:'medium',2:'medium'} as {1:Compound;2:Compound}};
function loadSetup():RaceSetup{
  try{
    const saved=JSON.parse(localStorage.getItem(SETUP_KEY)??'null');
    if(saved?.mode==='season')return (season&&seasonSetup(season))||{...DEFAULT_SETUP,mode:'season'};
    if(saved&&(saved.mode==='full'?CIRCUITS[saved.circuit??saved.scenario]:SCENARIOS.some(x=>x.id===saved.scenario)))return {...DEFAULT_SETUP,...saved,seed:saved.mode==='full'?newSeed():scenarioById(saved.scenario).seed};
  }catch{/* first visit */}
  return DEFAULT_SETUP;
}
let setup=loadSetup();
let race=createRace(setup);let speed=1;let selected=1;let lastLine=0;let accumulator=0;let lastFrame=performance.now();
let guided=true;let briefing=true;let debrief=false;let finishedWall=0;let comparison:DebriefAnalysis|null=null;let analysisWorker:Worker|null=null;let analysisProgress='';let inspectedDriver=1;let lastAirTime=0;let onAir=false;let thinking:BrainCall|null=null;
const airedLines=new Set<number>();
const pitWas:Record<1|2,number>={1:0,2:0};
const voice=new RadioVoice();voice.textUntilReady=true;
// For diagnosing the radio from the browser console or a test driver.
(window as unknown as {pitwallRadio:()=>unknown}).pitwallRadio=()=>({device:voice.device,ready:voice.ready,...voice.stats});const sound=new PitwallSound();const brain=new TeamBrain();
const nextTyre:Record<number,Compound>={1:'medium',2:'medium'};
let convo=newConversation();
function newConversation(){
  const c=new Conversation(race);
  c.compound=car=>nextTyre[car];
  c.brainAvailable=()=>brain.ready;
  c.speed=speed;
  c.radioBusy=()=>voice.enabled&&voice.busy;
  return c;
}
voice.clock=()=>race.elapsed;
const app=document.querySelector<HTMLDivElement>('#app')!;
const trackPath=()=>pathOf(circuitOf(race.config.setup));
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
app.innerHTML=`
<header class="topbar"><a class="brand" href="./" aria-label="Pitwall home"><span class="brand-mark">∕∕</span> PITWALL<span class="brand-sub">RACE ENGINEER</span></a><div class="session-name" id="session-name"></div><div class="header-actions"><button id="focus" class="subtle" aria-pressed="false">Race view</button><button id="guide" class="subtle">Hints on</button><button id="sound" class="subtle" aria-pressed="false">Audio off</button><button id="brief" class="icon-button" aria-label="Scenario briefing">?</button></div></header>
<main><section class="sessionbar"><div><div class="eyebrow" id="session-kicker"></div><h1>Your call. Their race.</h1></div><div class="race-status"><div id="flag" class="flag">● GREEN FLAG</div><div class="lap-counter">LAP <strong id="lap">1</strong><span id="lap-total"></span></div><div class="playback"><button id="play" class="play" aria-label="Start race">▶</button><div class="speeds" aria-label="Simulation speed">${[1,5,15,60].map(n=>`<button data-speed="${n}" class="${n===1?'active':''}" aria-pressed="${n===1}">${n}×</button>`).join('')}</div></div></div></section>
<section class="race-director"><span class="director-label"><i></i> LIVE FROM THE PIT WALL</span><strong id="race-headline"></strong><span id="race-stakes"></span></section><div class="dashboard"><aside class="panel timing"><div class="panel-head"><h2>Timing tower</h2><span class="tiny">TO LEADER</span></div><div class="timing-labels"><span>POS / DRIVER</span><span>GAP</span><span>TYRE</span></div><div id="tower"></div><div class="tower-footer"><span class="live-dot"></span> Sector updates <span id="clock">00:00</span></div><div class="objective" id="objective"></div></aside>
<section class="center-column"><div class="panel circuit-panel"><div class="panel-head"><h2 id="circuit-name"></h2><span class="tag">LIVE TRACK</span></div><div class="circuit-meta" id="circuit-meta"></div><div class="circuit-wrap"><div class="circuit-watermark" id="circuit-watermark"></div><div class="sector-label sector-one">SECTOR 1</div><div class="sector-label sector-two">SECTOR 2</div><div class="sector-label sector-three">SECTOR 3</div><svg id="track" viewBox="40 5 440 275" role="img" aria-label="Schematic circuit map with live car positions"><path id="track-shadow" class="track-shadow"/><path id="track-path" class="track-line"/><path id="start-line" stroke="#e8eee6" stroke-width="5"/><g id="car-trails"></g><g id="car-markers"></g></svg><div class="track-caption">NUMBER = DRIVER · COLOR = CONSTRUCTOR</div></div><div id="map-legend" class="map-legend" aria-label="Constructor colors and driver numbers"></div><div id="map-driver" class="map-driver" aria-live="polite"></div><div id="live-battles" class="live-battles"></div><div class="conditions" id="conditions"></div></div>
<div class="car-grid" id="cars"></div>
<div class="panel pace-panel"><div class="panel-head"><h2>Race pace</h2><div class="legend"><span>● LAU</span><span>● REY</span><small>COMPLETED LAPS</small></div></div><div id="pace"></div></div></section>
<aside class="right-column"><div class="panel strategy"><div class="panel-head"><h2>Strategy desk</h2><span class="tiny">APEX</span></div><div class="strategy-tabs"><button data-select="1" class="active">01 LAURENT</button><button data-select="2">02 REYES</button></div><div id="strategy"></div></div><div class="panel radio-panel"><div class="panel-head"><h2>Team radio</h2><span class="tag radio-tag">● ONLINE</span></div><div id="messages" role="log" aria-label="Team radio messages"></div><div class="radio-hint" id="hint">Answer the team: “yes”, “no”, “box both”. Call: “Nico, box for softs”.</div></div></aside></div>
<section class="on-air-panel" aria-label="Current team transmission"><div class="speaker-avatar" id="speaker-avatar">PW</div><div class="transmission"><div><span id="speaker-label">PIT WALL · STANDING BY</span><span id="transmission-state">RADIO LINK</span></div><p id="subtitle">The team is waiting for your call.</p><div id="question" class="question-bar" hidden><span id="question-prompt"></span><span id="question-timer" aria-live="off"></span><div id="question-options" role="group" aria-label="Quick replies"></div></div></div><div class="waveform" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></section><section class="voice-console"><div class="voice-setup"><label for="radio-cast">TEAM VOICES</label><select id="radio-cast"><option value="LAU">Theo · measured</option><option value="REY">Nico · energetic</option><option value="STRATEGIST">James · strategy</option><option value="TYRE SPECIALIST">Maya · tyres</option><option value="DATA ENGINEER">Eli · data</option><option value="RACE CONTROL">Race control</option><option value="PIT CREW">Pit crew</option></select><button id="radio-preview">Load &amp; hear voice</button><span id="radio-status" role="status" aria-live="polite">Local neural voices · first download ~90 MB · no subscription</span></div><div class="voice-setup"><label for="voice-engine">VOICE INPUT</label><select id="voice-engine"><option value="local">On-device voice</option><option value="browser">Browser speech service</option></select><button id="voice-check">Run voice check</button><span class="voice-privacy">First use downloads a speech model. On-device audio is never uploaded.</span></div><div class="voice-setup"><label for="brain-enable">TEAM CHAT AI</label><button id="brain-enable" disabled>Preparing team chat…</button><span id="brain-status" role="status" aria-live="polite">Loads automatically: drivers and engineers answer free-form questions in character. Needs WebGPU. First download, ${BRAIN_MODEL.size}; runs on this device. Race calls never depend on it.</span></div><div class="voice-feedback"><span id="voice-state">READY</span><div class="mic-meter" aria-label="Microphone input level"><i id="mic-level"></i></div><span id="voice-detail" role="status" aria-live="polite">Hold Space to talk; release to send. Or click Talk, then Finish.</span><button id="voice-cancel" hidden>Cancel</button></div></section><section class="command-bar"><div class="radio-symbol">⌁</div><div class="command-title"><strong>YOU HAVE THE RADIO</strong><span id="mic-status">Type a call or use your microphone</span></div><form id="command-form"><label class="sr-only" for="command">Radio command</label><input id="command" autocomplete="off" placeholder='“Car two, box for mediums”'><button type="submit" aria-label="Send radio command">↵</button></form><button id="mic" class="mic-button">◉ <span>Talk · R</span></button></section>
<footer><span>APEX MOTORSPORT <span class="muted">/ ENGINEERING STATION 01</span></span><span class="footer-links"><a href="https://github.com/rajvardhan19/pitwall" target="_blank" rel="noopener">OPEN SOURCE ON GITHUB</a><span class="footer-dot">●</span><a href="https://www.llama.com/llama3_2/license/" target="_blank" rel="noopener">BUILT WITH LLAMA</a></span><span id="footer-race"></span></footer></main>
<dialog id="modal"></dialog>`;
function setHTML(selector:string,html:string) {
  const el=document.querySelector<HTMLElement>(selector)!;
  if(el.dataset.rendered===html)return;
  const active=document.activeElement;
  const data=active instanceof HTMLButtonElement && el.contains(active)?JSON.stringify(active.dataset):null;
  el.innerHTML=html;el.dataset.rendered=html;
  if(data)Array.from(el.querySelectorAll('button')).find(b=>JSON.stringify(b.dataset)===data)?.focus({preventScroll:true});
}
const $=<T extends HTMLElement=HTMLElement>(q:string)=>document.querySelector<T>(q)!;
function timingOrder() {
  return order(race).sort((a,b)=>(a.finishedAt??Infinity)-(b.finishedAt??Infinity)||b.shownDistance-a.shownDistance||a.id-b.id);
}
function carPanel(car:Car,num:number) {
  const pos=timingOrder().findIndex(c=>c.id===car.id)+1;const tyre=TYRES[car.compound];
  return `<article class="panel car-panel ${selected===num?'selected':''}"><div class="driver-heading"><span class="driver-number">0${num}</span><div><span class="eyebrow">${num===1?'THE VETERAN':'THE HOTSHOT'}</span><h2>${car.name}</h2></div><strong class="position">P${pos}</strong></div><div class="tyre-line"><span class="compound" style="--tyre:${tyre.color}">${car.compound[0].toUpperCase()}</span><span>${car.compound.toUpperCase()} <small>${Math.floor(car.age)} laps old</small></span><div class="tyre-health"><strong>${Math.max(0,Math.round((1-car.wear)*100))}%</strong><small>TYRE LIFE</small></div></div><div class="wear-track"><div style="width:${Math.max(0,(1-car.wear)*100)}%;background:${car.wear>0.78?'#ed6d73':tyre.color}"></div><i></i></div><div class="car-stats"><div><span>LAST LAP</span><strong>${formatTime(car.lastLap)}</strong></div><div><span>PACE MODE</span><strong>${car.mode}</strong></div><div><span>STOPS</span><strong>${car.stops}</strong></div></div><div class="car-actions"><button data-car="${num}" data-action="pit" class="box-button" ${car.finishedAt!==null?'disabled':''}>${car.pitRemaining?'PIT · '+car.pitRemaining+'s':car.pitOrder?'BOX · '+car.pitOrder.toUpperCase():'BOX THIS LAP'}</button><button data-car="${num}" data-action="stay">Stay out</button><button data-car="${num}" data-action="${car.mode==='push'?'conserve':'push'}">${car.mode==='push'?'Conserve':'Push'} ↗</button></div></article>`;
}
function objectiveSentence(name:string,ob:Objective){
  if(ob.kind==='beat')return `Finish ${name} ahead of ${ROSTER[ob.rival].name.split(' ')[1]}.`;
  return ob.max===1?`Win with ${name}.`:ob.max===3?`${name} on the podium.`:`${name} in the top ${ob.max}.`;
}
/** Everything on the dashboard that depends on which race was chosen. */
function renderChrome(){
  const cfg=race.config,circuit=circuitOf(cfg.setup),title=raceTitle(cfg.setup);
  $('#session-name').innerHTML=`<span class="live-dot"></span> ${esc(circuit.city.toUpperCase())} <span class="muted">/</span> ${esc(title.title.toUpperCase())}`;
  $('#session-kicker').innerHTML=`${esc(title.kicker)} <span>·</span> STRATEGY SIMULATION`;
  $('#lap-total').textContent=`/ ${cfg.totalLaps}`;
  $('#objective').innerHTML=`<span class="eyebrow">YOUR OBJECTIVE</span><h3>Two cars. One team.</h3><p>${objectiveSentence('Theo',cfg.objectives[1])}<br>${objectiveSentence('Nico',cfg.objectives[2])}</p><div class="objective-line"><span>01 / LAURENT</span><b>${objectiveLabel(cfg.objectives[1])}</b></div><div class="objective-line"><span>02 / REYES</span><b>${objectiveLabel(cfg.objectives[2])}</b></div>`;
  $('#circuit-name').textContent=circuit.name;
  $('#circuit-watermark').innerHTML=`${esc(circuit.city.toUpperCase())}<span>${esc(title.kicker)}</span>`;
  const path=$<SVGPathElement&HTMLElement>('#track-path');path.setAttribute('d',pathOf(circuit));$('#track-shadow').setAttribute('d',pathOf(circuit));
  // Start/finish line: a short stroke across the track where the path begins.
  const a=path.getPointAtLength(0),b=path.getPointAtLength(6),dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,nx=-dy/len*8,ny=dx/len*8;
  $('#start-line').setAttribute('d',`M ${a.x-nx} ${a.y-ny} L ${a.x+nx} ${a.y+ny}`);
  placeSectorLabels();
  $('#footer-race').innerHTML=`${esc(title.kicker)} · SEED ${race.seed} <span class="footer-dot">●</span> LOCAL SIMULATION`;
  renderConditions();
}
/** Sector labels sit beside the middle of each third of the lap, at the nearby spot furthest from any part of the track. */
function placeSectorLabels(){
  const path=$<SVGPathElement&HTMLElement>('#track-path'),wrap=document.querySelector<HTMLElement>('.circuit-wrap'),ctm=path.getScreenCTM(),length=path.getTotalLength();
  if(!wrap||!ctm||!length)return;
  const box=wrap.getBoundingClientRect(),track=Array.from({length:240},(_,i)=>path.getPointAtLength(length*i/240));
  // Labels are wide and short: weigh horizontal distance less, so text clears the line along its length.
  const clearance=(x:number,y:number)=>Math.min(...track.map(p=>Math.hypot((p.x-x)/1.9,p.y-y)));
  document.querySelectorAll<HTMLElement>('.sector-label').forEach((label,i)=>{
    const p=path.getPointAtLength(length*(2*i+1)/6);let best={x:p.x,y:p.y-24,score:-1};
    for(const r of [20,28,36,46])for(let a=0;a<360;a+=20){
      const x=p.x+Math.cos(a*Math.PI/180)*r*1.6,y=p.y+Math.sin(a*Math.PI/180)*r;
      if(x<78||x>442||y<14||y>270)continue;
      const score=Math.min(clearance(x,y),14)-r*0.05;
      if(score>best.score)best={x,y,score};
    }
    const at=new DOMPoint(best.x,best.y).matrixTransform(ctm);
    Object.assign(label.style,{left:`${Math.round(at.x-box.left)}px`,top:`${Math.round(at.y-box.top)}px`,right:'auto',bottom:'auto',transform:'translate(-50%,-50%)'});
  });
}
window.addEventListener('resize',()=>placeSectorLabels());
function renderConditions(){
  const cfg=race.config,circuit=circuitOf(cfg.setup),scenario=scenarioById(cfg.setup.scenario);
  const rain=cfg.setup.mode==='scenario'?scenario.forecast.rainChance:Math.round(circuit.rainChance*100);
  const forecast=cfg.setup.mode==='scenario'?scenario.forecast:{text:circuit.rainChance?'Showers possible':'Dry to finish',confidence:circuit.rainChance?'changeable':'stable'};
  const state=trackState(race);
  setHTML('#circuit-meta',`<span>${circuit.km} <small>KM</small></span><span>${circuit.turns} <small>TURNS</small></span><span>${state} <small>TRACK</small></span>`);
  setHTML('#conditions',`<div><span class="eyebrow">TRACK TEMP</span><strong>${circuit.trackTemp-(wetness(race)>0.05?10:0)}°<small>C</small></strong></div><div><span class="eyebrow">AIR TEMP</span><strong>${circuit.airTemp}°<small>C</small></strong></div><div><span class="eyebrow">${state==='DRY'?'RAIN CHANCE':'TRACK'}</span><strong>${state==='DRY'?`${rain}<small>%</small>`:esc(state)}</strong></div><div><span class="eyebrow">FORECAST</span><strong class="forecast">${esc(forecast.text)} <span>${esc(forecast.confidence)}</span></strong></div>`);
}
function radioLine(l:Line){
  const who=l.speaker==='YOU'?'YOU · RACE ENGINEER':l.speaker==='RADIO'?'PIT WALL':voiceProfile(l.speaker).short;
  return `<div class="radio-message ${l.kind}" data-radio-id="${l.id}" data-aired="${airedLines.has(l.id)}"><div><strong>${esc(who)}</strong><time>${Math.floor(l.at/60)}:${(l.at%60).toString().padStart(2,'0')}</time></div><p>${esc(l.text)}</p></div>`;
}
function render() {
  const sorted=timingOrder();const leader=sorted[0];
  $('#lap').textContent=String(Math.min(race.config.totalLaps,Math.floor(order(race)[0].distance)+1));
  renderConditions();
  $('#flag').className='flag '+(race.flag==='safety'?'yellow':'');
  $('#flag').textContent=race.status==='finished'?'⚑ CHEQUERED FLAG':race.status==='paused'?'Ⅱ SESSION PAUSED':race.status==='ready'?'● READY TO RACE':race.flag==='safety'?'● SAFETY CAR':'● GREEN FLAG';
  $('#play').textContent=race.status==='running'?'Ⅱ':'▶';$('#play').setAttribute('aria-label',race.status==='finished'?'Open race debrief':race.status==='running'?'Pause race':'Resume race');
  document.body.classList.toggle('under-safety',race.flag==='safety');
  document.body.classList.toggle('race-running',race.status==='running');
  sound.update(race.status==='running',race.flag==='safety',playerCar(race,selected)!.distance);
  // The pit crew at work when one of our cars arrives in its box.
  for(const n of [1,2] as const){const c=playerCar(race,n)!;if(c.pitRemaining>0&&!(pitWas[n]>0)&&race.status==='running')sound.pitStop();pitWas[n]=c.pitRemaining;}
  renderRaceStory();
  $('#clock').textContent=`${Math.floor(race.elapsed/60).toString().padStart(2,'0')}:${(race.elapsed%60).toString().padStart(2,'0')}`;
  $('#tower').classList.toggle('full-field',race.cars.length>12);
  $('#tower').innerHTML=sorted.map((car,i)=>`<div class="timing-row ${car.player?'our-car':''}"><span class="rank">${i+1}</span><span class="team-line" style="background:${car.color}"></span><div class="timing-name"><strong>${car.code}</strong><small>${car.team}</small></div><span class="gap">${car.finishedAt!==null?'FIN':car.pitRemaining?'PIT':i===0?'LEADER':'+'+Math.max(0,(leader.shownDistance-car.shownDistance)*race.config.lapTime).toFixed(1)}</span><span class="tyre-dot" style="color:${TYRES[car.compound].color}">${car.compound[0].toUpperCase()}</span></div>`).join('');
  setHTML('#cars',race.cars.filter(c=>c.player).map((c,i)=>carPanel(c,i+1)).join(''));
  const path=$<SVGPathElement & HTMLElement>('#track-path');const length=path.getTotalLength();
  const markers=layoutMarkers(race.cars,f=>path.getPointAtLength(f*length));
  const markerHTML=(c:Car,p:{x:number;y:number},anchor:{x:number;y:number})=>`<g data-map-driver="${c.id}" class="map-marker ${c.id===inspectedDriver?'inspected':''}" tabindex="0" role="button" aria-label="${c.name}, ${c.team}, number ${driverNumber(c)}" transform="translate(${p.x},${p.y})"><title>${c.name} · ${c.team} · ${driverNumber(c)}</title>${Math.hypot(p.x-anchor.x,p.y-anchor.y)>3?`<line x1="0" y1="0" x2="${anchor.x-p.x}" y2="${anchor.y-p.y}" stroke="${c.color}" opacity=".65"/>`:''}<circle r="${c.id===inspectedDriver?12:10}" fill="#0d1511" stroke="${c.color}" stroke-width="${c.player?3:2}"/><circle r="7" fill="${c.color}" opacity="${c.id===inspectedDriver?'.4':'.16'}"/><text text-anchor="middle" dy="3" fill="#fff" font-size="8" font-family="monospace" font-weight="700">${driverNumber(c)}</text></g>`;
  const focusedMarker=document.activeElement?.closest('.map-marker')?.getAttribute('data-map-driver');
  $('#car-markers').innerHTML=markers.map(({car,point,anchor})=>markerHTML(car,point,anchor)).join('');
  if(focusedMarker)document.querySelector<SVGElement>(`#car-markers [data-map-driver="${focusedMarker}"]`)?.focus({preventScroll:true});
  const teams=[...new Set(race.cars.map(c=>c.team))];
  setHTML('#map-legend',teams.map(team=>{const cars=race.cars.filter(c=>c.team===team);return `<div><span class="constructor-label" style="--constructor:${cars[0].color}">${team}</span>${cars.map(c=>`<button data-map-driver="${c.id}" aria-pressed="${c.id===inspectedDriver}" style="--constructor:${c.color}"><b>${driverNumber(c)}</b> ${c.code}</button>`).join('')}</div>`;}).join(''));
  const inspected=race.cars.find(c=>c.id===inspectedDriver)!;
  $('#map-driver').innerHTML=`<span style="color:${inspected.color}">●</span><b>${driverNumber(inspected)} ${inspected.name}</b><span>${inspected.team}</span><strong>P${order(race).findIndex(c=>c.id===inspected.id)+1}</strong><span>${inspected.compound.toUpperCase()} · ${Math.floor(inspected.age)} LAPS</span>`;
  renderStrategy();renderPace();renderRadio();renderQuestion();
  if(race.status==='finished'&&season&&race.config.setup.mode==='season'){const recorded=recordRace(season,race);if(recorded!==season){season=recorded;saveSeason(season);}}
  if(race.status==='finished'&&!debrief){
    // Let the drivers hear their result before the debrief covers the wall.
    finishedWall||=performance.now();
    const settled=!convo.questions.length&&!voice.busy&&!onAir;
    if((settled&&performance.now()-finishedWall>2500)||performance.now()-finishedWall>20000){debrief=true;showDebrief();}
  }
}
function renderRadio(){
  const log=$('#messages');const bottom=log.scrollHeight-log.scrollTop-log.clientHeight<60;
  const fresh=convo.lines.filter(l=>l.id>lastLine);
  if(!fresh.length)return;
  log.innerHTML=convo.lines.slice(-60).map(radioLine).join('');
  if(bottom)log.scrollTop=log.scrollHeight;
  lastLine=fresh.at(-1)!.id;
  for(const l of fresh)if(l.voice)voice.line({text:l.text,speaker:l.speaker,priority:l.priority,at:l.at,ttl:l.ttl});
  // With audio off the subtitles still follow the conversation.
  // Same rule as the voice queue: the most urgent new line wins, newest breaks ties.
  const latest=fresh.filter(l=>l.voice).sort((x,y)=>y.priority-x.priority||y.id-x.id)[0];
  if(latest&&(!voice.enabled||!voice.ready)&&!onAir)showTransmission(latest.speaker,latest.text);
}
function renderQuestion(){
  const q=convo.questions.at(-1);const bar=$('#question');
  if(!q){bar.hidden=true;bar.dataset.id='';return;}
  bar.hidden=false;
  const left=race.status==='finished'?null:Math.max(0,q.deadline-race.elapsed);
  $('#question-timer').textContent=left===null?'':`${left}s`;
  if(bar.dataset.id!==String(q.id)){
    bar.dataset.id=String(q.id);
    $('#question-prompt').textContent=q.prompt;
    $('#question-options').innerHTML=q.options.map((o,i)=>`<button data-reply="${esc(o.reply)}" class="${i===0?'primary-reply':''}">${esc(o.label)}${i===0?' <kbd>Y</kbd>':i===q.options.length-1&&q.options.length>1?' <kbd>N</kbd>':''}</button>`).join('');
  }
}
function renderStrategy() {
  const c=playerCar(race,selected)!;const remain=Math.ceil(race.config.totalLaps-c.distance);const forecast=pitForecast(race,c);
  if(c.finishedAt!==null){setHTML('#strategy',`<div class="strategy-callout"><div class="eyebrow">CHEQUERED FLAG</div><h3>Car home. Job done.</h3><p>${c.name} finishes P${order(race).findIndex(x=>x.id===c.id)+1}. Open the debrief using the play control.</p></div>`);return;}
  document.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(b=>{b.classList.toggle('active',Number(b.dataset.select)===selected);b.setAttribute('aria-pressed',String(Number(b.dataset.select)===selected));});
  setHTML('#strategy',`<div class="strategy-callout"><div class="eyebrow">${c.pitOrder?'PIT CALL CONFIRMED':c.wear>0.78?'PIT WINDOW OPEN':'ENGINEER’S OUTLOOK'}</div><h3>${c.pitOrder?'Box for '+c.pitOrder+'s':c.wear>0.78?'Fresh tyres. Fresh options.':'Keep the long game in mind.'}</h3><p>${c.pitRemaining?'Crew working. '+c.pitRemaining+' seconds of pit-lane loss remaining.':race.flag==='safety'?'The field is bunching up. Pit loss is lower now; watch for a double stack.':c.wear>0.78?'Degradation is costing lap time. A fresh set may recover the pit loss.':'Pit now and rejoin around P'+forecast.position+'. That forecast assumes the field holds its current pace.'}</p></div><div class="strategy-metrics"><div><span>Est. pit loss</span><strong>${pitLoss(race).toFixed(1)}s</strong></div><div><span>Projected pit exit</span><strong>P${forecast.position} · ${forecast.ahead}</strong></div><div><span>Laps remaining</span><strong>${remain}</strong></div><div><span>Current pace estimate</span><strong>${formatTime(lapPace(c,race))}</strong></div></div><div class="compound-heading">NEXT STOP COMPOUND</div><div class="compound-options">${(race.config.weather?[...SLICKS,'inter' as Compound]:SLICKS).map(t=>`<button data-compound="${t}" class="${nextTyre[selected]===t?'active':''}" style="--tyre:${TYRES[t].color}" aria-pressed="${nextTyre[selected]===t}"><b>${t[0].toUpperCase()}</b>${t}</button>`).join('')}</div><button class="strategy-box" data-car="${selected}" data-action="pit">${c.pitOrder?'UPDATE PIT CALL':'CALL '+c.code+' INTO THE BOX'} <span>↗</span></button><div class="mode-controls"><button data-car="${selected}" data-action="balanced">Normal pace</button><button data-car="${selected}" data-action="conserve">Conserve tyres</button></div>`);
}
function renderPace() {
  const a=playerCar(race,1)!,b=playerCar(race,2)!;const times=[...a.lapTimes,...b.lapTimes];
  if(!times.length) {$('#pace').innerHTML='<div class="chart-empty"><div class="chart-grid"></div><span>Telemetry appears after your first complete lap</span></div>';return;}
  const min=Math.floor(Math.min(...times)-2),max=Math.ceil(Math.max(...times)+2);const y=(v:number)=>100-(v-min)/(max-min)*76;
  const span=Math.max(1,race.config.totalLaps-race.config.startLap-1),x=(i:number)=>38+i/span*510;
  const series=(c:Car,color:string)=>`<polyline fill="none" stroke="${color}" stroke-width="2" points="${c.lapTimes.map((v,i)=>`${x(i)},${y(v)}`).join(' ')}"/>${c.lapTimes.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${color}"/>`).join('')}`;
  $('#pace').innerHTML=`<svg viewBox="0 0 570 125" role="img" aria-label="Completed lap times for Laurent and Reyes">${[min,(min+max)/2,max].map(v=>`<line x1="38" y1="${y(v)}" x2="550" y2="${y(v)}" stroke="#29332d" stroke-dasharray="3 5"/><text x="0" y="${y(v)+3}" fill="#88988b" font-size="9">${v.toFixed(0)}s</text>`).join('')}${series(a,'#c4f17b')}${series(b,'#8fb8dc')}<text x="38" y="119" fill="#88988b" font-size="9">L${race.config.startLap+1}</text><text x="530" y="119" fill="#88988b" font-size="9">L${race.config.totalLaps}</text></svg>`;
}
function interruptRadio(){thinking=null;brain.cancelReplies();voice.interrupt();}
/** Dashboard buttons: same acknowledgement path as radio calls. */
function send(command:Command) {interruptRadio();convo.recentCar=command.car;convo.execute(race,[command]);render();}
function submit(text:string) {
  if(!text.trim())return;
  // Your call cuts the line on air; the rest of the team's queued radio still plays.
  thinking=null;brain.cancelReplies();voice.cut();
  const call=convo.hear(race,text);
  if(call)askBrain(call);
  render();
}
function askBrain(call:BrainCall){
  thinking=call;
  const profile=voiceProfile(call.speaker);
  $('#speaker-label').textContent=profile.label;$('#speaker-avatar').textContent=profile.initials;
  $('#subtitle').textContent=`${profile.short} is answering…`;$('#transmission-state').textContent='STAND BY';
  $('.on-air-panel').classList.add('active');lastAirTime=performance.now();
  // The question itself is the newest line; the model sees the radio just before it.
  const request={id:Date.now(),speaker:call.speaker,car:call.car,text:call.text,facts:raceFacts(race,call.car,call.speaker),recent:convo.recentRadio(5).slice(0,-1)};
  const forRace=race;
  brain.reply(request)
    .then(say=>{if(race===forRace&&thinking===call)convo.brainReply(race,call,say);})
    .catch(e=>{if(race===forRace&&thinking===call)convo.brainReply(race,call,null,e instanceof Error?e.message:String(e));})
    .finally(()=>{if(thinking===call){thinking=null;$('#transmission-state').textContent='RADIO LINK';}render();});
}
function beginRace(){
  race.status='running';convo.start(race);
}
const INSTRUCTIONS=`<div class="brief-instructions"><p><b>You run the strategy.</b> Pick a compound, call a pit stop, and manage each driver’s pace. The team talks to you: drivers ask to push or box, and your strategist brings decisions when the race turns. Answer “yes” or “no”, use the quick replies, or give your own call: “car two, box for mediums”, “Theo, let Nico through”. The race slows to 1× when someone needs an answer.</p><p><b>Replay fairly.</b> The same race and seed with the same calls always produce the same result. After the flag, compare with a sensible default engineer and see what each call was worth.</p></div>`;
let radioLoadingStatus='Preparing radio voices…',chatLoadingStatus='Preparing team chat…',modelsOnDisk=false;
function loadingNote(){return modelsOnDisk?'Loading from this computer. Pick your race while your team gets ready.':'One-time download of about 1.4 GB on the first visit; later visits load from the browser’s copy. Pick your race while your team gets ready.';}
// ───────────── team setup ─────────────
// Capable computers download and set up the neural voices and team chat before the first race
// (the start button waits, with start lights filling up). Phones and weak devices get the
// lite radio: text plus the recorded team clips, nothing large downloaded.
const RADIO_KEY='pitwall.radio';
let device:TierChoice|null=null;
let voiceFailure:string|null=null,chatFailure:string|null=null,withoutChat=false,readySince=0;
function radioOverride(){const asked=new URLSearchParams(location.search).get('radio');if(asked==='full'||asked==='lite')return asked;try{return localStorage.getItem(RADIO_KEY);}catch{return null;}}
function gate(){
  if(!device)return {ready:false,fraction:0};
  if(device.tier==='lite')return {ready:true,fraction:1};
  const fraction=setupProgress({voice:{progress:voice.progress,ready:voice.ready},chat:{progress:brain.progress,warming:brain.warming,ready:brain.ready||withoutChat}});
  return {ready:voice.ready&&(brain.ready||withoutChat),fraction};
}
function startTeamSetup(){
  voiceFailure=null;
  // Voices first: they carry the race; team chat would compete with them for bandwidth and the GPU.
  void voice.preload().catch(e=>{voiceFailure=e instanceof Error?e.message:String(e);}).finally(()=>{updateLoading();if(!brain.ready)void prepareTeamChat();});
}
function useLite(reason:string,forced=true){
  device={tier:'lite',reason,forced};voice.neural=false;
  radioLoadingStatus='Text radio with recorded team clips';chatLoadingStatus='Team chat is off on this device';
  const button=$<HTMLButtonElement>('#brain-enable');button.disabled=false;button.textContent='Load team chat anyway · 1 GB';
}
function loadingHTML(){
  if(!device)return `<div class="team-loading" data-gate><div class="gate-head"><b>CHECKING THIS DEVICE…</b></div></div>`;
  if(device.tier==='lite')return `<div class="team-loading lite" data-gate><div class="gate-head"><b>TEXT RADIO ON THIS DEVICE</b></div><p>Your team talks on screen, with recorded team clips. Neural voices and team chat need a desktop browser with GPU access and a one-time 1.4 GB download${device.forced?'':` (this looks like a ${esc(device.reason)})`}.</p><div class="gate-actions"><button type="button" class="secondary" data-gate-action="full">Load voices and team chat anyway</button></div></div>`;
  return `<div class="team-loading" data-gate aria-label="Team preparation"><div class="gate-head"><b data-gate-title>PREPARING YOUR TEAM</b><span data-gate-pct>0%</span></div><div class="start-lights" data-lights aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div class="gate-bar"><span data-gate-bar></span></div><p data-loading-radio>${esc(radioLoadingStatus)}</p><p data-loading-chat>${esc(chatLoadingStatus)}</p><p class="gate-warn" data-gate-warn hidden></p><div class="gate-actions" data-gate-actions></div><small data-loading-note>${loadingNote()}</small></div>`;
}
/** Re-render the setup panel (after the device check, or a switch between full and text radio). */
function refreshLoader(){document.querySelectorAll('[data-gate]').forEach(el=>el.outerHTML=loadingHTML());updateLoading();}
function updateLoading(){
  document.querySelectorAll('[data-loading-radio]').forEach(el=>el.textContent=radioLoadingStatus);document.querySelectorAll('[data-loading-chat]').forEach(el=>el.textContent=chatLoadingStatus);document.querySelectorAll('[data-loading-note]').forEach(el=>el.textContent=loadingNote());
  const g=gate(),pct=Math.round(g.fraction*100);
  if(g.ready&&!readySince)readySince=performance.now();
  // The lights go out once, when the team becomes ready; a later re-render shows them already out.
  const instant=g.ready&&performance.now()-readySince>2500;
  document.querySelectorAll('[data-gate]').forEach(el=>el.classList.toggle('ready',g.ready));
  document.querySelectorAll('[data-gate-title]').forEach(el=>el.textContent=g.ready?'LIGHTS OUT · YOUR TEAM IS READY':'PREPARING YOUR TEAM');
  document.querySelectorAll('[data-gate-pct]').forEach(el=>el.textContent=g.ready?'READY':`${pct}%`);
  document.querySelectorAll<HTMLElement>('[data-gate-bar]').forEach(el=>el.style.width=`${g.ready?100:pct}%`);
  const lit=g.ready?5:lightsOn(g.fraction);
  document.querySelectorAll('[data-lights]').forEach(el=>{Array.from(el.children).forEach((light,i)=>{light.classList.toggle('on',i<lit);light.classList.toggle('next',!g.ready&&i===lit);});el.classList.toggle('out',g.ready);el.classList.toggle('instant',instant);});
  // A failed download never traps the player: retry, or race on with what did load.
  const actions=voiceFailure?`<button type="button" class="secondary" data-gate-action="retry-voices">Retry voices</button><button type="button" class="secondary" data-gate-action="text-radio">Race with text radio</button>`
    :chatFailure&&!withoutChat?`<button type="button" class="secondary" data-gate-action="retry-chat">Retry team chat</button><button type="button" class="secondary" data-gate-action="no-chat">Race without team chat</button>`:'';
  document.querySelectorAll('[data-gate-actions]').forEach(el=>{if(el.innerHTML!==actions)el.innerHTML=actions;});
  // CPU voices render about 3x slower than speech: say so, rather than let the radio lag without explanation.
  const slowVoices=voice.ready&&voice.device==='wasm';
  document.querySelectorAll<HTMLElement>('[data-gate-warn]').forEach(el=>{el.hidden=!slowVoices;el.textContent=slowVoices?'Voices are running on the CPU in this browser, about 3× slower than speech, so the team will sound late. A browser with GPU access (Chrome, for example) gives smooth radio.':'';});
  const start=document.querySelector<HTMLButtonElement>('#start-session');
  if(start&&race.status==='ready'){
    start.dataset.label??=start.innerHTML;
    start.disabled=!g.ready;start.classList.toggle('gated',!g.ready);
    const label=g.ready?start.dataset.label:`PREPARING YOUR TEAM · ${pct}% <span class="gate-spinner"></span>`;
    if(start.innerHTML!==label)start.innerHTML=label;
  }
}
document.addEventListener('click',e=>{
  const action=(e.target as Element).closest<HTMLButtonElement>('[data-gate-action]')?.dataset.gateAction;if(!action)return;
  if(action==='full'){try{localStorage.setItem(RADIO_KEY,'full');}catch{/* private mode */}device={tier:'full',reason:'chosen on this browser',forced:true};voice.neural=true;radioLoadingStatus='Preparing radio voices…';chatLoadingStatus='Preparing team chat…';refreshLoader();startTeamSetup();return;}
  if(action==='retry-voices')startTeamSetup();
  if(action==='text-radio'){useLite('text radio chosen');refreshLoader();return;}
  if(action==='retry-chat'){chatFailure=null;void prepareTeamChat();}
  if(action==='no-chat')withoutChat=true;
  updateLoading();
});
function headsetHTML(){return `<label class="brief-audio"><input type="checkbox" id="brief-audio" ${race.status==='ready'||voice.enabled?'checked':''}> Headset on · local neural voices, radio cues & race ambience</label>`;}
/** Switch to another race while the picker is open: rebuild the race behind the modal. */
function choose(next:RaceSetup){
  setup=next;try{localStorage.setItem(SETUP_KEY,JSON.stringify({scenario:next.scenario,mode:next.mode,circuit:next.circuit,distance:next.distance,start:next.start}));}catch{/* private mode */}
  reset(false);showBriefing();
}
const tyreSelect=(n:1|2,value:Compound,attr:string)=>`<select ${attr}="${n}" aria-label="${n===1?'Theo':'Nico'} starting tyre">${SLICKS.map(t=>`<option value="${t}" ${value===t?'selected':''}>${t}</option>`).join('')}</select>`;
function seasonHTML(){
  if(!season){
    return `<p class="modal-intro">All ${CALENDAR_2026.length} rounds of the 2026 calendar as full races against a fictional 22-driver grid. Drivers’ and constructors’ standings are saved in this browser. Race the rounds you care about and simulate the rest.</p><div class="full-options"><div class="segmented" role="group" aria-label="Season race distance">${(['sprint','half','full'] as Distance[]).map(d=>`<button data-season-distance="${d}" class="${seasonDraft.distance===d?'active':''}" aria-pressed="${seasonDraft.distance===d}">${d==='sprint'?'Sprint races':d==='half'?'Half distance':'Full distance'}</button>`).join('')}</div><label>Theo starts on ${tyreSelect(1,seasonDraft.start[1],'data-season-start')}</label><label>Nico starts on ${tyreSelect(2,seasonDraft.start[2],'data-season-start')}</label></div><button id="season-new" class="primary">START THE 2026 SEASON <span>↗</span></button>`;
  }
  const next=nextRound(season),table=standings(season);
  const pos=(id:number)=>table.drivers.findIndex(d=>d.id===id)+1;
  const name=(id:number)=>ROSTER[id].name;
  const driverRows=table.drivers.filter((d,i)=>i<10||d.id===1||d.id===4).map(d=>`<tr class="${d.id===1||d.id===4?'ours':''}"><td>${pos(d.id)}</td><td><span class="team-dot" style="background:${ROSTER[d.id].color}"></span>${esc(name(d.id))}</td><td>${d.wins}</td><td>${d.points}</td></tr>`).join('');
  const teamRows=table.teams.map((t,i)=>`<tr class="${t.team==='Apex'?'ours':''}"><td>${i+1}</td><td><span class="team-dot" style="background:${t.color}"></span>${esc(t.team)}</td><td>${t.points}</td></tr>`).join('');
  const calendar=CALENDAR_2026.map(r=>{const res=season!.results.find(x=>x.round===r.round);const current=next?.round===r.round;
    const detail=res?`${ROSTER[res.order[0]].code} won · LAU P${res.order.indexOf(1)+1} · REY P${res.order.indexOf(4)+1}${res.simulated?' · sim':''}`:current?'NEXT':r.date;
    return `<li class="${current?'next':res?'done':''}"><b>R${r.round}</b><span>${esc(r.gp.replace(' Grand Prix',''))}</span><small>${esc(detail)}</small></li>`;}).join('');
  const champion=seasonOver(season)?table.drivers[0]:null;
  const head=next
    ?`<h3 class="season-next">Round ${next.round} of ${CALENDAR_2026.length} · ${esc(next.gp)}</h3><p class="modal-intro">${esc(CIRCUITS[next.circuit].name)}, ${esc(CIRCUITS[next.circuit].country)} · ${esc(next.date)} · ${fullRaceLaps(CIRCUITS[next.circuit],season.distance)} laps${next.note?` · ${esc(next.note)}`:''}. ${season.results.length?`Theo is P${pos(1)} and Nico P${pos(4)} in the championship; Apex is P${table.teams.findIndex(t=>t.team==='Apex')+1} in the constructors’.`:'The season starts here: everyone on zero points.'}</p>`
    :`<h3 class="season-next">Season complete</h3><p class="modal-intro">${esc(name(champion!.id))} is the 2026 champion with ${champion!.points} points. Theo finished P${pos(1)}, Nico P${pos(4)}, and Apex P${table.teams.findIndex(t=>t.team==='Apex')+1} in the constructors’.</p>`;
  return `${head}<div class="season-grid"><div><span class="eyebrow">DRIVERS</span><table class="standings"><tbody>${driverRows}</tbody></table></div><div><span class="eyebrow">CONSTRUCTORS</span><table class="standings"><tbody>${teamRows}</tbody></table></div><div><span class="eyebrow">CALENDAR</span><ol class="season-calendar">${calendar}</ol></div></div><div class="debrief-actions">${next?`<button id="season-sim" class="secondary">Simulate round ${next.round}</button>`:''}<button id="season-abandon" class="secondary">${next?'Abandon season':'Start a new season'}</button></div>`;
}
function pickerHTML(){
  const mode=setup.mode,circuit=circuitOf(setup),scenario=scenarioById(setup.scenario);
  const tab=(m:RaceSetup['mode'],label:string)=>`<button data-pick-mode="${m}" class="${mode===m?'active':''}" aria-pressed="${mode===m}">${label}</button>`;
  const grid=[1,2].map(n=>positionOf(race,playerCar(race,n)!));
  let body='';
  if(mode==='scenario'){
    body=`<div class="race-cards">${SCENARIOS.map(x=>`<button class="race-card ${x.id===scenario.id?'selected':''}" data-pick-scenario="${x.id}" aria-pressed="${x.id===scenario.id}"><span class="card-kicker">${x.number} · ${esc(CIRCUITS[x.circuit].city.toUpperCase())}</span><b>${esc(x.title)}</b><p>${esc(x.summary)}</p><span class="card-goals">THEO ${objectiveLabel(x.objectives[1])} · NICO ${objectiveLabel(x.objectives[2])}</span></button>`).join('')}</div><p class="modal-intro">${esc(scenario.intro)}</p><div class="brief-grid"><div><b>01 / THEO LAURENT</b><p>${esc(scenario.theo)}</p></div><div><b>02 / NICO REYES</b><p>${esc(scenario.nico)}</p></div></div>`;
  }else if(mode==='full'){
    body=`<div class="circuit-chips">${CALENDAR_2026.map(r=>{const c=CIRCUITS[r.circuit];return `<button class="circuit-chip ${c.id===circuit.id?'selected':''}" data-pick-circuit="${c.id}" aria-pressed="${c.id===circuit.id}"><b>${esc(c.city)}</b><small>${c.laps} laps${c.rainChance>=0.3?' · rain':''}${c.overtake>=1.2?' · no passing':''}</small></button>`;}).join('')}</div><div class="full-options"><div class="segmented" role="group" aria-label="Race distance">${(['sprint','half','full'] as Distance[]).map(d=>`<button data-pick-distance="${d}" class="${setup.distance===d?'active':''}" aria-pressed="${setup.distance===d}">${d==='sprint'?'Sprint':d==='half'?'Half':'Full'} · ${fullRaceLaps(circuit,d)} laps</button>`).join('')}</div><label>Theo starts on ${tyreSelect(1,setup.start?.[1]??'medium','data-pick-start')}</label><label>Nico starts on ${tyreSelect(2,setup.start?.[2]??'medium','data-pick-start')}</label><span class="seed">Seed ${race.seed} <button data-pick-seed>New seed</button></span></div><div class="brief-grid"><div><b>01 / THEO LAURENT</b><p>Qualified P${grid[0]} of ${race.cars.length}. Target: ${objectiveLabel(race.config.objectives[1]).toLowerCase()}.</p></div><div><b>02 / NICO REYES</b><p>Qualified P${grid[1]} of ${race.cars.length}. Target: ${objectiveLabel(race.config.objectives[2]).toLowerCase()}.</p></div></div><p class="modal-intro">${esc(circuit.name)}. Lights out from the grid with the full field. Safety cars${circuit.rainChance?' and rain':''} depend on the seed, so a replay with the same seed is the same race. At 1× this race takes about ${Math.round(race.config.totalLaps*circuit.lapTime/60)} minutes; use 5×–60× and the team will slow you down when they need you.</p>`;
  }else body=seasonHTML();
  const startable=mode!=='season'||(!!season&&!seasonOver(season));
  const label=mode==='season'&&season?`RACE ROUND ${nextRound(season)?.round} <span>↗</span>`:'TAKE THE PIT WALL <span>↗</span>';
  return `<div class="modal-kicker">PITWALL / CHOOSE YOUR RACE</div><h2>Take the pit wall.</h2><div class="race-mode" role="group" aria-label="Race type">${tab('scenario',`Scenarios · ${SCENARIOS.length}`)}${tab('full','Full race')}${tab('season','Season 2026')}</div>${body}${INSTRUCTIONS}${headsetHTML()}<div class="scenario-note">Fictional teams and drivers · Real 2026 venues and calendar · Synthetic pace data · Schematic circuits<br>Prototype: simplified strategy physics, no historical result claims.</div>${startable?`<button id="start-session" class="primary">${label}</button>`:''}`;
}
function briefHTML(){
  const cfg=race.config,scenario=scenarioById(cfg.setup.scenario),title=raceTitle(cfg.setup),full=cfg.setup.mode!=='scenario';
  const intro=full?`${cfg.totalLaps} laps at ${esc(circuitOf(cfg.setup).name)}. Seed ${race.seed}.${cfg.setup.brief?` ${esc(cfg.setup.brief.replace(/ Lights out!$/,''))}`:''}`:esc(scenario.intro);
  return `<div class="modal-kicker">PITWALL / ${esc(title.kicker)}</div><h2>${esc(title.title)}.</h2><p class="modal-intro">${intro}</p>${full?'':`<div class="brief-grid"><div><b>01 / THEO LAURENT</b><p>${esc(scenario.theo)}</p></div><div><b>02 / NICO REYES</b><p>${esc(scenario.nico)}</p></div></div>`}${INSTRUCTIONS}${headsetHTML()}<div class="debrief-actions"><button id="change-race" class="secondary">Choose another race</button><button id="start-session" class="primary">BACK TO THE PIT WALL <span>↗</span></button></div>`;
}
function showBriefing() {
  const modal=$<HTMLDialogElement>('#modal');modal.classList.remove('debrief-modal');
  const picking=race.status==='ready';
  modal.classList.toggle('picker-modal',picking);
  modal.innerHTML=picking?pickerHTML():briefHTML();
  modal.querySelector('h2')?.insertAdjacentHTML('afterend',loadingHTML());
  updateLoading();
  if(!modal.open)modal.showModal();
  const on=<T extends HTMLElement>(sel:string,fn:(el:T)=>void)=>modal.querySelectorAll<T>(sel).forEach(fn);
  if(picking){
    on<HTMLButtonElement>('[data-pick-mode]',b=>b.onclick=()=>{
      const mode=b.dataset.pickMode as RaceSetup['mode'];if(mode===setup.mode)return;
      if(mode==='season')choose((season&&seasonSetup(season))||{...setup,mode:'season',round:undefined,brief:undefined});
      else if(mode==='full')choose({...setup,mode,circuit:circuitOf(setup).id,round:undefined,brief:undefined,seed:newSeed()});
      else choose({...setup,mode,scenario:SCENARIOS.some(x=>x.id===setup.scenario)?setup.scenario:SCENARIOS[0].id,round:undefined,brief:undefined,seed:scenarioById(setup.scenario).seed});
    });
    on<HTMLButtonElement>('[data-pick-scenario]',b=>b.onclick=()=>choose({...setup,scenario:b.dataset.pickScenario!,seed:scenarioById(b.dataset.pickScenario!).seed}));
    on<HTMLButtonElement>('[data-pick-circuit]',b=>b.onclick=()=>choose({...setup,circuit:b.dataset.pickCircuit!,seed:newSeed()}));
    on<HTMLButtonElement>('[data-pick-distance]',b=>b.onclick=()=>choose({...setup,distance:b.dataset.pickDistance as Distance}));
    on<HTMLSelectElement>('[data-pick-start]',sel=>sel.onchange=()=>{const start={1:setup.start?.[1]??'medium',2:setup.start?.[2]??'medium'} as {1:Compound;2:Compound};start[Number(sel.dataset.pickStart) as 1|2]=sel.value as Compound;choose({...setup,start});});
    modal.querySelector<HTMLButtonElement>('[data-pick-seed]')?.addEventListener('click',()=>choose({...setup,seed:newSeed()}));
    // Season controls.
    on<HTMLButtonElement>('[data-season-distance]',b=>b.onclick=()=>{seasonDraft.distance=b.dataset.seasonDistance as Distance;showBriefing();});
    on<HTMLSelectElement>('[data-season-start]',sel=>sel.onchange=()=>{seasonDraft.start[Number(sel.dataset.seasonStart) as 1|2]=sel.value as Compound;});
    modal.querySelector<HTMLButtonElement>('#season-new')?.addEventListener('click',()=>{season=newSeason(seasonDraft.distance,newSeed(),{...seasonDraft.start});saveSeason(season);choose(seasonSetup(season)!);});
    modal.querySelector<HTMLButtonElement>('#season-sim')?.addEventListener('click',()=>{season=simulateRound(season!).season;saveSeason(season);choose(seasonSetup(season)??{...setup});});
    modal.querySelector<HTMLButtonElement>('#season-abandon')?.addEventListener('click',()=>{if(!seasonOver(season!)&&!confirm('Abandon this season? Its standings will be deleted.'))return;season=null;saveSeason(null);choose({...setup,mode:'season',round:undefined,brief:undefined});});
  }else $('#change-race').onclick=()=>{modal.close();reset(true,true);};
  modal.querySelector<HTMLButtonElement>('#start-session')?.addEventListener('click',async()=>{
    const starting=race.status==='ready';
    // A new race waits for the team setup (the button stays locked until then).
    if(starting&&!gate().ready)return;
    setAudio($<HTMLInputElement>('#brief-audio').checked);
    // Text radio: open the channel for the recorded team clips. Mid-race, voices that dropped out reload in the background.
    if(starting&&voice.enabled&&!voice.ready){
      const button=$<HTMLButtonElement>('#start-session');button.disabled=true;button.textContent='CONNECTING TEAM RADIO…';button.dataset.connecting='1';
      try{await voice.connect();}catch{button.disabled=false;delete button.dataset.connecting;button.textContent='RETRY HEADSET · or uncheck Headset to play muted';return;}
      button.disabled=false;delete button.dataset.connecting;
    }
    modal.close();modal.classList.remove('picker-modal');briefing=false;if(starting)beginRace();lastFrame=performance.now();render();});
}
function outcome(n:1|2,pos:number){
  const ob=race.config.objectives[n],name=n===1?'Theo':'Nico',ok=onTarget(race,n,pos);
  if(ob.kind==='beat'){const rival=ROSTER[ob.rival].name.split(' ')[1];return ok?`${name} finished ahead of ${rival}.`:`${rival} finished ahead of ${name}.`;}
  const goal=ob.max===1?'the win':ob.max===3?'the podium':`the top ${ob.max}`;
  return ok?`${name} delivered ${goal}.`:`${name} missed ${goal}.`;
}
function showDebrief() {
  const modal=$<HTMLDialogElement>('#modal');const result=order(race);const a=result.findIndex(c=>c.id===1)+1,b=result.findIndex(c=>c.id===4)+1;
  modal.classList.add('debrief-modal');
  const both=onTarget(race,1,a)&&onTarget(race,2,b);
  const inSeason=race.config.setup.mode==='season'&&!!season;
  const table=inSeason?standings(season!):null,dpos=(id:number)=>table!.drivers.findIndex(d=>d.id===id)+1;
  const seasonBlock=inSeason?`<div class="debrief-section"><h3>Championship after round ${race.config.setup.round}</h3><p>Theo P${dpos(1)} (${table!.drivers[dpos(1)-1].points} pts) · Nico P${dpos(4)} (${table!.drivers[dpos(4)-1].points} pts) · Apex P${table!.teams.findIndex(t=>t.team==='Apex')+1} in the constructors’ (${table!.teams.find(t=>t.team==='Apex')!.points} pts). Leader: ${esc(ROSTER[table!.drivers[0].id].name)}, ${table!.drivers[0].points} pts.</p></div>`:'';
  modal.innerHTML=`<div class="modal-kicker">ENGINEERING DEBRIEF / ${esc(raceTitle(race.config.setup).title.toUpperCase())} / SEED ${race.seed}</div><h2>${both?'A team result.':'Every call is a lesson.'}</h2><p class="modal-intro">${outcome(1,a)} ${outcome(2,b)}</p><div class="result-grid">${[1,2].map(n=>{const c=playerCar(race,n)!;return `<div><span>${c.name}</span><strong>P${result.findIndex(x=>x.id===c.id)+1}</strong><small>${c.stops} stops · ${c.trust}% outcome-based trust</small></div>`;}).join('')}</div>${seasonBlock}<div id="comparison">${comparison?comparisonHTML():`<p class="analysis-progress" role="status">${analysisProgress||'Replaying default strategy and testing pit plans…'}</p>`}</div><div class="debrief-actions"><button id="inspect" class="secondary">Inspect pit wall</button><button id="choose" class="secondary">Choose another race</button>${inSeason?`<button id="next-round" class="primary">${nextRound(season!)?`NEXT ROUND · ${esc(nextRound(season!)!.gp.toUpperCase())}`:'SEASON STANDINGS'} ↗</button>`:'<button id="restart" class="primary">REPLAY THIS RACE ↗</button>'}</div>`;
  if(!modal.open)modal.showModal();
  $('#inspect').onclick=()=>modal.close();$('#choose').onclick=()=>{modal.close();reset(true,true);};
  modal.querySelector<HTMLButtonElement>('#restart')?.addEventListener('click',()=>{modal.close();reset(true);});
  modal.querySelector<HTMLButtonElement>('#next-round')?.addEventListener('click',()=>{modal.close();setup=seasonSetup(season!)??{...setup,round:undefined,brief:undefined};reset(true);});
  if(!comparison&&!analysisWorker)startAnalysis();
}
function startAnalysis(){
  analysisWorker=new Worker(new URL('./analysis-worker.ts',import.meta.url),{type:'module'});
  const worker=analysisWorker;
  worker.onmessage=(e:MessageEvent)=>{
    if(worker!==analysisWorker)return;
    if(e.data.type==='progress'){analysisProgress=`Tested ${e.data.done} of ${e.data.total} strategies…`;const node=document.querySelector('#comparison .analysis-progress');if(node)node.textContent=analysisProgress;}
    if(e.data.type==='complete'){comparison=e.data.result;worker.terminate();analysisWorker=null;if(document.querySelector('#comparison'))$('#comparison').innerHTML=comparisonHTML();}
    if(e.data.type==='error'){worker.terminate();analysisWorker=null;analysisProgress='Analysis failed: '+e.data.message;const node=document.querySelector('#comparison');if(node)node.textContent=analysisProgress;}
  };
  worker.onerror=()=>{worker.terminate();analysisWorker=null;analysisProgress='Analysis worker failed. Reload and replay to try again.';const node=document.querySelector('#comparison');if(node)node.textContent=analysisProgress;};
  worker.postMessage({setup:race.config.setup,decisions:race.decisions});
}
function comparisonHTML() {
  const analysis=comparison!;
  const row=(label:string,result:Result)=>`<tr><th scope="row">${label}</th><td>P${result.positions[0]}</td><td>P${result.positions[1]}</td><td>${result.points}</td><td>${result.objectives}/2</td></tr>`;
  const alternatives=analysis.alternatives;
  const available=alternatives.filter(a=>a.result);
  const strongest=[...available].sort((a,b)=>(b.secondsGained??0)-(a.secondsGained??0))[0];
  const lesson=strongest&&strongest.secondsGained!>0.1?`Moving ${strongest.car===1?'Theo’s':'Nico’s'} “${strongest.action}” call one lap ${strongest.direction} would produce P${strongest.result!.positions[strongest.car-1]}, ${strongest.secondsGained!.toFixed(1)} seconds faster for that driver.`:available.length?'None of the tested single-call shifts improved that driver’s finish time. Your timing held up against these alternatives.':'No movable calls to compare yet. Try issuing a pit call during your next run.';
  return `<div class="debrief-section"><h3>A benchmark that races back</h3><div class="comparison-table"><table><thead><tr><th>STRATEGY</th><th>THEO</th><th>NICO</th><th>POINTS</th><th>GOALS</th></tr></thead><tbody>${row('Your race',analysis.actual)}${row('Default engineer',analysis.baseline.result)}${row('Best found',analysis.best.result)}</tbody></table></div><p>${esc(analysis.baseline.plan)}</p><div class="lesson"><span class="eyebrow">ONE THING TO TAKE INTO YOUR NEXT RACE</span><p>${esc(lesson)}</p></div></div><div class="debrief-section"><h3>Best strategy found <span>${analysis.candidates} replays tested</span></h3><p class="best-plan">${esc(analysis.best.plan)}</p><small>Ranks by race goals, then team points, then combined finish time. ${esc(analysis.method)} This is a bounded, hindsight search, not a proven global optimum.</small></div><div class="debrief-section"><h3>What if you made the call a lap earlier?</h3><p>One call moves at a time, using your original distance/time trace. Other calls keep their original times. Both cars and the field are re-simulated with the same per-car random events.</p>${alternatives.length?`<div class="whatifs">${alternatives.map(a=>`<article class="whatif"><div><b>${a.car===1?'THEO':'NICO'} · ${esc(a.action)}</b><time>${formatTime(a.originalAt)}</time></div><strong>One lap ${a.direction}${a.result?' → P'+a.result.positions[a.car-1]:''}</strong>${a.result?`<p>${Math.abs(a.secondsGained!).toFixed(1)}s ${a.secondsGained!>=0?'faster':'slower'} · Teammate P${a.result.positions[a.car===1?1:0]} · ${a.result.points} team points</p>`:''}<small>${esc(a.note)}</small></article>`).join('')}</div>`:'<p>No calls were recorded. Your next race will unlock per-call alternatives.</p>'}</div>`;
}
/** Start over. replay keeps the same race and seed; picking returns to the race picker. */
function reset(showPicker=true,newRace=false) {if(newRace&&setup.mode==='full')setup={...setup,seed:newSeed()};airedLines.clear();voiceInput.cancel();interruptRadio();race=createRace(setup);convo=newConversation();inspectedDriver=1;lastLine=0;thinking=null;comparison=null;analysisWorker?.terminate();analysisWorker=null;analysisProgress='';debrief=false;finishedWall=0;speed=1;accumulator=0;nextTyre[1]='medium';nextTyre[2]='medium';$('#messages').innerHTML='';setSpeed(1);renderChrome();render();if(showPicker)showBriefing();}
function setSpeed(n:number) {speed=n;convo.speed=n;document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(b=>{b.classList.toggle('active',Number(b.dataset.speed)===n);b.setAttribute('aria-pressed',String(Number(b.dataset.speed)===n));});}
app.addEventListener('click',e=>{
  const marker=(e.target as Element).closest('[data-map-driver]');
  if(marker){inspectedDriver=Number(marker.getAttribute('data-map-driver'));const car=race.cars.find(c=>c.id===inspectedDriver);if(car?.player){selected=car.id===1?1:2;convo.recentCar=selected;}render();return;}
  const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b)return;
  if(b.dataset.reply){submit(b.dataset.reply);return;}
  if(b.dataset.speed)setSpeed(Number(b.dataset.speed));
  if(b.dataset.select){selected=Number(b.dataset.select);convo.recentCar=selected;render();}
  if(b.dataset.compound){nextTyre[selected]=b.dataset.compound as Compound;renderStrategy();}
  if(b.dataset.action){const car=Number(b.dataset.car);const action=b.dataset.action as Command['action'];send(action==='pit'?{car,action,compound:nextTyre[car]}:{car,action} as Command);}
});
app.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&(e.target as Element).matches('.map-marker')){e.preventDefault();(e.target as Element).dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
$('#play').onclick=()=>{if(race.status==='finished'){showDebrief();return;}if(race.status==='ready'){if(!gate().ready){showBriefing();return;}briefing=false;$<HTMLDialogElement>('#modal').close();beginRace();}else race.status=race.status==='running'?'paused':'running';if(race.status==='paused')interruptRadio();accumulator=0;lastFrame=performance.now();render();};
$('#guide').onclick=()=>{guided=!guided;$('#guide').textContent=guided?'Hints on':'Hints off';$('#hint').hidden=!guided;document.body.classList.toggle('hints-off',!guided);};
function setAudio(enabled:boolean){voice.enabled=enabled;sound.setEnabled(enabled);$('#sound').textContent=enabled?'Audio on':'Audio off';$('#sound').setAttribute('aria-pressed',String(enabled));if(!enabled)interruptRadio();else voice.unlock();}
$('#sound').onclick=()=>{setAudio(!voice.enabled);if(voice.enabled)voice.prepare().then(()=>voice.say('Radio check. Pit wall online.','DATA ENGINEER')).catch(()=>{/* status shows the failure */});};
voice.onStatus=(text,error=false)=>{radioLoadingStatus=text;updateLoading();$('#radio-status').textContent=error?`${text} Race continues; use Load & hear voice to retry.`:text;$('#radio-status').classList.toggle('voice-error',error);const button=document.querySelector('#start-session');if(button instanceof HTMLButtonElement&&button.dataset.connecting)button.textContent=text;};
$('#radio-preview').onclick=async()=>{
  const button=$<HTMLButtonElement>('#radio-preview');button.disabled=true;
  if(race.status==='running')race.status='paused';
  interruptRadio();setAudio(true);
  if(!voice.neural){$('#radio-status').textContent='Text radio on this device. Choose “Load voices and team chat anyway” in the race menu for neural voices.';button.disabled=false;return;}
  const samples:Record<string,string>={LAU:'Copy. Rear tyres are going. Let’s get the stop right.',REY:'Come on, I’ve got the pace. Let me push!',STRATEGIST:'Safety car! Do we box? Both, one, or stay out?','TYRE SPECIALIST':'Front left is dropping off. We need to box this lap.','DATA ENGINEER':'Gap ahead, two point four. Keep it tidy.','RACE CONTROL':'Safety car deployed. Debris at turn nine.','PIT CREW':'Mediums ready. In you come.'};
  try{await voice.prepare();const speaker=$<HTMLSelectElement>('#radio-cast').value;voice.say(samples[speaker],speaker);}catch{/* Status shows recovery; never fall back to browser voices. */}finally{button.disabled=false;}
};
brain.onStatus=(text,error=false)=>{
  if(error)chatFailure=text;
  chatLoadingStatus=text;updateLoading();
  $('#brain-status').textContent=text;$('#brain-status').classList.toggle('voice-error',error);
  const button=$<HTMLButtonElement>('#brain-enable');
  button.disabled=!error;button.textContent=error?'Retry team chat':brain.ready?'Team chat ready':text;
};
async function prepareTeamChat(){
  chatFailure=null;
  try{await brain.enable();}catch(e){chatFailure=e instanceof Error?e.message:String(e);}
  updateLoading();
}
$('#brain-enable').onclick=()=>{void prepareTeamChat();};
$('#focus').onclick=()=>{const focus=document.body.classList.toggle('focus-mode');$('#focus').setAttribute('aria-pressed',String(focus));$('#focus').textContent=focus?'All telemetry':'Race view';};
$('#brief').onclick=()=>{if(race.status==='running')race.status='paused';showBriefing();render();};
$('#command-form').onsubmit=e=>{e.preventDefault();const input=$<HTMLInputElement>('#command');submit(input.value);input.value='';};
const voiceInput=new VoiceInput({
  state:(state,text)=>{
    const busy=['loading','requesting','listening','processing'].includes(state);
    voice.blocked=busy;sound.setTalking(busy||onAir);$<HTMLButtonElement>('#radio-preview').disabled=busy;
    $('#voice-state').textContent=state.toUpperCase();$('#voice-detail').textContent=text;
    $('#voice-detail').classList.toggle('voice-error',state==='error');
    $('#mic').classList.toggle('listening',state==='listening');
    $('#mic').innerHTML=state==='listening'?'■ <span>Finish call</span>':busy?'◌ <span>Please wait</span>':'◉ <span>Talk · R</span>';
    $<HTMLButtonElement>('#mic').disabled=busy&&state!=='listening';
    $<HTMLButtonElement>('#voice-check').disabled=busy;
    $<HTMLSelectElement>('#voice-engine').disabled=busy;
    $('#voice-cancel').hidden=!busy;
    if(state==='listening'){sound.cue('open');$('#subtitle').textContent='Your channel is open. The team is listening.';$('#speaker-label').textContent='YOU · RACE ENGINEER';}
  },
  level:value=>{$('#mic-level').style.width=`${Math.round(value*100)}%`;},
  transcript:(text,final)=>{
    $<HTMLInputElement>('#command').value=text;
    if(final){voice.blocked=false;sound.cue('close');submit(text);$<HTMLInputElement>('#command').value='';}
    else $('#voice-detail').textContent='Hearing: '+text;
  },
  error:text=>{convo.system(race,text);render();},
});
$('#mic').onclick=()=>{interruptRadio();setSpeed(1);void voiceInput.start();};
$('#voice-engine').onchange=()=>{voiceInput.cancel();voiceInput.engine=$<HTMLSelectElement>('#voice-engine').value as 'local'|'browser';$('#voice-detail').textContent=voiceInput.engine==='local'?'On-device mode: audio stays here. Click Talk when ready.':'Browser mode may send audio to its recognition service.';};
$('#voice-check').onclick=async()=>{
  interruptRadio();if(race.status==='running')race.status='paused';
  const text=await voiceInput.check();
  if(text){const parsed=parseIntent(text);const passed=parsed.kind==='command'&&parsed.command.car===2&&parsed.command.action==='pit';$('#voice-detail').textContent=`${passed?'Voice check passed':'Sample decoded; check recognition quality'}: “${text}”. Microphone was not used; no race command was issued.`;}
};
$('#voice-cancel').onclick=()=>voiceInput.cancel();
let holdingRadio=false;
const typing=(t:EventTarget|null)=>t instanceof Element&&!!t.closest('input,textarea,select,[contenteditable]');
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!$<HTMLDialogElement>('#modal').open&&!(e.target as Element).closest('input,textarea,select,button,a,[contenteditable]')){e.preventDefault();if(!['idle','error'].includes(voiceInput.state))return;holdingRadio=true;interruptRadio();setSpeed(1);void voiceInput.start();}});
function releaseRadio(){if(!holdingRadio)return;holdingRadio=false;if(voiceInput.state==='listening')voiceInput.stop();else voiceInput.cancel();}
document.addEventListener('keyup',e=>{if(e.code==='Space'&&holdingRadio){e.preventDefault();releaseRadio();}});
window.addEventListener('blur',()=>{if(holdingRadio){holdingRadio=false;voiceInput.cancel();}});
document.addEventListener('keydown',e=>{if(e.code==='KeyR'&&!e.repeat&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!$<HTMLDialogElement>('#modal').open&&!typing(e.target)){e.preventDefault();$('#mic').click();}});
// Y / N answer the newest question with its first / last quick reply.
document.addEventListener('keydown',e=>{
  if((e.code!=='KeyY'&&e.code!=='KeyN')||e.repeat||e.metaKey||e.ctrlKey||e.altKey||$<HTMLDialogElement>('#modal').open||typing(e.target))return;
  const q=convo.questions.at(-1);if(!q)return;
  const option=e.code==='KeyY'?q.options[0]:q.options.length>1?q.options.at(-1):undefined;
  if(option){e.preventDefault();submit(option.reply);}
});
voice.onAir=(speaker,text)=>{const line=[...convo.lines].reverse().find(l=>l.speaker===speaker&&l.text===text&&!airedLines.has(l.id));if(line){airedLines.add(line.id);document.querySelector(`[data-radio-id="${line.id}"]`)?.setAttribute('data-aired','true');}const question=convo.questions.find(q=>convo.lines.some(l=>l.question===q.id&&l.text===text));if(question)question.deadline=Math.max(question.deadline,race.elapsed+20);onAir=true;showTransmission(speaker,text);sound.setTalking(true);sound.cue('open');$('#transmission-state').textContent='TRANSMITTING';};
voice.onSilent=()=>{onAir=false;sound.setTalking(voice.blocked);sound.cue('close');$('#transmission-state').textContent=thinking?'STAND BY':'RADIO LINK';};
function showTransmission(speaker:string,text:string){
  if(voice.blocked)return;lastAirTime=performance.now();
  const profile=voiceProfile(speaker);
  $('#speaker-label').textContent=profile.label;$('#subtitle').textContent=text;$('#speaker-avatar').textContent=profile.initials;
  $('.on-air-panel').classList.add('active');
}
function renderRaceStory(){
  const sorted=order(race),car=playerCar(race,selected)!;
  const remaining=race.config.totalLaps-Math.floor(sorted[0].distance),wet=wetness(race);
  const scenario=scenarioById(race.config.setup.scenario),full=race.config.setup.mode!=='scenario';
  $('#race-headline').textContent=race.status==='finished'?'CHEQUERED FLAG':race.flag==='safety'?'THE WINDOW IS OPEN':wet>0.3?'RAIN FALLING':remaining<=5?'BRING IT HOME':car.pitRemaining?'EVERY SECOND COUNTS':full?raceTitle(race.config.setup).headline:scenario.headline;
  $('#race-stakes').textContent=race.flag==='safety'?'Safety car deployed. Lower pit loss. The field is closing up.':wet>0.3?'Inters or slicks: the crossover decides this race.':car.pitRemaining?`${car.code} in the pit lane · ${car.pitRemaining}s remaining`:remaining<=5?`${remaining} laps left. Make the tyres count.`:full?`${race.config.totalLaps} laps. Two cars. One strategy.`:scenario.stakes;
  $('#live-battles').innerHTML=race.cars.filter(c=>c.player).map(c=>{const position=sorted.indexOf(c)+1;const ahead=sorted[position-2];const gap=ahead?Math.max(0,(ahead.distance-c.distance)*lapPace(c,race)).toFixed(1):'0.0';return `<div class="battle-card ${c.id===1?'theo':'nico'}"><span>${c.id===1?'01 / THEO':'02 / NICO'}</span><b>P${position}</b><small>${c.finishedAt!==null?'FINISHED':c.pitRemaining?'IN PIT LANE · '+c.pitRemaining+'s':c.pitOrder?'BOX THIS LAP':ahead?'↗ '+gap+'s TO '+ahead.code:'LEADING THE RACE'}</small></div>`;}).join('');
  const path=$<SVGPathElement&HTMLElement>('#track-path'),length=path.getTotalLength();
  $('#car-trails').innerHTML=race.cars.filter(c=>c.player&&c.finishedAt===null).map(c=>`<path d="${trackPath()}" fill="none" stroke="${c.color}" stroke-width="8" stroke-linecap="round" opacity=".28" stroke-dasharray="${length*.065} ${length*.935}" stroke-dashoffset="${-((c.distance%1)-.065)*length}"/>`).join('');
  if(!onAir&&!thinking&&!convo.questions.length&&performance.now()-lastAirTime>8500)$('.on-air-panel').classList.remove('active');
}
$<HTMLDialogElement>('#modal').addEventListener('cancel',()=>{briefing=false;});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(race.status==='running')race.status='paused';interruptRadio();voiceInput.cancel();render();}});
let lastRender=0;
function frame(now:number) {
  const delta=Math.min((now-lastFrame)/1000,0.25);lastFrame=now;
  if(race.status==='running'&&!briefing) {
    const effectiveSpeed=voice.pace(speed);
    if(effectiveSpeed===0)accumulator=0;
    else accumulator+=delta*effectiveSpeed;
    while(accumulator>=1&&race.status==='running') {
      const previousFlag=race.flag,asked=convo.asked;
      step(race);convo.observe(race);accumulator--;
      // Offer events immediately, before another accelerated tick can age them out.
      renderRadio();
      // Flag changes and questions to the player bring the race back to real time.
      if(previousFlag!==race.flag||(convo.asked>asked&&speed>1)){setSpeed(1);accumulator=0;render();break;}
      if(voice.enabled&&voice.busy){accumulator=0;break;}
    }
  }
  convo.tick(race);
  if(now-lastRender>200){render();if(race.status==='running'&&voice.enabled&&voice.busy)$('#flag').textContent=voice.slow?'◌ PREPARING RADIO · RACING AT 1×':'● TEAM RADIO · 1×';lastRender=now;}
  requestAnimationFrame(frame);
}
renderChrome();render();showBriefing();requestAnimationFrame(frame);
// Begin loading immediately, before the player enters the race. No microphone or audio
// permission is needed to warm the workers; playback is unlocked by the start button.
// Model files saved by `npm run models` load from this computer instead of Hugging Face.
const localModels=findLocalModels();voice.local=localModels;brain.local=localModels;voiceInput.local=localModels;
void localModels.then(local=>{modelsOnDisk=!!local;updateLoading();});
void probeDevice().catch(()=>({mobile:false,webgpu:false,fallbackAdapter:false})).then(info=>{
  device=chooseTier(info,radioOverride());
  if(device.tier==='full'){voice.neural=true;startTeamSetup();}else useLite(device.reason,device.forced);
  refreshLoader();
});
