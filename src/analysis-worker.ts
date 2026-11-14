import {analyze} from './analysis.ts';
import type {Race,RaceSetup} from './sim.ts';
self.onmessage=(event:MessageEvent<{setup:RaceSetup;decisions:Race['decisions']}>)=>{
  try {const result=analyze(event.data.setup,event.data.decisions,(done,total)=>self.postMessage({type:'progress',done,total}));self.postMessage({type:'complete',result});}
  catch(error){self.postMessage({type:'error',message:error instanceof Error?error.message:String(error)});}
};
