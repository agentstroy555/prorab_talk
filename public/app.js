const $=s=>document.querySelector(s);
const rowsEl=$("#rows"),emptyState=$("#emptyState"),addManualButton=$("#addManualButton"),saveButton=$("#saveButton"),saveState=$("#saveState");
const apiStatus=$("#apiStatus"),catalogButton=$("#catalogButton"),catalogDialog=$("#catalogDialog"),catalogText=$("#catalogText");
const toastEl=$("#toast"),voiceDock=$("#voiceDock"),equalizer=$("#equalizer"),nextButton=$("#nextButton"),playButton=$("#playButton"),playIcon=$("#playIcon"),voiceTitle=$("#voiceTitle"),voiceHint=$("#voiceHint");

let rows=[],catalog=[],families=[],rowSeq=0;
let continuous=false,stream=null,recorder=null,chunks=[],analyser=null,audioContext=null,animationFrame=null,speechStarted=false,silentSince=null,recordingPurpose=null;
let pendingClarifyRowId=null,discardStoppedSegment=false;
const SILENCE_MS=650,RMS_THRESHOLD=.025;

function toast(message){toastEl.textContent=message;toastEl.classList.add("show");clearTimeout(toastEl._t);toastEl._t=setTimeout(()=>toastEl.classList.remove("show"),2200)}
async function api(url,options={}){const r=await fetch(url,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.details||d.error||"Ошибка запроса");return d}
async function bootstrap(){
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
  const family=row.familyName||"Товар?";
  const variant=row.variantLabel||"Вариант?";
  const qty=row.quantity!==""&&row.quantity!==null&&row.quantity!==undefined?String(row.quantity):"Количество?";
  const unit=row.unit||row.orderUnit||"";
  return [family,variant,(qty+(unit?" "+unit:""))].join(" · ");
}
function editorHtml(row){
  const fam=familyChoices(row),variants=variantChoices(row),units=unitChoices(row);
  const famPlaceholder=!row.familyId&&!row.manualFamily?option("","Выберите товар",true):"";
  const varPlaceholder=!row.variantId&&!row.manualVariant?option("","Выберите вариант",true):"";
  const famSelect=famPlaceholder+fam.map(x=>option(x.value,x.label,x.value===row.familyId)).join("")+option("__manual__","Ввести вручную",row.manualFamily);
  const varSelect=varPlaceholder+variants.map(x=>option(x.value,x.label,x.value===row.variantId)).join("")+option("__manual__","Ввести вручную",row.manualVariant);
  const unitSelect=units.map(x=>option(x,x,x===(row.unit||row.orderUnit))).join("");
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
    el.querySelector(".clarify-button").onclick=()=>startClarify(row.id).catch(e=>toast(e.message));
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
function addManual(){const r=newRow("");r.editing=true;rows.unshift(r);render();setTimeout(()=>rowsEl.querySelector(".voice-textarea")?.focus(),0)}

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
    else if(speechStarted&&recordingPurpose?.type==="new"){
      if(!silentSince)silentSince=performance.now();
      const p=Math.min(1,(performance.now()-silentSince)/SILENCE_MS);setSilenceProgress(p);
      if(p>=1){finalizeSegment();return}
    }
    animationFrame=requestAnimationFrame(tick);
  };tick();
}
function setSilenceProgress(p){nextButton.style.setProperty("--silence-progress",String(p))}
function finalizeSegment(){if(recorder?.state!=="recording")return;cancelAnimationFrame(animationFrame);recorder.stop()}
function nextLine(){if(recorder?.state==="recording"&&recordingPurpose?.type==="new")finalizeSegment()}
function stopAll(){
  continuous=false;pendingClarifyRowId=null;
  if(recordingPurpose?.type==="new")discardStoppedSegment=!speechStarted;else discardStoppedSegment=false;
  if(recorder?.state==="recording")recorder.stop();else closeStream();updateVoiceUi()
}
async function onRecorderStop(){
  cancelAnimationFrame(animationFrame);setSilenceProgress(0);
  const purpose=recordingPurpose,mt=recorder?.mimeType||"audio/webm",blob=new Blob(chunks,{type:mt});recorder=null;chunks=[];
  const discard=purpose?.type==="new"&&discardStoppedSegment;if(discard)discardStoppedSegment=false;
  let row=null;
  if(purpose?.type==="new"&&!discard){row=newRow("Распознаём…");row.pending=true;rows.unshift(row);render()}
  else if(purpose?.type==="clarify"){row=rows.find(x=>x.id===purpose.rowId);if(row){row.pending=true;render()}}
  if(purpose?.type==="new"&&pendingClarifyRowId){
    const id=pendingClarifyRowId;pendingClarifyRowId=null;
    setTimeout(()=>{if(stream?.active&&!recorder)beginRecorder({type:"clarify",rowId:id})},80)
  }else if(purpose?.type==="new"&&continuous){
    setTimeout(()=>{if(continuous&&stream?.active&&!recorder)beginRecorder({type:"new"})},90)
  }else{continuous=false;closeStream()}
  updateVoiceUi();
  if(!row||blob.size<500){
    if(row?.text==="Распознаём…")rows=rows.filter(x=>x.id!==row.id);else if(row)row.pending=false;
    render();return;
  }
  try{
    const form=new FormData(),ext=mt.includes("mp4")?"m4a":"webm";form.append("audio",blob,"voice."+ext);
    const d=await api("/api/transcribe",{method:"POST",body:form});
    if(purpose?.type==="clarify"){
      const extra=String(d.text||"").trim();if(extra)row.text=[row.text,extra].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
      row.pending=true;render();await rematch(row.id,{collapse:true});return;
    }
    row.text=d.text||"";row.rawText=d.rawText||d.text||"";applyParsed(row,d);render();
  }catch(e){row.pending=false;if(row.text==="Распознаём…")row.text="";render();toast(e.message)}
}
function closeStream(){
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  if(audioContext){audioContext.close().catch(()=>{});audioContext=null;analyser=null}
  equalizer.querySelectorAll("i").forEach(b=>b.style.height="7px")
}
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
window.addEventListener("beforeunload",closeStream);
bootstrap().catch(e=>toast(e.message));render();updateVoiceUi();
