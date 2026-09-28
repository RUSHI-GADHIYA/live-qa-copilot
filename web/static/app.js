const $ = (id) => document.getElementById(id);
const feed = $("feed");
const cards = new Map(); // question_id -> card element

let ws;
let mic = null; // { stream, ctx, node } while capturing

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { setStatus("connected"); $("listenBtn").disabled = false; };
  ws.onclose = () => {
    stopMic();
    $("listenBtn").disabled = true;
    setStatus("disconnected, retrying…");
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setStatus(text) { $("status").textContent = text; }

function handleEvent(ev) {
  switch (ev.type) {
    case "transcript_partial": showTranscript(ev.text, true); break;
    case "transcript_final": showTranscript(ev.text, false); break;
    case "utterance_ignored": showIgnored(ev); break;
    case "listening": if (!ev.active) stopMic(); setListeningUi(ev.active); break;
    case "question_detected": addCard(ev.question_id, ev.text); break;
    case "answer_delta": appendDelta(ev.question_id, ev.delta); break;
    case "answer_done": finishCard(ev.question_id); break;
    case "error": showError(ev); break;
  }
}

function showTranscript(text, partial, quoted = true) {
  const el = $("transcript");
  el.textContent = quoted ? `"${text}"` : text;
  el.classList.toggle("muted", partial);
  $("transcriptTag").hidden = true;
}

// Utterances that did not become a card, e.g. you reading an answer aloud.
function showIgnored(ev) {
  const el = $("transcript");
  el.textContent = `"${ev.text}"`;
  el.classList.add("muted");
  const tag = $("transcriptTag");
  tag.textContent = `ignored: ${ev.reason}`;
  tag.hidden = false;
  if (ev.reason === "repeat" && cards.has(ev.question_id)) {
    const card = cards.get(ev.question_id);
    card.classList.remove("pulse");
    void card.offsetWidth; // restart the animation
    card.classList.add("pulse");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ---- Microphone ----
async function startMic() {
  $("listenBtn").disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // Ask for 24 kHz directly; the worklet resamples if the browser picks another rate.
    const ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.audioWorklet.addModule("/static/pcm-worklet.js");
    const node = new AudioWorkletNode(ctx, "pcm-worklet");
    node.port.onmessage = (e) => { if (ws.readyState === WebSocket.OPEN) ws.send(e.data); };
    ctx.createMediaStreamSource(stream).connect(node);
    mic = { stream, ctx, node };
    send({ type: "start" });
    showTranscript("listening…", true, false);
  } catch (err) {
    stopMic();
    setStatus(`mic error: ${err.message}`);
    setListeningUi(false);
  }
}

function stopMic() {
  if (!mic) return;
  mic.node.port.onmessage = null;
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.ctx.close();
  mic = null;
}

function setListeningUi(active) {
  const btn = $("listenBtn");
  btn.disabled = !ws || ws.readyState !== WebSocket.OPEN;
  btn.classList.toggle("live", active);
  btn.textContent = active ? "■ Stop listening" : "● Start listening";
  if (!active) showTranscript("(not listening)", true, false);
}

$("listenBtn").addEventListener("click", () => {
  if (mic) {
    stopMic();
    send({ type: "stop" });
    setListeningUi(false);
  } else {
    startMic();
  }
});

function addCard(id, question) {
  const card = document.createElement("div");
  card.className = "card thinking";
  card.innerHTML = `<div class="q"></div><div class="a"></div>`;
  card.querySelector(".q").textContent = `Q${id}: ${question}`;
  cards.set(id, card);
  feed.appendChild(card);
  scrollFeed();
}

function appendDelta(id, delta) {
  const card = cards.get(id);
  if (!card) return;
  card.classList.remove("thinking");
  card.classList.add("streaming");
  card.querySelector(".a").textContent += delta;
  scrollFeed();
}

function finishCard(id) {
  const card = cards.get(id);
  if (card) card.classList.remove("thinking", "streaming");
}

function showError(ev) {
  const card = ev.question_id != null && cards.get(ev.question_id);
  if (card) {
    card.classList.remove("thinking", "streaming");
    card.classList.add("error");
    const a = card.querySelector(".a");
    a.textContent += `${a.textContent ? "\n" : ""}[error] ${ev.message}`;
  } else {
    setStatus(`error: ${ev.message}`);
  }
}

function scrollFeed() { feed.scrollTop = feed.scrollHeight; }

$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("askInput").value.trim();
  if (!text) return;
  // "utterance" goes through the question detector like speech does; "ask" skips it.
  send({ type: $("detectToggle").checked ? "utterance" : "ask", text });
  $("askInput").value = "";
});

$("clearFeedBtn").addEventListener("click", () => { feed.innerHTML = ""; cards.clear(); });

connect();

// ---- Context panel ----
async function contextRequest(method, path, body) {
  const res = await fetch(path, { method, body, headers: typeof body === "string" ? { "Content-Type": "application/json" } : {} });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

function renderContext(info) {
  $("contextInfo").textContent = info.length
    ? `${info.length.toLocaleString()} chars from ${info.source}`
    : "No context loaded.";
  const warn = $("contextWarn");
  warn.hidden = !info.truncated;
  warn.textContent = info.truncated
    ? `Context was ${info.original_length.toLocaleString()} chars; truncated to ${info.max_length.toLocaleString()}.`
    : "";
}

async function withContext(action) {
  try { renderContext(await action()); }
  catch (err) { $("contextWarn").hidden = false; $("contextWarn").textContent = err.message; }
}

$("saveContextBtn").addEventListener("click", () =>
  withContext(() => contextRequest("POST", "/context/text", JSON.stringify({ text: $("contextText").value }))));

$("clearContextBtn").addEventListener("click", () =>
  withContext(async () => { $("contextText").value = ""; return contextRequest("DELETE", "/context"); }));

$("contextFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  withContext(async () => {
    const info = await contextRequest("POST", "/context/file", form);
    $("contextText").value = info.preview + (info.length > info.preview.length ? "\n…" : "");
    return info;
  });
  e.target.value = "";
});

withContext(() => contextRequest("GET", "/context"));
