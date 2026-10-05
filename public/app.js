const APP_VERSION="0.2.3";
const APP_BUILD=3;
const $=s=>document.querySelector(s);
const rowsEl=$("#rows"),emptyState=$("#emptyState"),addManualButton=$("#addManualButton"),saveButton=$("#saveButton"),saveState=$("#saveState");
const apiStatus=$("#apiStatus"),catalogButton=$("#catalogButton"),catalogDialog=$("#catalogDialog"),catalogText=$("#catalogText");
const toastEl=$("#toast"),voiceDock=$("#voiceDock"),equalizer=$("#equalizer"),nextButton=$("#nextButton"),playButton=$("#playButton"),playIcon=$("#playIcon"),voiceTitle=$("#voiceTitle"),voiceHint=$("#voiceHint");
const clarifyDialog=$("#clarifyDialog"),clarifyText=$("#clarifyText"),clarifyClose=$("#clarifyClose"),clarifyCancel=$("#clarifyCancel"),clarifyOk=$("#clarifyOk");
const clarifyEqualizer=$("#clarifyEqualizer"),clarifyStatus=$("#clarifyStatus"),clarifyVoiceButton=$("#clarifyVoiceButton"),clarifyVoiceIcon=$("#clarifyVoiceIcon"),clarifyVoiceLabel=$("#clarifyVoiceLabel");

let rows=[],catalog=[],families=[],rowSeq=0;
let continuous=false,stream=null,recorder=null,chunks=[],analyser=null,audioContext=null,animationFrame=null,speechStarted=false,silentSince=null,recordingPurpose=null;
let speechCandidateSince=null,speechStartedAt=null,voiceAboveMs=0,lastLevelAt=null,recordingStartedAt=null,maxRms=0;
let discardStoppedSegment=false;
let clarifySession=null,clarifySerial=0,resumeMainPending=false;
let sessionLogs=[],nextSttAt=0,sttQueue=Promise.resolve(),logDownloadButton=null;
let neuralVad=null,neuralVadReady=false,neuralVadInitPromise=null,neuralVadListening=false,lastVadProbability=0,vadSilenceSince=null;
const sessionStartedAt=Date.now();
const SILENCE_MS=650,RMS_THRESHOLD=.025,VOICE_ARM_MS=80,MIN_VOICED_MS=80,LOG_RETENTION_MS=120000,STT_MIN_INTERVAL_MS=3100;
const VAD_POSITIVE_THRESHOLD=.22,VAD_NEGATIVE_THRESHOLD=.12,VAD_REDEMPTION_MS=600,VAD_MIN_SPEECH_MS=80,VAD_PRE_SPEECH_MS=500;

function trimLogs(){
  const cutoff=Date.now()-LOG_RETENTION_MS;
  sessionLogs=sessionLogs.filter(x=>x.ts>=cutoff);
}
function shortText(value,max=500){
  const s=String(value??"");
  return s.length>max?s.slice(0,max)+"…":s;
}
function logEvent(event,data={}){
  const entry={ts:Date.now(),elapsedMs:Math.round(performance.now()),event,data};
  sessionLogs.push(entry);
  trimLogs();
}
function voiceSnapshot(){
  return {
    continuous,
    recorderState:recorder?.state||null,
    purpose:recordingPurpose?.type||null,
    rows:rows.length,
    speechStarted,
    voiceAboveMs:Math.round(voiceAboveMs||0),
    maxRms:Number((maxRms||0).toFixed(4)),
    clarifyState:clarifySession?.state||null
  };
}
function downloadLogs(){
  trimLogs();
  logEvent("logs.download",voiceSnapshot());
  const header=[
    "Prorab Talk session log",
    "version: v"+APP_VERSION+" (build "+APP_BUILD+")",
    "exported: "+new Date().toISOString(),
    "sessionStarted: "+new Date(sessionStartedAt).toISOString(),
    "url: "+location.href,
    "userAgent: "+navigator.userAgent,
    "window: last "+Math.round(LOG_RETENTION_MS/1000)+" seconds",
    ""
  ];
  const body=sessionLogs.map(x=>"["+new Date(x.ts).toISOString()+"] +"+x.elapsedMs+"ms "+x.event+" "+JSON.stringify(x.data)).join("\n");
  const blob=new Blob([header.join("\n")+body+"\n"],{type:"text/plain;charset=utf-8"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");
  a.href=url;a.download="prorab-talk-v"+APP_VERSION+"-build"+APP_BUILD+"-"+stamp+".txt";
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function installRuntimeUi(){
  const strong=document.querySelector(".brand strong");
  if(strong){
    const parent=strong.parentElement;
    let titleRow=parent.querySelector(".runtime-brand-title");
    if(!titleRow){
      titleRow=document.createElement("div");titleRow.className="runtime-brand-title";
      parent.insertBefore(titleRow,strong);titleRow.appendChild(strong);
    }
    let badge=titleRow.querySelector(".runtime-version");
    if(!badge){badge=document.createElement("small");badge.className="runtime-version";titleRow.appendChild(badge)}
    badge.textContent="v"+APP_VERSION+" (build "+APP_BUILD+")";
  }
  const parent=catalogButton?.parentElement;
  if(parent&&catalogButton&&!document.querySelector("#logDownloadButton")){
    const actions=document.createElement("div");actions.className="runtime-header-actions";
    parent.insertBefore(actions,catalogButton);
    logDownloadButton=document.createElement("button");
    logDownloadButton.id="logDownloadButton";logDownloadButton.className="icon-button runtime-log-button";
    logDownloadButton.type="button";logDownloadButton.title="Скачать логи за последние 2 минуты";
    logDownloadButton.setAttribute("aria-label","Скачать логи");
    logDownloadButton.textContent="⇩";
    actions.append(logDownloadButton,catalogButton);
    logDownloadButton.onclick=()=>{haptic("tap");downloadLogs()};
  }
  const style=document.createElement("style");
  style.dataset.runtimePatch="v0.2.3-build3";
  style.textContent=`
    .brand strong::after{display:none!important;content:none!important}
    .runtime-brand-title{display:flex;align-items:baseline;gap:7px;min-width:0}
    .runtime-version{font-size:10px;line-height:1;color:#9aa4b4;font-weight:650;white-space:nowrap}
    .runtime-header-actions{display:flex;align-items:center;gap:8px}
    .runtime-log-button{font-size:23px;line-height:1;color:#526074}
    .voice-dock>.equalizer{flex:1 1 0!important;width:auto!important;min-width:0!important;display:grid!important;grid-template-columns:repeat(12,minmax(0,1fr))!important;gap:0!important;padding:0 7px!important;align-items:center!important;justify-content:stretch!important}
    .voice-dock>.equalizer i{width:3px!important;justify-self:center!important}
    .voice-dock>.next-button{margin-left:0!important;flex:0 0 auto!important}
    .voice-dock>.play-button{flex:0 0 auto!important}
    @media(max-width:560px){.voice-dock>.equalizer{padding:0 5px!important}.runtime-header-actions{gap:6px}}
  `;
  document.head.appendChild(style);
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function ensureNeuralVad(){
  if(neuralVadReady&&neuralVad)return true;
  if(neuralVadInitPromise)return neuralVadInitPromise;
  neuralVadInitPromise=(async()=>{
    if(!window.vad?.MicVAD)throw new Error("Локальный Silero VAD не загружен");
    await ensureStream();
    neuralVad=await window.vad.MicVAD.new({
      startOnLoad:false,
      model:"v6",
      processorType:"auto",
      positiveSpeechThreshold:VAD_POSITIVE_THRESHOLD,
      negativeSpeechThreshold:VAD_NEGATIVE_THRESHOLD,
      redemptionMs:VAD_REDEMPTION_MS,
      preSpeechPadMs:VAD_PRE_SPEECH_MS,
      minSpeechMs:VAD_MIN_SPEECH_MS,
      submitUserSpeechOnPause:false,
      baseAssetPath:"/vendor/vad/",
      onnxWASMBasePath:"/vendor/vad/",
      getStream:async()=>{await ensureStream();return stream},
      pauseStream:async()=>undefined,
      resumeStream:async()=>{await ensureStream();return stream},
      onFrameProcessed:probs=>{
        lastVadProbability=Number(probs?.isSpeech||0);
        if(recordingPurpose?.type!=="new"||!speechStarted)return;
        const now=performance.now();
        if(lastVadProbability<VAD_NEGATIVE_THRESHOLD){
          if(vadSilenceSince===null)vadSilenceSince=now;
          setSilenceProgress(Math.min(1,(now-vadSilenceSince)/VAD_REDEMPTION_MS));
        }else if(lastVadProbability>VAD_POSITIVE_THRESHOLD){
          vadSilenceSince=null;setSilenceProgress(0);
        }
      },
      onSpeechStart:()=>logEvent("neural_vad.speech_start",{probability:Number(lastVadProbability.toFixed(3))}),
      onSpeechRealStart:()=>{
        if(recordingPurpose?.type!=="new"||recorder?.state!=="recording")return;
        speechStarted=true;speechStartedAt=performance.now();voiceAboveMs=Math.max(voiceAboveMs,VAD_MIN_SPEECH_MS);
        vadSilenceSince=null;setSilenceProgress(0);
        logEvent("neural_vad.speech_real_start",{probability:Number(lastVadProbability.toFixed(3))});
      },
      onSpeechEnd:()=>{
        if(recordingPurpose?.type!=="new"||recorder?.state!=="recording")return;
        logEvent("neural_vad.speech_end",{probability:Number(lastVadProbability.toFixed(3))});
        haptic("commit");finalizeSegment("vad_end");
      },
      onVADMisfire:()=>logEvent("neural_vad.misfire",{probability:Number(lastVadProbability.toFixed(3))})
    });
    neuralVadReady=true;
    logEvent("neural_vad.ready",{model:"v6",positive:VAD_POSITIVE_THRESHOLD,negative:VAD_NEGATIVE_THRESHOLD,redemptionMs:VAD_REDEMPTION_MS,minSpeechMs:VAD_MIN_SPEECH_MS,preSpeechPadMs:VAD_PRE_SPEECH_MS});
    return true;
  })().catch(error=>{
    neuralVadReady=false;neuralVad=null;
    logEvent("neural_vad.fallback",{message:shortText(error.message)});
    toast("Silero VAD не запустился — используем резервный режим");
    return false;
  }).finally(()=>{neuralVadInitPromise=null});
  return neuralVadInitPromise;
}
async function startNeuralVad(){
  const ok=await ensureNeuralVad();
  if(!ok)return false;
  if(neuralVadListening)return true;
  try{
    await neuralVad.start();
    neuralVadListening=true;vadSilenceSince=null;
    logEvent("neural_vad.started");
    return true;
  }catch(error){
    neuralVadReady=false;neuralVadListening=false;
    logEvent("neural_vad.start_error",{message:shortText(error.message)});
    return false;
  }
}
async function pauseNeuralVad(){
  if(!neuralVadReady||!neuralVad||!neuralVadListening)return;
  try{
    await neuralVad.pause();
    neuralVadListening=false;vadSilenceSince=null;setSilenceProgress(0);
    logEvent("neural_vad.paused");
  }catch(error){logEvent("neural_vad.pause_error",{message:shortText(error.message)})}
}
function likelyWhisperHallucination(text){
  const t=String(text||"").trim().toLowerCase().replace(/ё/g,"е");
  if(!t)return true;
  return [
    /^продолжение следует[.!…]?$/,
    /^редактор субтитров\b/,
    /^субтитры\b.*(?:редактор|корректор|делал|делала)/,
    /^корректор\b/,
    /^спасибо за просмотр[.!…]?$/
  ].some(re=>re.test(t));
}
function isRateLimitError(error){return error?.status===429||/rate limit/i.test(String(error?.message||""))}
function haltMainVoiceForRateLimit(error){
  logEvent("stt.rate_limit",{message:shortText(error?.message),...voiceSnapshot()});
  continuous=false;resumeMainPending=false;discardStoppedSegment=true;
  if(recorder?.state==="recording"&&recordingPurpose?.type==="new"){
    cancelAnimationFrame(animationFrame);recorder.stop();
  }else if(!recorder){closeStream()}
  updateVoiceUi();
  toast("Лимит Groq: голосовой ввод поставлен на паузу. Повторите через несколько секунд.");
}
async function transcribeBlob(blob,mt,context,isValid=()=>true){
  const run=async()=>{
    const waitMs=Math.max(0,nextSttAt-Date.now());
    if(waitMs){logEvent("stt.throttle",{context,waitMs});await sleep(waitMs)}
    if(!isValid()){logEvent("stt.cancelled",{context,stage:"before_request"});return {cancelled:true}}
    nextSttAt=Date.now()+STT_MIN_INTERVAL_MS;
    logEvent("stt.request",{context,bytes:blob.size,mime:mt});
    const form=new FormData(),ext=mt.includes("mp4")?"m4a":"webm";
    form.append("audio",blob,"voice."+ext);
    const d=await api("/api/transcribe",{method:"POST",body:form});
    logEvent("stt.result",{context,text:shortText(d.text||""),rawText:shortText(d.rawText||"")});
    return d;
  };
  const p=sttQueue.then(run,run);
  sttQueue=p.catch(()=>{});
  return p;
}
function toast(message){toastEl.textContent=message;toastEl.classList.add("show");clearTimeout(toastEl._t);toastEl._t=setTimeout(()=>toastEl.classList.remove("show"),2200)}
function haptic(kind="tap"){
  if(typeof navigator.vibrate!=="function")return;
  const pattern=kind==="commit"?[45,22,35]:kind==="strong"?36:18;
  try{navigator.vibrate(pattern)}catch{}
}
async function api(url,options={}){
  const method=options.method||"GET",started=performance.now();
  logEvent("api.request",{method,url});
  try{
    const r=await fetch(url,options);
    const d=await r.json().catch(()=>({}));
    logEvent("api.response",{method,url,status:r.status,ms:Math.round(performance.now()-started),error:!r.ok?shortText(d.details||d.error||""):undefined});
    if(!r.ok){
      const error=new Error(d.details||d.error||"Ошибка запроса");
      error.status=r.status;error.payload=d;error.apiLogged=true;throw error;
    }
    return d;
  }catch(error){
    if(!error.apiLogged)logEvent("api.error",{method,url,status:error.status||null,ms:Math.round(performance.now()-started),message:shortText(error.message)});
    throw error;
  }
}
async function bootstrap(){
  logEvent("bootstrap.start",{version:APP_VERSION,build:APP_BUILD});
  [catalog,families]=await Promise.all([api("/api/catalog?limit=1000"),api("/api/families")]);
  catalogText.textContent=catalog.map(x=>x.name).join("\n");
  try{const h=await api("/api/health");apiStatus.textContent="готово · "+h.catalog+" SKU";apiStatus.style.color="var(--green)"}catch{apiStatus.textContent="сервис недоступен";apiStatus.style.color="var(--danger)"}
}
function newRow(text=""){return{id:++rowSeq,rawText:text,text,familyId:null,familyName:"",familyCandidates:[],variantId:null,variantLabel:"",variantCandidates:[],catalogItemId:null,catalogItemName:"",quantity:"",unit:"",orderUnit:"",pending:false,editing:false,manualFamily:false,manualVariant:false}}
function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}
function option(value,label,selected=false){return '<option value="'+esc(value)+'"'+(selected?" selected":"")+'>'+esc(label)+'</option>'}
function uniqueByValue(items){const seen=new Set();return items.filter(x=>{if(seen.has(x.value))return false;seen.add(x.value);return true})}
function familyChoices(row){
  const out=[];
  if(row.familyId&&row.familyName)out.push({value:row.familyId,label:row.familyName});
  for(const x of (row.familyCandidates||[]).slice(0,3))out.push({value:x.id,label:x.name});
  return uniqueByValue(out);
}
function variantChoices(row){
  const out=[];
  if(row.variantId&&row.variantLabel)out.push({value:row.variantId,label:row.variantLabel});
  let candidates=row.variantCandidates||[];
  if(!candidates.length&&row.familyId){
    const f=families.find(x=>x.id===row.familyId);
    candidates=(f?.variants||[]).slice(0,3);
  }
  for(const x of candidates.slice(0,3))out.push({value:x.id,label:x.label});
  return uniqueByValue(out);
}
function unitChoices(row){
  return [...new Set([row.unit,row.orderUnit,"шт","мешок","лист","рулон","упаковка","кг","м"].filter(Boolean))];
}
function parsedLabel(row){
  if(!row.familyName)return "Товар пока не определён";
  const parts=[row.familyName];
  if(row.variantLabel)parts.push(row.variantLabel);
  const hasQty=row.quantity!==""&&row.quantity!==null&&row.quantity!==undefined;
  if(hasQty)parts.push(String(row.quantity)+(row.unit||row.orderUnit?" "+(row.unit||row.orderUnit):""));
  return parts.join(" · ");
}
function editorHtml(row){
  const fam=familyChoices(row),variants=variantChoices(row),units=unitChoices(row);
  const famPlaceholder=!row.familyId&&!row.manualFamily?option("","Выберите товар",true):"";
  const varPlaceholder=!row.variantId&&!row.manualVariant?option("","Выберите вариант",true):"";
  const famSelect=famPlaceholder+fam.map(x=>option(x.value,x.label,x.value===row.familyId)).join("")+option("__manual__","Ввести вручную",row.manualFamily);
  const varSelect=varPlaceholder+variants.map(x=>option(x.value,x.label,x.value===row.variantId)).join("")+option("__manual__","Ввести вручную",row.manualVariant);
  const unitPlaceholder=!(row.unit||row.orderUnit)?option("","Ед.",true):"";
  const unitSelect=unitPlaceholder+units.map(x=>option(x,x,x===(row.unit||row.orderUnit))).join("");
  return '<div class="inline-editor">'+
      '<div class="editor-field"><label class="editor-label">Товар</label><select class="editor-control family-select">'+famSelect+'</select>'+
        (row.manualFamily?'<input class="editor-control manual-segment family-manual" value="'+esc(row.familyName)+'" placeholder="Название товара">':'')+'</div>'+
      '<div class="editor-field"><label class="editor-label">Вариант</label><select class="editor-control variant-select">'+varSelect+'</select>'+
        (row.manualVariant?'<input class="editor-control manual-segment variant-manual" value="'+esc(row.variantLabel)+'" placeholder="Вариант SKU">':'')+'</div>'+
      '<div class="editor-field full"><label class="editor-label">Количество</label><div class="qty-unit-row"><input class="editor-control qty-input" inputmode="decimal" value="'+esc(row.quantity)+'" placeholder="Количество"><select class="editor-control unit-select">'+unitSelect+'</select></div></div>'+
  '</div>';
}
function autoGrow(textarea){
  const max=112;
  textarea.style.height="auto";
  const h=Math.min(textarea.scrollHeight,max);
  textarea.style.height=Math.max(42,h)+"px";
  textarea.style.overflowY=textarea.scrollHeight>max?"auto":"hidden";
}
function render(){
  rowsEl.innerHTML="";emptyState.hidden=rows.length>0;
  rows.forEach((row,index)=>{
    if(index>0){const m=document.createElement("div");m.className="merge-wrap";m.innerHTML='<button class="merge-button" type="button">+</button>';m.firstChild.onclick=()=>mergeRows(index-1,index);rowsEl.appendChild(m)}
    const el=document.createElement("article");el.className="request-row"+(row.pending?" pending":"");
    const lowerLeft=row.editing
      ? editorHtml(row)
      : '<button class="parsed-pill" type="button"><span class="pill-text">'+esc(parsedLabel(row))+'</span></button>';
    const lowerRight=row.editing
      ? '<button class="editor-done" type="button" aria-label="Завершить редактирование">✓</button>'
      : '<div class="action-placeholder" aria-hidden="true"></div>';
    el.innerHTML='<div class="card-grid">'+
      '<div class="text-cell"><div class="textarea-wrap">'+
        '<textarea class="voice-textarea" rows="1" placeholder="Товар, вариант, количество">'+esc(row.text)+'</textarea>'+
        '<button class="delete-row" type="button" title="Удалить">×</button>'+
      '</div></div>'+
      '<div class="action-cell top-action"><button class="clarify-button" type="button" title="Уточнить голосом"><span class="mic">🎙</span><span class="edit-mark">✎</span></button></div>'+
      '<div class="structured-cell">'+lowerLeft+'</div>'+
      '<div class="action-cell bottom-action">'+lowerRight+'</div>'+
    '</div>';
    const textarea=el.querySelector(".voice-textarea");autoGrow(textarea);
    let timer;
    textarea.oninput=()=>{
      row.text=textarea.value;autoGrow(textarea);clearTimeout(timer);
      timer=setTimeout(()=>rematch(row.id,{collapse:true}),340);
    };
    el.querySelector(".clarify-button").onclick=()=>{haptic("tap");startClarify(row.id).catch(e=>toast(e.message))};
    el.querySelector(".delete-row").onclick=()=>{rows=rows.filter(x=>x.id!==row.id);render()};
    if(row.editing)bindEditor(el,row); else el.querySelector(".parsed-pill").onclick=()=>{row.editing=true;render()};
    rowsEl.appendChild(el);
  });
}
function bindEditor(el,row){
  el.querySelector(".editor-done").onclick=()=>{row.editing=false;render()};
  const familySelect=el.querySelector(".family-select");
  familySelect.onchange=()=>{
    if(familySelect.value==="__manual__"){
      row.manualFamily=true;row.familyId=null;row.familyName=row.familyName||"";row.variantId=null;row.variantLabel="";row.manualVariant=false;render();return;
    }
    if(!familySelect.value)return;
    const f=families.find(x=>x.id===familySelect.value);
    if(!f)return;
    row.manualFamily=false;row.familyId=f.id;row.familyName=f.name;row.orderUnit=f.orderUnit;row.unit=row.unit||f.orderUnit;
    row.variantId=null;row.variantLabel="";row.catalogItemId=null;row.catalogItemName="";row.manualVariant=false;
    row.variantCandidates=(f.variants||[]).slice(0,5).map(v=>({...v,familyId:f.id,familyName:f.name,orderUnit:f.orderUnit,score:0}));
    render();
  };
  const familyManual=el.querySelector(".family-manual");
  if(familyManual)familyManual.oninput=e=>row.familyName=e.target.value;
  const variantSelect=el.querySelector(".variant-select");
  variantSelect.onchange=()=>{
    if(variantSelect.value==="__manual__"){row.manualVariant=true;row.variantId=null;row.catalogItemId=null;row.catalogItemName="";render();return}
    if(!variantSelect.value)return;
    const f=families.find(x=>x.id===row.familyId);const v=f?.variants.find(x=>x.id===variantSelect.value);
    if(v){row.manualVariant=false;row.variantId=v.id;row.variantLabel=v.label;row.catalogItemId=v.id;row.catalogItemName=v.fullName;render()}
  };
  const variantManual=el.querySelector(".variant-manual");
  if(variantManual)variantManual.oninput=e=>{row.variantLabel=e.target.value;row.catalogItemId=null;row.catalogItemName=""};
  el.querySelector(".qty-input").oninput=e=>row.quantity=e.target.value;
  el.querySelector(".unit-select").onchange=e=>row.unit=e.target.value;
}
function applyParsed(row,data){
  row.familyCandidates=data.familyCandidates||[];
  row.variantCandidates=data.variantCandidates||[];
  row.familyId=data.family?.id||null;row.familyName=data.family?.name||"";
  row.variantId=data.variant?.id||null;row.variantLabel=data.variant?.label||"";
  row.catalogItemId=data.variant?.id||null;row.catalogItemName=data.variant?.fullName||"";
  row.orderUnit=data.orderUnit||data.family?.orderUnit||"";
  row.manualFamily=false;row.manualVariant=false;
  row.quantity=data.quantity!==null&&data.quantity!==undefined?data.quantity:"";
  row.unit=data.unit||row.orderUnit||"";
  row.pending=false;
}
async function rematch(id,{collapse=false}={}){
  const row=rows.find(x=>x.id===id);if(!row)return;
  try{
    const d=await api("/api/match",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:row.text})});
    applyParsed(row,d);
    if(collapse)row.editing=false;
    render();
  }catch(e){toast(e.message)}
}
async function mergeRows(newerIndex,olderIndex){
  const newer=rows[newerIndex],older=rows[olderIndex];if(!newer||!older)return;
  newer.text=[older.text,newer.text].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  newer.rawText=[older.rawText,newer.rawText].filter(Boolean).join(" ").trim();
  newer.pending=true;rows.splice(olderIndex,1);render();await rematch(newer.id);
}
function addManual(){const r=newRow("");rows.unshift(r);render();setTimeout(()=>rowsEl.querySelector(".voice-textarea")?.focus(),0)}

async function ensureStream(){if(stream?.active)return stream;stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});return stream}
function mime(){return["audio/webm;codecs=opus","audio/webm","audio/mp4"].find(x=>MediaRecorder.isTypeSupported(x))||""}
async function startMain(){
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error("Браузер не поддерживает запись");
  logEvent("voice.main.start",voiceSnapshot());
  continuous=true;await ensureStream();await startNeuralVad();beginRecorder({type:"new"});updateVoiceUi();
}
async function startClarify(rowId){
  if(clarifySession?.active)return;
  const row=rows.find(x=>x.id===rowId);if(!row)return;
  const resumeMain=continuous||(recorder?.state==="recording"&&recordingPurpose?.type==="new");
  clarifySession={id:++clarifySerial,rowId,originalText:row.text,resumeMain,active:true,state:"preparing"};
  logEvent("clarify.open",{rowId,resumeMain,text:shortText(row.text)});
  clarifyText.value=row.text;
  clarifyDialog.showModal();
  continuous=false;
  await pauseNeuralVad();
  updateClarifyUi();
  updateVoiceUi();

  if(recorder?.state==="recording"){
    if(recordingPurpose?.type!=="new")return;
    discardStoppedSegment=!speechStarted;
    finalizeSegment();
    return;
  }
  await startClarifyRecording();
}
async function startClarifyRecording(){
  const session=clarifySession;if(!session?.active)return;
  try{
    await ensureStream();
    if(!clarifySession?.active||clarifySession.id!==session.id)return;
    session.state="recording";
    beginRecorder({type:"clarifyDialog",sessionId:session.id});
    updateClarifyUi();
  }catch(error){
    if(clarifySession?.active&&clarifySession.id===session.id){
      clarifySession.state="ready";
      updateClarifyUi();
    }
    toast(error.message);
  }
}
function beginRecorder(purpose){
  recordingPurpose=purpose;chunks=[];speechStarted=false;silentSince=null;speechCandidateSince=null;speechStartedAt=null;voiceAboveMs=0;lastLevelAt=null;recordingStartedAt=performance.now();maxRms=0;vadSilenceSince=null;setSilenceProgress(0);
  const mt=mime();recorder=mt?new MediaRecorder(stream,{mimeType:mt}):new MediaRecorder(stream);
  recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data)};
  recorder.onstop=onRecorderStop;
  recorder.start(200);
  logEvent("recorder.start",{purpose:purpose?.type||null,mime:recorder.mimeType||mt,threshold:RMS_THRESHOLD,voiceArmMs:VOICE_ARM_MS});
  watchLevel();
  updateVoiceUi();
}
function watchLevel(){
  cancelAnimationFrame(animationFrame);
  if(!audioContext){
    audioContext=new AudioContext();
    analyser=audioContext.createAnalyser();
    analyser.fftSize=512;
    audioContext.createMediaStreamSource(stream).connect(analyser);
  }
  const data=new Uint8Array(analyser.fftSize);
  const target=recordingPurpose?.type==="clarifyDialog"?clarifyEqualizer:equalizer;
  const bars=[...target.querySelectorAll("i")];
  const tick=()=>{
    if(!recorder||recorder.state!=="recording")return;
    const now=performance.now(),dt=lastLevelAt?Math.min(80,now-lastLevelAt):0;lastLevelAt=now;
    analyser.getByteTimeDomainData(data);
    let sum=0;
    for(const v of data){const s=(v-128)/128;sum+=s*s}
    const rms=Math.sqrt(sum/data.length);maxRms=Math.max(maxRms,rms);
    bars.forEach((b,i)=>{const k=Math.min(1,rms*18*(.72+((i%3)+1)*.13));b.style.height=(7+k*24)+"px"});

    if(!neuralVadReady){
      if(rms>RMS_THRESHOLD){
        if(!speechStarted){
          if(speechCandidateSince===null)speechCandidateSince=now;
          if(now-speechCandidateSince>=VOICE_ARM_MS){
            speechStarted=true;speechStartedAt=speechCandidateSince;voiceAboveMs=now-speechCandidateSince;silentSince=null;setSilenceProgress(0);
            logEvent("fallback_vad.speech_armed",{purpose:recordingPurpose?.type||null,rms:Number(rms.toFixed(4)),armMs:Math.round(now-speechCandidateSince),maxRms:Number(maxRms.toFixed(4))});
          }
        }else{
          voiceAboveMs+=dt;silentSince=null;setSilenceProgress(0);
        }
      }else{
        if(!speechStarted)speechCandidateSince=null;
        if(speechStarted&&recordingPurpose?.type==="new"){
          if(!silentSince){silentSince=now;logEvent("fallback_vad.silence_start",{voiceAboveMs:Math.round(voiceAboveMs),maxRms:Number(maxRms.toFixed(4))})}
          const p=Math.min(1,(now-silentSince)/SILENCE_MS);
          setSilenceProgress(p);
          if(p>=1){
            logEvent("fallback_vad.auto_finalize",{silenceMs:Math.round(now-silentSince),voiceAboveMs:Math.round(voiceAboveMs),maxRms:Number(maxRms.toFixed(4))});
            haptic("commit");finalizeSegment("fallback_silence");return;
          }
        }
      }
    }
    animationFrame=requestAnimationFrame(tick);
  };
  tick();
}
function setSilenceProgress(p){nextButton.style.setProperty("--silence-progress",String(p))}
function finalizeSegment(reason="manual"){
  if(recorder?.state!=="recording")return;
  if(recordingPurpose)recordingPurpose.finalizeReason=reason;
  logEvent("recorder.finalize",{reason,purpose:recordingPurpose?.type||null,speechStarted,voiceAboveMs:Math.round(voiceAboveMs),maxRms:Number(maxRms.toFixed(4)),vadProbability:Number(lastVadProbability.toFixed(3))});
  cancelAnimationFrame(animationFrame);recorder.stop();
}
async function nextLine(){
  if(recorder?.state!=="recording"||recordingPurpose?.type!=="new")return;
  haptic("commit");
  if(neuralVadReady){
    await pauseNeuralVad();
    recordingPurpose.restartVad=true;
  }
  finalizeSegment("next");
}
function stopAll(){
  continuous=false;
  pauseNeuralVad();
  if(recordingPurpose?.type==="new")discardStoppedSegment=!speechStarted;else discardStoppedSegment=false;
  logEvent("voice.main.stop",{speechStarted,voiceAboveMs:Math.round(voiceAboveMs),...voiceSnapshot()});
  if(recorder?.state==="recording")recorder.stop();else closeStream();
  updateVoiceUi();
}
async function onRecorderStop(){
  cancelAnimationFrame(animationFrame);setSilenceProgress(0);
  const purpose=recordingPurpose,mt=recorder?.mimeType||"audio/webm",blob=new Blob(chunks,{type:mt});
  const metrics={
    purpose:purpose?.type||null,
    finalizeReason:purpose?.finalizeReason||null,
    bytes:blob.size,
    durationMs:Math.round(performance.now()-(recordingStartedAt||performance.now())),
    speechStarted,
    voiceAboveMs:Math.round(voiceAboveMs),
    maxRms:Number(maxRms.toFixed(4))
  };
  recorder=null;chunks=[];
  logEvent("recorder.stop",metrics);

  if(purpose?.type==="clarifyDialog"){
    resetClarifyBars();
    const session=clarifySession;
    if(!session?.active||session.id!==purpose.sessionId){
      logEvent("clarify.audio_discarded",{reason:"session_inactive",...metrics});
      if(resumeMainPending)setTimeout(resumeMainVoice,30);else closeStream();
      return;
    }
    await transcribeClarification(blob,mt,purpose.sessionId);
    return;
  }

  const discardFlag=purpose?.type==="new"&&discardStoppedSegment;if(discardFlag)discardStoppedSegment=false;
  const forcedByNext=purpose?.type==="new"&&purpose?.finalizeReason==="next";
  const vadMeaningful=neuralVadReady?speechStarted:(speechStarted&&voiceAboveMs>=MIN_VOICED_MS);
  const meaningful=purpose?.type==="new"&&(forcedByNext?blob.size>0:(vadMeaningful&&blob.size>=500));
  const shouldDiscard=purpose?.type==="new"&&(discardFlag||!meaningful);

  if(purpose?.type==="new"&&clarifySession?.active&&clarifySession.state==="preparing"){
    setTimeout(()=>startClarifyRecording(),50);
  }else if(purpose?.type==="new"&&continuous){
    setTimeout(async()=>{
      if(continuous&&stream?.active&&!recorder){
        if(purpose?.restartVad)await startNeuralVad();
        beginRecorder({type:"new"});
      }
    },90);
  }else if(!resumeMainPending){
    closeStream();
  }
  if(resumeMainPending)setTimeout(resumeMainVoice,30);
  updateVoiceUi();

  if(shouldDiscard){
    logEvent("segment.discarded",{reason:discardFlag?"explicit_discard":"insufficient_voice",forcedByNext,neuralVadReady,vadProbability:Number(lastVadProbability.toFixed(3)),minVoicedMs:MIN_VOICED_MS,...metrics});
    return;
  }
  if(purpose?.type!=="new"||(!forcedByNext&&blob.size<500))return;

  try{
    const d=await transcribeBlob(blob,mt,"main");
    const text=String(d?.text||"").trim();
    if(!text){logEvent("stt.discarded",{reason:"empty_text",...metrics});return}
    if(likelyWhisperHallucination(text)){
      logEvent("stt.discarded",{reason:"known_silence_hallucination",text:shortText(text),...metrics});
      return;
    }
    const row=newRow(text);row.rawText=d.rawText||text;applyParsed(row,d);rows.unshift(row);render();
    logEvent("row.created",{rowId:row.id,text:shortText(text),family:row.familyName||null,variant:row.variantLabel||null,quantity:row.quantity||null,unit:row.unit||null});
  }catch(e){
    logEvent("stt.main_error",{status:e.status||null,message:shortText(e.message),...metrics});
    if(isRateLimitError(e)){haltMainVoiceForRateLimit(e);return}
    toast(e.message);
  }
}
async function transcribeClarification(blob,mt,sessionId){
  const session=clarifySession;
  if(!session?.active||session.id!==sessionId)return;
  session.state="transcribing";
  updateClarifyUi();
  if(blob.size<500){
    logEvent("clarify.audio_discarded",{reason:"blob_too_small",bytes:blob.size});
    session.state="ready";updateClarifyUi();return;
  }
  try{
    const d=await transcribeBlob(blob,mt,"clarify",()=>Boolean(clarifySession?.active&&clarifySession.id===sessionId));
    if(d?.cancelled)return;
    if(!clarifySession?.active||clarifySession.id!==sessionId)return;
    const extra=String(d.text||"").trim();
    if(extra&&!likelyWhisperHallucination(extra)){
      const base=clarifyText.value.trimEnd();
      clarifyText.value=base?base+" "+extra:extra;
      clarifyText.scrollTop=clarifyText.scrollHeight;
      logEvent("clarify.text_appended",{text:shortText(extra)});
    }else if(extra){
      logEvent("clarify.text_discarded",{reason:"known_silence_hallucination",text:shortText(extra)});
    }
    clarifySession.state="ready";updateClarifyUi();
  }catch(error){
    if(!clarifySession?.active||clarifySession.id!==sessionId)return;
    clarifySession.state="ready";updateClarifyUi();
    logEvent("clarify.stt_error",{status:error.status||null,message:shortText(error.message)});
    toast(isRateLimitError(error)?"Лимит Groq. Подождите несколько секунд и повторите.":error.message);
  }
}
function resetStructured(row){
  row.familyId=null;row.familyName="";row.familyCandidates=[];
  row.variantId=null;row.variantLabel="";row.variantCandidates=[];
  row.catalogItemId=null;row.catalogItemName="";
  row.quantity="";row.unit="";row.orderUnit="";
  row.manualFamily=false;row.manualVariant=false;row.editing=false;
}
function cancelClarify(){
  const session=clarifySession;if(!session)return;
  logEvent("clarify.cancel",{rowId:session.rowId,state:session.state,resumeMain:session.resumeMain});
  const resume=session.resumeMain;
  session.active=false;clarifySession=null;
  if(clarifyDialog.open)clarifyDialog.close();
  resetClarifyBars();
  resumeMainPending=resume;

  if(recorder?.state==="recording"&&recordingPurpose?.type==="clarifyDialog"){
    cancelAnimationFrame(animationFrame);
    recorder.stop();
  }else if(resume){
    setTimeout(resumeMainVoice,30);
  }else if(!recorder){
    closeStream();
  }
  updateVoiceUi();
}
function acceptClarify(){
  const session=clarifySession;
  if(!session?.active||session.state!=="ready")return;
  logEvent("clarify.accept",{rowId:session.rowId,text:shortText(clarifyText.value),resumeMain:session.resumeMain});
  const row=rows.find(x=>x.id===session.rowId);
  const value=clarifyText.value.trim();
  const resume=session.resumeMain;
  session.active=false;clarifySession=null;
  if(clarifyDialog.open)clarifyDialog.close();
  resetClarifyBars();

  if(row){
    row.text=value;row.rawText=value;
    resetStructured(row);
    row.pending=true;
    render();
    rematch(row.id,{collapse:true});
  }

  resumeMainPending=resume;
  if(resume)setTimeout(resumeMainVoice,30);else if(!recorder)closeStream();
  updateVoiceUi();
}
async function resumeMainVoice(){
  if(!resumeMainPending)return;
  if(recorder){setTimeout(resumeMainVoice,50);return}
  resumeMainPending=false;
  continuous=true;
  try{
    await ensureStream();
    if(!continuous)return;
    await startNeuralVad();
    beginRecorder({type:"new"});
  }catch(error){
    continuous=false;closeStream();toast(error.message);
  }
  updateVoiceUi();
}
function updateClarifyUi(){
  const session=clarifySession;if(!session)return;
  const state=session.state;
  clarifyDialog.classList.toggle("recording",state==="recording");
  clarifyVoiceButton.className="clarify-voice-button";
  clarifyVoiceButton.disabled=state==="preparing"||state==="transcribing";
  clarifyOk.disabled=state!=="ready";

  if(state==="recording"){
    clarifyVoiceButton.classList.add("recording");
    clarifyVoiceIcon.textContent="■";
    clarifyVoiceLabel.textContent="Стоп";
    clarifyStatus.textContent="Слушаю уточнение…";
  }else if(state==="transcribing"){
    resetClarifyBars();
    clarifyVoiceButton.classList.add("busy");
    clarifyVoiceIcon.innerHTML='<span class="clarify-spinner"></span>';
    clarifyVoiceLabel.textContent="Распознаём";
    clarifyStatus.textContent="Расшифровываем голос…";
  }else if(state==="ready"){
    clarifyVoiceButton.classList.add("ready");
    clarifyVoiceIcon.textContent="🎙";
    clarifyVoiceLabel.textContent="";
    clarifyStatus.textContent="Можно исправить текст или добавить ещё";
    resetClarifyBars();
  }else{
    resetClarifyBars();
    clarifyVoiceButton.classList.add("busy");
    clarifyVoiceIcon.innerHTML='<span class="clarify-spinner"></span>';
    clarifyVoiceLabel.textContent="";
    clarifyStatus.textContent="Подготавливаем микрофон…";
  }
}
function resetClarifyBars(){clarifyEqualizer.querySelectorAll("i").forEach(b=>b.style.height="7px")}
function closeStream(){
  pauseNeuralVad();
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  if(audioContext){audioContext.close().catch(()=>{});audioContext=null;analyser=null}
  equalizer.querySelectorAll("i").forEach(b=>b.style.height="7px");
  resetClarifyBars();
}
function updateVoiceUi(){
  const live=recorder?.state==="recording",main=live&&recordingPurpose?.type==="new";
  voiceDock.classList.toggle("live",main);
  playButton.classList.remove("clarify");
  nextButton.disabled=!main;nextButton.classList.toggle("enabled",main);
  if(clarifySession?.active){
    playIcon.textContent="Ⅱ";voiceTitle.textContent="Пауза";voiceHint.textContent="Открыто уточнение";
  }else if(main){
    playIcon.textContent="Ⅱ";voiceTitle.textContent="Слушаю";voiceHint.textContent="Пауза — новая строка";
  }else{
    playIcon.textContent="▶";voiceTitle.textContent="Готов";voiceHint.textContent="Play — продолжить";
  }
}
playButton.onclick=()=>{haptic("tap");if(recorder?.state==="recording")stopAll();else startMain().catch(e=>toast(e.message))};
nextButton.onclick=nextLine;
clarifyVoiceButton.onclick=()=>{
  const session=clarifySession;if(!session?.active)return;
  if(session.state==="recording"){
    haptic("strong");
    session.state="transcribing";
    updateClarifyUi();
    finalizeSegment();
  }else if(session.state==="ready"){
    haptic("tap");
    startClarifyRecording();
  }
};
clarifyClose.onclick=cancelClarify;
clarifyCancel.onclick=cancelClarify;
clarifyOk.onclick=()=>{haptic("tap");acceptClarify()};
clarifyDialog.addEventListener("cancel",event=>{event.preventDefault();cancelClarify()});

async function saveRequest(){
  const valid=rows.filter(r=>r.text.trim());if(!valid.length)return toast("Добавьте позицию");
  saveButton.disabled=true;saveState.textContent="Сохраняем…";
  try{
    const s=await api("/api/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:valid})});
    saveState.textContent="Заявка #"+s.id+" сохранена";toast("Заявка сохранена")
  }catch(e){saveState.textContent="";toast(e.message)}
  finally{saveButton.disabled=false}
}
addManualButton.onclick=addManual;saveButton.onclick=saveRequest;catalogButton.onclick=()=>catalogDialog.showModal();
document.querySelectorAll(".close-dialog").forEach(b=>b.onclick=()=>b.closest("dialog").close());
catalogDialog.addEventListener("click",e=>{if(e.target===catalogDialog)catalogDialog.close()});
window.addEventListener("error",event=>logEvent("window.error",{message:shortText(event.message),source:event.filename||null,line:event.lineno||null,col:event.colno||null}));
window.addEventListener("unhandledrejection",event=>logEvent("window.unhandledrejection",{message:shortText(event.reason?.message||event.reason)}));
window.addEventListener("beforeunload",closeStream);
installRuntimeUi();
logEvent("session.start",{version:APP_VERSION,build:APP_BUILD,userAgent:navigator.userAgent,url:location.href,vad:"silero-v6-local"});
bootstrap().catch(e=>{logEvent("bootstrap.error",{message:shortText(e.message)});toast(e.message)});render();updateVoiceUi();
