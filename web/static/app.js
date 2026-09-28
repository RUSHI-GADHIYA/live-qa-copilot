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
    case "answer_sources": setSources(ev.question_id, ev.sources); break;
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
// Room: one mic hears everyone. Call: capture only the call's audio (a shared tab or the system sound),
// so your own voice never reaches the app.
async function captureAudio(source) {
  if (source === "room") {
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // Chrome only offers audio sharing together with video
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: "include",
    selfBrowserSurface: "exclude",
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) {
    throw new Error('no audio shared. Pick the call tab with "Share tab audio" on, or the entire screen with "Share system audio".');
  }
  return stream;
}

async function startMic() {
  $("listenBtn").disabled = true;
  const source = $("sourceSelect").value;
  try {
    const stream = await captureAudio(source);
    // Ask for 24 kHz directly; the worklet resamples if the browser picks another rate.
    const ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.audioWorklet.addModule("/static/pcm-worklet.js");
    const node = new AudioWorkletNode(ctx, "pcm-worklet");
    const gate = new SilenceGate();
    node.port.onmessage = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      for (const chunk of $("gateToggle").checked ? gate.push(e.data) : [e.data]) ws.send(chunk);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    // "Stop sharing" in the browser bar, or an unplugged mic, ends listening too.
    stream.getAudioTracks()[0].addEventListener("ended", () => { if (mic) $("listenBtn").click(); });
    mic = { stream, ctx, node };
    send({ type: "start", source });
    showTranscript(source === "call" ? "listening to the call…" : "listening…", true, false);
  } catch (err) {
    stopMic();
    setStatus(`${source === "call" ? "call audio" : "mic"} error: ${err.message}`);
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
  $("sourceSelect").disabled = active;
  if (!active) showTranscript("(not listening)", true, false);
}

// Remember the audio source between visits (a per-browser convenience; storage may be unavailable).
try {
  const saved = localStorage.getItem("source");
  if (saved) $("sourceSelect").value = saved;
} catch {}
$("sourceSelect").addEventListener("change", () => {
  try { localStorage.setItem("source", $("sourceSelect").value); } catch {}
});

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
  card.innerHTML = `<div class="q"></div><div class="a"></div><div class="sources"></div>`;
  card.querySelector(".q").textContent = `Q${id}: ${question}`;
  card.answer = ""; // raw answer text, including [n] citation markers
  card.sources = []; // passages the answer could cite: { n, doc, snippet }
  cards.set(id, card);
  feed.appendChild(card);
  scrollFeed();
}

function setSources(id, sources) {
  const card = cards.get(id);
  if (card) card.sources = sources;
}

function appendDelta(id, delta) {
  const card = cards.get(id);
  if (!card) return;
  card.classList.remove("thinking");
  card.classList.add("streaming");
  card.answer += delta;
  renderAnswer(card);
  scrollFeed();
}

// Answer text with [n] markers shown as small citation chips. Built from text nodes: model output is never HTML.
function renderAnswer(card) {
  const a = card.querySelector(".a");
  a.replaceChildren();
  const parts = card.answer.split(/\[(\d+)\]/);
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      if (part) a.append(part);
      return;
    }
    const source = card.sources.find((s) => s.n === Number(part));
    const cite = document.createElement("sup");
    cite.className = "cite";
    cite.textContent = part;
    if (source) cite.title = `${source.doc}: ${source.snippet}`;
    a.append(cite);
  });
}

function finishCard(id) {
  const card = cards.get(id);
  if (!card) return;
  card.classList.remove("thinking", "streaming");
  const cited = new Set([...card.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const used = card.sources.filter((s) => cited.has(s.n));
  const row = card.querySelector(".sources");
  row.replaceChildren();
  if (used.length) {
    const docs = [...new Set(used.map((s) => s.doc))];
    for (const doc of docs) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = doc;
      chip.title = used.filter((s) => s.doc === doc).map((s) => `[${s.n}] ${s.snippet}`).join("\n\n");
      row.append(chip);
    }
  } else if (card.sources.length) {
    // Context was available but did not cover this question.
    const missing = card.answer.trimStart().startsWith("Not in your notes");
    const badge = document.createElement("span");
    badge.className = missing ? "chip missing" : "chip general";
    badge.textContent = missing ? "Not in your notes" : "General knowledge";
    badge.title = missing ? "Nothing in your documents covers this; add it to the context" : "Your context did not cover this question";
    row.append(badge);
  }
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
  const list = $("docList");
  list.replaceChildren();
  for (const doc of info.documents) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "doc-name";
    name.textContent = doc.name;
    name.title = doc.preview;
    const size = document.createElement("span");
    size.className = "muted small";
    size.textContent = `${doc.chars.toLocaleString()} chars`;
    const remove = document.createElement("button");
    remove.className = "icon-btn";
    remove.textContent = "×";
    remove.title = `Remove ${doc.name}`;
    remove.addEventListener("click", () => withContext(() => contextRequest("DELETE", `/context/${doc.id}`)));
    item.append(name, size, remove);
    list.append(item);
  }
  $("contextInfo").textContent = !info.documents.length
    ? "No context loaded."
    : info.mode === "full"
      ? `${info.total_chars.toLocaleString()} chars, all sent with each question`
      : `${info.total_chars.toLocaleString()} chars, ${info.chunks} chunks; the most relevant are sent with each question`;
  $("contextWarn").hidden = true;
}

async function withContext(action) {
  try { renderContext(await action()); }
  catch (err) { $("contextWarn").hidden = false; $("contextWarn").textContent = err.message; }
}

$("addTextBtn").addEventListener("click", () => {
  const text = $("contextText").value;
  if (!text.trim()) return;
  withContext(async () => {
    const info = await contextRequest("POST", "/context/text", JSON.stringify({ text, name: $("contextName").value }));
    $("contextText").value = "";
    $("contextName").value = "";
    return info;
  });
});

$("clearContextBtn").addEventListener("click", () => withContext(() => contextRequest("DELETE", "/context")));

$("contextFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const file of files) {
    $("contextInfo").textContent = `Indexing ${file.name}…`;
    const form = new FormData();
    form.append("file", file);
    await withContext(() => contextRequest("POST", "/context/file", form));
  }
});

withContext(() => contextRequest("GET", "/context"));
