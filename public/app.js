const rowsEl = document.querySelector("#rows");
const emptyState = document.querySelector("#emptyState");
const startButton = document.querySelector("#startButton");
const nextButton = document.querySelector("#nextButton");
const stopButton = document.querySelector("#stopButton");
const addManualButton = document.querySelector("#addManualButton");
const saveButton = document.querySelector("#saveButton");
const saveState = document.querySelector("#saveState");
const micPulse = document.querySelector("#micPulse");
const voiceTitle = document.querySelector("#voiceTitle");
const voiceHint = document.querySelector("#voiceHint");
const apiStatus = document.querySelector("#apiStatus");
const catalogButton = document.querySelector("#catalogButton");
const catalogDialog = document.querySelector("#catalogDialog");
const catalogText = document.querySelector("#catalogText");
const pickerDialog = document.querySelector("#pickerDialog");
const pickerSearch = document.querySelector("#pickerSearch");
const pickerResults = document.querySelector("#pickerResults");
const toastEl = document.querySelector("#toast");

let rows = [];
let catalog = [];
let rowSeq = 0;
let pickerRowId = null;
let continuous = false;
let stream = null;
let recorder = null;
let chunks = [];
let analyser = null;
let audioContext = null;
let animationFrame = null;
let speechStarted = false;
let silentSince = null;
let recordingPurpose = null;
let clarifyingRowId = null;

const SILENCE_MS = 1250;
const RMS_THRESHOLD = 0.025;

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove("show"), 2300);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.details || data.error || "Ошибка запроса");
  return data;
}

async function loadCatalog() {
  catalog = await api("/api/catalog?limit=1000");
  catalogText.textContent = catalog.map(x => x.name).join("\n");
}

async function health() {
  try {
    const result = await api("/api/health");
    apiStatus.textContent = "Сервис готов · " + result.catalog + " позиций";
    apiStatus.className = "status ok";
  } catch {
    apiStatus.textContent = "Сервис недоступен";
    apiStatus.className = "status bad";
  }
}

function newRow(text = "") {
  return {
    id: ++rowSeq,
    rawText: text,
    text,
    candidates: [],
    catalogItemId: null,
    catalogItemName: "",
    quantity: "",
    unit: "",
    pending: false
  };
}

function render() {
  rowsEl.innerHTML = "";
  emptyState.hidden = rows.length > 0;

  rows.forEach((row, index) => {
    if (index > 0) {
      const merge = document.createElement("div");
      merge.className = "merge-wrap";
      merge.innerHTML = '<button class="merge-button" type="button" title="Склеить соседние строки">+</button>';
      merge.querySelector("button").onclick = () => mergeRows(index - 1, index);
      rowsEl.appendChild(merge);
    }

    const el = document.createElement("div");
    el.className = "request-row row-grid" + (row.pending ? " pending" : "");
    const options = row.candidates.length
      ? row.candidates.map((c, i) => '<option value="' + escapeHtml(c.id) + '"' + (c.id === row.catalogItemId ? " selected" : "") + '>' + escapeHtml(c.name) + (i === 0 ? " · лучший" : "") + '</option>').join("")
      : '<option value="">Не удалось определить</option>';

    el.innerHTML =
      '<button class="button clarify" type="button">🎙 Уточнить</button>' +
      '<input class="field text-field" value="' + escapeHtml(row.text) + '" placeholder="Например: ротбанд двадцать мешков">' +
      '<div class="catalog-field"><select class="field catalog-select">' + options + '<option value="__catalog__">Найти в полном каталоге…</option></select>' +
      '<span class="confidence">' + confidenceLabel(row) + '</span></div>' +
      '<input class="field qty-field" inputmode="decimal" value="' + escapeHtml(row.quantity) + '" placeholder="0">' +
      '<input class="field unit-field" value="' + escapeHtml(row.unit) + '" placeholder="шт">' +
      '<button class="delete-row" type="button" title="Удалить">×</button>';

    const textInput = el.querySelector(".text-field");
    let debounce;
    textInput.oninput = () => {
      row.text = textInput.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => rematch(row.id), 350);
    };
    el.querySelector(".qty-field").oninput = e => row.quantity = e.target.value;
    el.querySelector(".unit-field").oninput = e => row.unit = e.target.value;
    el.querySelector(".delete-row").onclick = () => {
      rows = rows.filter(x => x.id !== row.id);
      render();
    };
    el.querySelector(".clarify").onclick = () => startClarify(row.id);
    el.querySelector(".catalog-select").onchange = e => {
      if (e.target.value === "__catalog__") {
        openPicker(row.id);
        e.target.value = row.catalogItemId || "";
        return;
      }
      const candidate = row.candidates.find(c => c.id === e.target.value);
      if (candidate) {
        row.catalogItemId = candidate.id;
        row.catalogItemName = candidate.name;
      }
    };
    rowsEl.appendChild(el);
  });
}

function confidenceLabel(row) {
  if (row.pending) return "Распознаём…";
  const top = row.candidates[0];
  if (!top) return "Нет уверенного совпадения";
  const percent = Math.round(top.score * 100);
  if (percent >= 85) return "Высокая уверенность · " + percent + "%";
  if (percent >= 60) return "Проверьте совпадение · " + percent + "%";
  return "Низкая уверенность · " + percent + "%";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function applyMatch(row, data, append = false) {
  const transcript = String(data.text || "").trim();
  if (append && transcript) {
    row.text = [row.text, transcript].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    row.rawText = row.rawText || row.text;
  } else if (transcript) {
    row.text = transcript;
    row.rawText = data.rawText || transcript;
  }

  row.quantity = data.quantity ?? row.quantity ?? "";
  row.unit = data.unit ?? row.unit ?? "";
  row.candidates = data.candidates || [];
  const top = row.candidates[0];
  if (top) {
    row.catalogItemId = top.id;
    row.catalogItemName = top.name;
  } else {
    row.catalogItemId = null;
    row.catalogItemName = "";
  }
  row.pending = false;
}

async function rematch(rowId) {
  const row = rows.find(x => x.id === rowId);
  if (!row) return;
  try {
    const data = await api("/api/match", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ text:row.text })
    });
    applyMatch(row, data);
    render();
  } catch (error) {
    toast(error.message);
  }
}

async function mergeRows(firstIndex, secondIndex) {
  const first = rows[firstIndex];
  const second = rows[secondIndex];
  if (!first || !second) return;
  first.text = [first.text, second.text].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  first.rawText = [first.rawText, second.rawText].filter(Boolean).join(" ").trim();
  rows.splice(secondIndex, 1);
  first.pending = true;
  render();
  await rematch(first.id);
}

function addManual() {
  const row = newRow("");
  rows.push(row);
  render();
  setTimeout(() => {
    const inputs = rowsEl.querySelectorAll(".text-field");
    inputs[inputs.length - 1]?.focus();
  }, 0);
}

async function ensureStream() {
  if (stream && stream.active) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }
  });
  return stream;
}

function pickMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

async function startContinuous() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("Браузер не поддерживает запись аудио");
    return;
  }
  continuous = true;
  await ensureStream();
  beginRecorder({ type:"new" });
  updateVoiceUi();
}

async function startClarify(rowId) {
  if (recorder && recorder.state === "recording") {
    toast("Сначала завершите текущую запись");
    return;
  }
  continuous = false;
  clarifyingRowId = rowId;
  await ensureStream();
  beginRecorder({ type:"clarify", rowId });
  updateVoiceUi();
}

function beginRecorder(purpose) {
  if (!stream?.active) return;
  recordingPurpose = purpose;
  chunks = [];
  speechStarted = false;
  silentSince = null;

  const mimeType = pickMimeType();
  recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  recorder.ondataavailable = event => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.onstop = onRecorderStop;
  recorder.start(250);
  startSilenceWatcher();
  updateVoiceUi();
}

function startSilenceWatcher() {
  cancelAnimationFrame(animationFrame);
  if (!audioContext) {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
  }

  const data = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!recorder || recorder.state !== "recording") return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / data.length);

    if (rms > RMS_THRESHOLD) {
      speechStarted = true;
      silentSince = null;
    } else if (speechStarted) {
      if (!silentSince) silentSince = performance.now();
      if (performance.now() - silentSince >= SILENCE_MS) {
        finalizeSegment();
        return;
      }
    }
    animationFrame = requestAnimationFrame(tick);
  };
  tick();
}

function finalizeSegment() {
  if (!recorder || recorder.state !== "recording") return;
  cancelAnimationFrame(animationFrame);
  recorder.stop();
}

function nextLine() {
  if (recorder?.state === "recording") finalizeSegment();
}

function stopRecording() {
  continuous = false;
  if (recorder?.state === "recording") recorder.stop();
  else closeStream();
  updateVoiceUi();
}

async function onRecorderStop() {
  cancelAnimationFrame(animationFrame);
  const purpose = recordingPurpose;
  const mimeType = recorder?.mimeType || "audio/webm";
  const blob = new Blob(chunks, { type:mimeType });
  recorder = null;
  chunks = [];

  let targetRow = null;
  if (purpose?.type === "new") {
    targetRow = newRow("Распознаём…");
    targetRow.pending = true;
    rows.push(targetRow);
    render();
  } else if (purpose?.type === "clarify") {
    targetRow = rows.find(x => x.id === purpose.rowId);
    if (targetRow) targetRow.pending = true;
    render();
  }

  if (continuous) {
    setTimeout(() => {
      if (continuous && stream?.active && !recorder) beginRecorder({ type:"new" });
    }, 120);
  } else {
    closeStream();
  }
  updateVoiceUi();

  if (!targetRow || blob.size < 500) {
    if (targetRow?.text === "Распознаём…") rows = rows.filter(x => x.id !== targetRow.id);
    render();
    return;
  }

  try {
    const form = new FormData();
    const extension = mimeType.includes("mp4") ? "m4a" : "webm";
    form.append("audio", blob, "voice." + extension);
    const data = await api("/api/transcribe", { method:"POST", body:form });

    if (purpose?.type === "clarify") {
      targetRow.pending = false;
      const extra = String(data.text || "").trim();
      if (extra) targetRow.text = [targetRow.text, extra].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      await rematch(targetRow.id);
      return;
    }

    applyMatch(targetRow, data);
    render();
  } catch (error) {
    targetRow.pending = false;
    if (targetRow.text === "Распознаём…") targetRow.text = "";
    render();
    toast(error.message);
  }
}

function closeStream() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
}

function updateVoiceUi() {
  const live = recorder?.state === "recording";
  micPulse.classList.toggle("live", live);
  nextButton.disabled = !live || recordingPurpose?.type === "clarify";
  stopButton.disabled = !live && !continuous;
  startButton.disabled = live || continuous;
  if (live && recordingPurpose?.type === "clarify") {
    voiceTitle.textContent = "Говорите уточнение";
    voiceHint.textContent = "Пауза завершит уточнение выбранной строки.";
  } else if (live) {
    voiceTitle.textContent = "Слушаю текущую позицию";
    voiceHint.textContent = "Пауза создаст строку автоматически.";
  } else {
    voiceTitle.textContent = "Микрофон выключен";
    voiceHint.textContent = "Начните диктовку или добавьте позицию вручную.";
  }
}

function openPicker(rowId) {
  pickerRowId = rowId;
  pickerSearch.value = "";
  renderPicker("");
  pickerDialog.showModal();
  setTimeout(() => pickerSearch.focus(), 50);
}

function renderPicker(query) {
  const q = query.trim().toLowerCase().replaceAll("ё", "е");
  const found = catalog
    .filter(item => !q || item.name.toLowerCase().replaceAll("ё", "е").includes(q) || (item.aliases || []).some(a => a.includes(q)))
    .slice(0, 60);
  pickerResults.innerHTML = found.map(item => '<button class="picker-item" data-id="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</button>').join("");
  pickerResults.querySelectorAll(".picker-item").forEach(button => {
    button.onclick = () => {
      const item = catalog.find(x => x.id === button.dataset.id);
      const row = rows.find(x => x.id === pickerRowId);
      if (item && row) {
        row.catalogItemId = item.id;
        row.catalogItemName = item.name;
        if (!row.candidates.some(c => c.id === item.id)) row.candidates.unshift({ ...item, score:1 });
        render();
      }
      pickerDialog.close();
    };
  });
}

async function saveRequest() {
  const valid = rows.filter(row => row.text.trim());
  if (!valid.length) return toast("Добавьте хотя бы одну позицию");
  saveButton.disabled = true;
  saveState.textContent = "Сохраняем…";
  try {
    const saved = await api("/api/requests", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ items:valid })
    });
    saveState.textContent = "Заявка #" + saved.id + " сохранена";
    toast("Заявка сохранена");
  } catch (error) {
    saveState.textContent = "";
    toast(error.message);
  } finally {
    saveButton.disabled = false;
  }
}

startButton.onclick = () => startContinuous().catch(error => toast(error.message));
nextButton.onclick = nextLine;
stopButton.onclick = stopRecording;
addManualButton.onclick = addManual;
saveButton.onclick = saveRequest;
catalogButton.onclick = () => catalogDialog.showModal();
pickerSearch.oninput = () => renderPicker(pickerSearch.value);
document.querySelectorAll(".close-dialog").forEach(button => {
  button.onclick = () => button.closest("dialog").close();
});
[catalogDialog, pickerDialog].forEach(dialog => {
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });
});
window.addEventListener("beforeunload", closeStream);

Promise.all([loadCatalog(), health()]).catch(error => toast(error.message));
render();
