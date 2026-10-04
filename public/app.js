const $=s=>document.querySelector(s);
const rowsEl=$("#rows"),emptyState=$("#emptyState"),addManualButton=$("#addManualButton"),saveButton=$("#saveButton"),saveState=$("#saveState");
const apiStatus=$("#apiStatus"),catalogButton=$("#catalogButton"),catalogDialog=$("#catalogDialog"),catalogText=$("#catalogText");
const segmentDialog=$("#segmentDialog"),segmentOptions=$("#segmentOptions"),segmentTitle=$("#segmentTitle"),segmentKicker=$("#segmentKicker"),manualWrap=$("#manualWrap"),manualInput=$("#manualInput"),manualSave=$("#manualSave");
const toastEl=$("#toast"),voiceDock=$("#voiceDock"),equalizer=$("#equalizer"),nextButton=$("#nextButton"),playButton=$("#playButton"),playIcon=$("#playIcon"),voiceTitle=$("#voiceTitle"),voiceHint=$("#voiceHint");

let rows=[],catalog=[],families=[],rowSeq=0;
let continuous=false,stream=null,recorder=null,chunks=[],analyser=null,audioContext=null,animationFrame=null,speechStarted=false,silentSince=null,recordingPurpose=null;
let pendingClarifyRowId=null,discardStoppedSegment=false,segmentContext=null;
const SILENCE_MS=650,RMS_THRESHOLD=.025;

function toast(message){toastEl.textContent=message;toastEl.classList.add("show");clearTimeout(toastEl._t);toastEl._t=setTimeout(()=>toastEl.classList.remove("show"),2200)}
async function api(url,options={}){const r=await fetch(url,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.details||d.error||"Ошибка запроса");return d}
async function bootstrap(){
  [catalog,families]=await Promise.all([api("/api/catalog?limit=1000"),api("/api/families")]);
  catalogText.textContent=catalog.map(x=>x.name).join("\n");
  try{const h=await api("/api/health");apiStatus.textContent="готово · "+h.catalog+" SKU";apiStatus.style.color="var(--green)"}catch{apiStatus.textContent="сервис недоступен";apiStatus.style.color="var(--danger)"}
}
function newRow(text=""){return{id:++rowSeq,rawText:text,text,familyId:null,familyName:"",familyCandidates:[],variantId:null,variantLabel:"",variantCandidates:[],catalogItemId:null,catalogItemName:"",quantity:"",unit:"",orderUnit:"",pending:false}}
function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}
function confidence(row){if(row.pending)return"Распознаём…";const f=row.familyCandidates?.[0];if(!f)return"Товар пока не определён";const p=Math.round((f.score||0)*100);return p>=80?"Уверенно · "+p+"%":p>=55?"Проверьте · "+p+"%":"Низкая уверенность · "+p+"%"}
function render(){
  rowsEl.innerHTML="";emptyState.hidden=rows.length>0;
  rows.forEach((row,index)=>{
    if(index>0){const m=document.createElement("div");m.className="merge-wrap";m.innerHTML='<button class="merge-button" type="button">+</button>';m.firstChild.onclick=()=>mergeRows(index-1,index);rowsEl.appendChild(m)}
    const el=document.createElement("article");el.className="request-row"+(row.pending?" pending":"");
    el.innerHTML='<div class="row-top"><input class="field text-field" value="'+esc(row.text)+'" placeholder="Товар, вариант, количество"><button class="row-action clarify" type="button" title="Уточнить">🎙</button><button class="row-action delete-row" type="button">×</button></div>'+
      '<div class="segments">'+segmentHtml("family","Товар",row.familyName||"Не определён",!row.familyName)+segmentHtml("variant","Вариант",row.variantLabel||"Не определён",!row.variantLabel)+'</div>'+
      '<div class="qty-unit"><input class="field qty-input" inputmode="decimal" value="'+esc(row.quantity)+'" placeholder="Количество"><button class="unit-button" type="button"><small>Ед.</small><strong>'+esc(row.unit||row.orderUnit||"—")+'</strong></button></div>'+
      '<div class="confidence">'+esc(confidence(row))+'</div>';
    let timer;const textInput=el.querySelector(".text-field");
    textInput.oninput=()=>{row.text=textInput.value;clearTimeout(timer);timer=setTimeout(()=>rematch(row.id),320)};
    el.querySelector(".clarify").onclick=()=>startClarify(row.id).catch(e=>toast(e.message));
    el.querySelector(".delete-row").onclick=()=>{rows=rows.filter(x=>x.id!==row.id);render()};
    el.querySelector('[data-segment="family"]').onclick=()=>openSegment(row.id,"family");
    el.querySelector('[data-segment="variant"]').onclick=()=>openSegment(row.id,"variant");
    el.querySelector(".qty-input").oninput=e=>row.quantity=e.target.value;
    el.querySelector(".unit-button").onclick=()=>openSegment(row.id,"unit");
    rowsEl.appendChild(el);
  });
}
function segmentHtml(type,label,value,empty){return '<button class="segment '+(empty?"empty":"")+'" data-segment="'+type+'" type="button"><small>'+label+'</small><strong>'+esc(value)+'</strong></button>'}
function applyParsed(row,data){
  row.familyCandidates=data.familyCandidates||[];
  row.variantCandidates=data.variantCandidates||[];
  row.familyId=data.family?.id||null;row.familyName=data.family?.name||"";
  row.variantId=data.variant?.id||null;row.variantLabel=data.variant?.label||"";
  row.catalogItemId=data.variant?.id||null;row.catalogItemName=data.variant?.fullName||"";
  row.orderUnit=data.orderUnit||data.family?.orderUnit||"";
  if(data.quantity!==null&&data.quantity!==undefined)row.quantity=data.quantity;
  if(data.unit)row.unit=data.unit;else if(!row.unit&&row.orderUnit)row.unit=row.orderUnit;
  row.pending=false;
}
async function rematch(id){const row=rows.find(x=>x.id===id);if(!row)return;try{const d=await api("/api/match",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:row.text})});applyParsed(row,d);render()}catch(e){toast(e.message)}}
async function mergeRows(newerIndex,olderIndex){
  const newer=rows[newerIndex],older=rows[olderIndex];if(!newer||!older)return;
  newer.text=[older.text,newer.text].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  newer.rawText=[older.rawText,newer.rawText].filter(Boolean).join(" ").trim();
  newer.pending=true;rows.splice(olderIndex,1);render();await rematch(newer.id);
}
function addManual(){const r=newRow("");rows.unshift(r);render();setTimeout(()=>rowsEl.querySelector(".text-field")?.focus(),0)}

function optionsFor(row,type){
  if(type==="family")return (row.familyCandidates||[]).slice(0,3).map(x=>({value:x.id,label:x.name,sub:x.category}));
  if(type==="variant"){
    let vs=row.variantCandidates||[];
    if(!vs.length&&row.familyId){const f=families.find(x=>x.id===row.familyId);vs=(f?.variants||[]).slice(0,3).map(v=>({...v,score:0}))}
    return vs.slice(0,3).map(x=>({value:x.id,label:x.label,sub:x.fullName}));
  }
  const units=[row.unit,row.orderUnit,"шт","мешок","лист","рулон","кг","м"].filter(Boolean);
  return [...new Set(units)].slice(0,6).map(x=>({value:x,label:x,sub:"Единица заказа"}));
}
function openSegment(rowId,type){
  const row=rows.find(x=>x.id===rowId);if(!row)return;segmentContext={rowId,type};manualWrap.hidden=true;manualInput.value="";
  segmentKicker.textContent=type==="family"?"Товар":type==="variant"?"Вариант SKU":"Единица";
  segmentTitle.textContent="Выберите или введите вручную";
  const opts=optionsFor(row,type);
  segmentOptions.innerHTML=opts.map(o=>'<button class="option-button" data-value="'+esc(o.value)+'"><b>'+esc(o.label)+'</b><span>'+esc(o.sub||"")+'</span></button>').join("")+'<button class="option-button manual-choice"><b>Ввести вручную</b><span>Свое значение</span></button>';
  segmentOptions.querySelectorAll("[data-value]").forEach(b=>b.onclick=()=>selectSegment(b.dataset.value));
  segmentOptions.querySelector(".manual-choice").onclick=()=>{manualWrap.hidden=false;manualInput.focus()};
  segmentDialog.showModal();
}
function selectSegment(value){
  const row=rows.find(x=>x.id===segmentContext?.rowId);if(!row)return;
  const type=segmentContext.type;
  if(type==="family"){
    const f=families.find(x=>x.id===value);if(f){row.familyId=f.id;row.familyName=f.name;row.orderUnit=f.orderUnit;row.unit=row.unit||f.orderUnit;row.familyCandidates=[{id:f.id,name:f.name,category:f.category,orderUnit:f.orderUnit,score:1},...row.familyCandidates.filter(x=>x.id!==f.id)];row.variantId=null;row.variantLabel="";row.variantCandidates=(f.variants||[]).slice(0,5).map(v=>({...v,familyId:f.id,familyName:f.name,orderUnit:f.orderUnit,score:0}))}
  }else if(type==="variant"){
    const f=families.find(x=>x.id===row.familyId);const v=f?.variants.find(x=>x.id===value);if(v){row.variantId=v.id;row.variantLabel=v.label;row.catalogItemId=v.id;row.catalogItemName=v.fullName}
  }else row.unit=value;
  segmentDialog.close();render();
}
manualSave.onclick=()=>{
  const row=rows.find(x=>x.id===segmentContext?.rowId),value=manualInput.value.trim();if(!row||!value)return;
  if(segmentContext.type==="family"){row.familyId=null;row.familyName=value;row.variantId=null;row.variantLabel=""}
  else if(segmentContext.type==="variant"){row.variantId=null;row.variantLabel=value;row.catalogItemId=null;row.catalogItemName=""}
  else row.unit=value;
  segmentDialog.close();render();
};

async function ensureStream(){if(stream?.active)return stream;stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});return stream}
function mime(){return["audio/webm;codecs=opus","audio/webm","audio/mp4"].find(x=>MediaRecorder.isTypeSupported(x))||""}
async function startMain(){
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error("Браузер не поддерживает запись");
  continuous=true;await ensureStream();beginRecorder({type:"new"});updateVoiceUi();
}
async function startClarify(rowId){
  const live=recorder?.state==="recording";
  if(live&&recordingPurpose?.type==="clarify")return toast("Сначала завершите текущее уточнение");
  continuous=false;pendingClarifyRowId=rowId;
  if(live&&recordingPurpose?.type==="new"){discardStoppedSegment=!speechStarted;finalizeSegment();updateVoiceUi();return}
  await ensureStream();pendingClarifyRowId=null;beginRecorder({type:"clarify",rowId});updateVoiceUi();
}
function beginRecorder(purpose){
  recordingPurpose=purpose;chunks=[];speechStarted=false;silentSince=null;setSilenceProgress(0);
  const mt=mime();recorder=mt?new MediaRecorder(stream,{mimeType:mt}):new MediaRecorder(stream);
  recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data)};recorder.onstop=onRecorderStop;recorder.start(200);watchLevel();updateVoiceUi();
}
function watchLevel(){
  cancelAnimationFrame(animationFrame);
  if(!audioContext){audioContext=new AudioContext();analyser=audioContext.createAnalyser();analyser.fftSize=512;audioContext.createMediaStreamSource(stream).connect(analyser)}
  const data=new Uint8Array(analyser.fftSize),bars=[...equalizer.querySelectorAll("i")];
  const tick=()=>{
    if(!recorder||recorder.state!=="recording")return;
    analyser.getByteTimeDomainData(data);let sum=0;for(const v of data){const s=(v-128)/128;sum+=s*s}const rms=Math.sqrt(sum/data.length);
    bars.forEach((b,i)=>{const k=Math.min(1,rms*18*(.72+((i%3)+1)*.13));b.style.height=(7+k*24)+"px"});
    if(rms>RMS_THRESHOLD){speechStarted=true;silentSince=null;setSilenceProgress(0)}
    else if(speechStarted&&recordingPurpose?.type==="new"){if(!silentSince)silentSince=performance.now();const p=Math.min(1,(performance.now()-silentSince)/SILENCE_MS);setSilenceProgress(p);if(p>=1){finalizeSegment();return}}
    animationFrame=requestAnimationFrame(tick);
  };tick();
}
function setSilenceProgress(p){nextButton.style.setProperty("--silence-progress",String(p))}
function finalizeSegment(){if(recorder?.state!=="recording")return;cancelAnimationFrame(animationFrame);recorder.stop()}
function nextLine(){if(recorder?.state==="recording"&&recordingPurpose?.type==="new")finalizeSegment()}
function stopAll(){continuous=false;pendingClarifyRowId=null;discardStoppedSegment=false;if(recorder?.state==="recording")recorder.stop();else closeStream();updateVoiceUi()}
async function onRecorderStop(){
  cancelAnimationFrame(animationFrame);setSilenceProgress(0);
  const purpose=recordingPurpose,mt=recorder?.mimeType||"audio/webm",blob=new Blob(chunks,{type:mt});recorder=null;chunks=[];
  const discard=purpose?.type==="new"&&discardStoppedSegment;if(discard)discardStoppedSegment=false;
  let row=null;
  if(purpose?.type==="new"&&!discard){row=newRow("Распознаём…");row.pending=true;rows.unshift(row);render()}
  else if(purpose?.type==="clarify"){row=rows.find(x=>x.id===purpose.rowId);if(row){row.pending=true;render()}}
  if(purpose?.type==="new"&&pendingClarifyRowId){const id=pendingClarifyRowId;pendingClarifyRowId=null;setTimeout(()=>{if(stream?.active&&!recorder)beginRecorder({type:"clarify",rowId:id})},80)}
  else if(purpose?.type==="new"&&continuous){setTimeout(()=>{if(continuous&&stream?.active&&!recorder)beginRecorder({type:"new"})},90)}
  else{continuous=false;closeStream()}
  updateVoiceUi();
  if(!row||blob.size<500){
    if(row?.text==="Распознаём…") rows=rows.filter(x=>x.id!==row.id);
    else if(row) row.pending=false;
    render();return;
  }
  try{
    const form=new FormData(),ext=mt.includes("mp4")?"m4a":"webm";form.append("audio",blob,"voice."+ext);
    const d=await api("/api/transcribe",{method:"POST",body:form});
    if(purpose?.type==="clarify"){
      const extra=String(d.text||"").trim();if(extra)row.text=[row.text,extra].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
      row.pending=true;render();await rematch(row.id);return;
    }
    row.text=d.text||"";row.rawText=d.rawText||d.text||"";applyParsed(row,d);render();
  }catch(e){row.pending=false;if(row.text==="Распознаём…")row.text="";render();toast(e.message)}
}
function closeStream(){stream?.getTracks().forEach(t=>t.stop());stream=null;if(audioContext){audioContext.close().catch(()=>{});audioContext=null;analyser=null}equalizer.querySelectorAll("i").forEach(b=>b.style.height="7px")}
function updateVoiceUi(){
  const live=recorder?.state==="recording",clarify=live&&recordingPurpose?.type==="clarify",main=live&&recordingPurpose?.type==="new";
  voiceDock.classList.toggle("live",live);playButton.classList.toggle("clarify",clarify);nextButton.disabled=!main;nextButton.classList.toggle("enabled",main);
  if(clarify){playIcon.textContent="■";voiceTitle.textContent="Уточнение";voiceHint.textContent="Нажмите Stop, когда закончите"}
  else if(main){playIcon.textContent="Ⅱ";voiceTitle.textContent="Слушаю";voiceHint.textContent="Пауза — новая строка"}
  else if(pendingClarifyRowId){playIcon.textContent="■";voiceTitle.textContent="Переключаюсь";voiceHint.textContent="На уточнение"}
  else{playIcon.textContent="▶";voiceTitle.textContent="Готов";voiceHint.textContent="Play — продолжить"}
}
playButton.onclick=()=>{if(recorder?.state==="recording")stopAll();else startMain().catch(e=>toast(e.message))};
nextButton.onclick=nextLine;

async function saveRequest(){const valid=rows.filter(r=>r.text.trim());if(!valid.length)return toast("Добавьте позицию");saveButton.disabled=true;saveState.textContent="Сохраняем…";try{const s=await api("/api/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:valid})});saveState.textContent="Заявка #"+s.id+" сохранена";toast("Заявка сохранена")}catch(e){saveState.textContent="";toast(e.message)}finally{saveButton.disabled=false}}
addManualButton.onclick=addManual;saveButton.onclick=saveRequest;catalogButton.onclick=()=>catalogDialog.showModal();
document.querySelectorAll(".close-dialog").forEach(b=>b.onclick=()=>b.closest("dialog").close());
[catalogDialog,segmentDialog].forEach(d=>d.addEventListener("click",e=>{if(e.target===d)d.close()}));
window.addEventListener("beforeunload",closeStream);
bootstrap().catch(e=>toast(e.message));render();updateVoiceUi();
