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
  send({ type: "ask", text });
  $("askInput").value = "";
});

$("clearFeedBtn").addEventListener("click", () => { feed.innerHTML = ""; cards.clear(); });

connect();
