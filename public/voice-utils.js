export function likelyWhisperHallucination(text){
  const t=String(text||"").trim().toLowerCase().replace(/ё/g,"е").replace(/\s+/g," ");
  if(!t)return true;
  const plain=t.replace(/[.!?…,:;—–-]+$/g,"").trim();
  if(plain==="продолжение следует"||plain==="спасибо за просмотр")return true;
  if(/^смотрите продолжение(?:\s+в\s+следующей\s+серии)?[.!?…]*$/.test(t))return true;
  if(/^продолжение\s+в\s+следующей\s+серии[.!?…]*$/.test(t))return true;
  if(t.startsWith("редактор субтитров")||t.startsWith("корректор"))return true;
  if(t.startsWith("переводчик субтитров"))return true;
  if(t.startsWith("субтитры")){
    return /(?:^|\s)(?:редактор|корректор|перевод|переводчик|делал|делала|сделал|сделала|создал|создала|создавал|создавала|подготовил|подготовила|подогнал|подогнала)(?:\s|$|[.,!?…])/.test(t);
  }
  return false;
}

export function createVadEvidence(){
  return {frames:0,positiveMs:0,strongMs:0,veryStrongMs:0,peak:0};
}
export function recordVadFrame(evidence,probability,frameMs=32){
  const p=Number(probability);
  if(!Number.isFinite(p))return evidence;
  const duration=Math.max(16,Math.min(64,Number(frameMs)||32));
  evidence.frames++;
  evidence.peak=Math.max(evidence.peak,p);
  if(p>=0.45)evidence.positiveMs+=duration;
  if(p>=0.7)evidence.strongMs+=duration;
  if(p>=0.9)evidence.veryStrongMs+=duration;
  return evidence;
}
export function admitAutomaticSegment(evidence,{mode="silero",voicedMs=0}={}){
  // Manual Next bypasses this admission check.
  if(mode!=="silero")return {send:voicedMs>=120,reason:voicedMs>=120?"fallback_voice_confirmed":"fallback_too_brief"};
  if(evidence.positiveMs<420)return {send:false,reason:"vad_positive_too_brief"};
  if(evidence.strongMs<180)return {send:false,reason:"vad_strong_too_brief"};
  return {send:true,reason:"vad_evidence_pass"};
}
