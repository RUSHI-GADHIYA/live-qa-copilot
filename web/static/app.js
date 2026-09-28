const $ = (id) => document.getElementById(id);
const feed = $("feed");
const cards = new Map(); // question_id -> card element

let ws;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => setStatus("connected");
  ws.onclose = () => { setStatus("disconnected, retrying…"); setTimeout(connect, 1500); };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setStatus(text) { $("status").textContent = text; }

function handleEvent(ev) {
  switch (ev.type) {
    case "question_detected": addCard(ev.question_id, ev.text); break;
    case "answer_delta": appendDelta(ev.question_id, ev.delta); break;
    case "answer_done": finishCard(ev.question_id); break;
    case "error": showError(ev); break;
  }
}

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
    card.querySelector(".a").textContent += `\n[error] ${ev.message}`;
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
