import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createVadEvidence,recordVadFrame,admitAutomaticSegment} from "../public/voice-utils.js";
test("short confident spike never spends STT allowance",()=>{
 const e=createVadEvidence();
 recordVadFrame(e,1,32);
 for(let i=0;i<20;i++)recordVadFrame(e,.1,32);
 assert.equal(admitAutomaticSegment(e,{mode:"silero"}).send,false);
});
test("sustained voice evidence qualifies for automatic STT",()=>{
 const e=createVadEvidence();
 for(let i=0;i<18;i++)recordVadFrame(e,.85,32);
 assert.equal(admitAutomaticSegment(e,{mode:"silero"}).send,true);
});
test("fallback gate during model warmup",()=>{
 const e=createVadEvidence();
 assert.equal(admitAutomaticSegment(e,{mode:"fallback",voicedMs:300}).send,true);
 assert.equal(admitAutomaticSegment(e,{mode:"fallback",voicedMs:20}).send,false);
});
test("first recorder starts before async Silero initialization",()=>{
 const code=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
 const s=code.slice(code.indexOf("async function startMain()"),code.indexOf("async function startClarify("));
 assert.ok(s.indexOf('beginRecorder({type:"new"})')>=0);
 assert.ok(s.indexOf('beginRecorder({type:"new"})')<s.indexOf("void startNeuralVad(epoch,token)"));
 assert.ok(!s.includes("await startNeuralVad"));
 assert.ok(code.includes("neural_vad.late_start_cancelled"));
});
