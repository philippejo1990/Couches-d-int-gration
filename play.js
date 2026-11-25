// play.js — Écran joueur (Supabase Realtime)
import { supabase, topics } from "./supabase-config.js";

const COLORS = ["#e21b3c", "#1368ce", "#d89e00", "#26890c"];
const SHAPES = ["▲", "◆", "●", "■"];
const STORAGE_KEY = "quiz-player";

const $ = (id) => document.getElementById(id);

let pin = null;
let me = null;              // { id, secret, name }
let pubChannel = null;      // on y ÉCOUTE l'état de la partie
let inboxChannel = null;    // on y ENVOIE join / answer à l'animateur
let inboxReady = null;
let joined = false;
let joinTimeout = null;
let timerId = null;
let lastState = null;
let deadline = { q: -1, at: 0 };
const answeredLocally = new Set();

// Identifiant aléatoire (fonctionne aussi hors HTTPS, contrairement à crypto.randomUUID)
const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

function show(view) {
  for (const v of ["joinView", "waitView", "questionView", "resultView"]) $(v).hidden = v !== view;
}
function waiting(msg) {
  clearInterval(timerId);
  $("waitMsg").textContent = msg;
  show("waitView");
}
const isCurrentQuestion = (q) => lastState?.phase === "question" && lastState.qIndex === q;

// ───────── Envoi à l'animateur ─────────
// Plan A : httpSend (requête HTTP, seul l'animateur reçoit → économise le quota)
// Plan B : WebSocket classique si httpSend échoue
async function sendToHost(event, payload) {
  try {
    const res = await inboxChannel.httpSend(event, payload);
    if (res && res.success === false) throw new Error(res.error || `HTTP ${res.status}`);
    return;
  } catch (err) {
    console.warn("httpSend indisponible, passage par WebSocket :", err);
  }
  inboxReady ??= new Promise((resolve, reject) => {
    inboxChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error(status));
    });
  });
  try { await inboxReady; } catch (e) { inboxReady = null; throw e; }
  const r = await inboxChannel.send({ type: "broadcast", event, payload });
  if (r !== "ok") throw new Error(`envoi non confirmé (${r})`);
}

// ───────── Rejoindre ─────────
async function start(p, player) {
  pin = p;
  me = player;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ pin, me })); // survit au rechargement de l'onglet
  joined = false;
  inboxReady = null;
  lastState = null;
  deadline = { q: -1, at: 0 };
  answeredLocally.clear();
  $("joinBtn").disabled = true;
  $("joinError").textContent = "";
  waiting("Connexion à la partie…");

  await supabase.removeAllChannels();
  inboxChannel = supabase.channel(topics.inbox(pin), { config: { broadcast: { ack: true } } });
  pubChannel = supabase
    .channel(topics.public(pin))
    .on("broadcast", { event: "state" }, ({ payload }) => render(payload))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") sendJoin(); // aussi après chaque reconnexion automatique
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
        $("footer").textContent = "🟠 Connexion perdue, reconnexion…";
    });
}

async function sendJoin() {
  if (!joined) {
    clearTimeout(joinTimeout);
    joinTimeout = setTimeout(() => {
      if (!joined) failJoin("Partie introuvable, pleine ou terminée. Vérifie le code.");
    }, 8000);
  }
  try {
    await sendToHost("join", { id: me.id, secret: me.secret, name: me.name });
  } catch (e) {
    if (!joined) failJoin("Impossible de contacter la partie : " + e.message);
    else $("footer").textContent = "🟠 Problème réseau, nouvel essai…";
  }
}

function failJoin(msg) {
  clearTimeout(joinTimeout);
  clearInterval(timerId);
  supabase.removeAllChannels();
  sessionStorage.removeItem(STORAGE_KEY);
  joined = false;
  $("joinBtn").disabled = false;
  $("joinError").textContent = msg;
  $("footer").textContent = "";
  show("joinView");
}

$("joinBtn").onclick = () => {
  const p = $("pinInput").value.trim();
  const name = $("nameInput").value.trim();
  if (!/^\d{6}$/.test(p)) return ($("joinError").textContent = "Le code doit faire 6 chiffres.");
  if (!name) return ($("joinError").textContent = "Choisis un pseudo.");
  start(p, { id: randomId(), secret: randomId(), name: name.slice(0, 20) });
};

// ───────── Affichage selon l'état envoyé par l'animateur ─────────
function render(s) {
  lastState = s;
  const mine = s.players?.find((p) => p.id === me.id);
  if (!mine) {
    if (joined) failJoin("Tu as été retiré de la partie par l'animateur.");
    return; // sinon : notre inscription est encore en route
  }
  if (!joined) { joined = true; clearTimeout(joinTimeout); }
  $("footer").textContent = `👤 ${mine.name} · ${mine.score} pts`;

  if (s.phase === "lobby") return waiting("Tu es dans la partie ! Regarde l'écran, ça va commencer…");
  if (s.phase === "question") {
    if (mine.answered || answeredLocally.has(s.qIndex)) return waiting("Réponse envoyée ! Attends la fin du temps…");
    return showQuestion(s);
  }
  showResult(s, mine); // reveal ou finished
}

function showQuestion(s) {
  clearInterval(timerId);
  if (deadline.q !== s.qIndex) deadline = { q: s.qIndex, at: Date.now() + s.remaining * 1000 };

  $("qProgress").textContent = `Question ${s.qIndex + 1} / ${s.total}`;
  $("qText").textContent = s.question.text;
  $("answerError").textContent = "";
  const box = $("choices");
  box.innerHTML = "";
  s.question.choices.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "choice";
    b.style.background = COLORS[i];
    b.textContent = `${SHAPES[i]} ${c}`;
    b.onclick = () => answer(s.qIndex, i);
    box.append(b);
  });

  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline.at - Date.now()) / 1000));
    $("timer").textContent = left;
    if (left === 0) waiting("Temps écoulé !");
  };
  tick();
  timerId = setInterval(tick, 250);
  show("questionView");
}

async function answer(q, choice) {
  answeredLocally.add(q);
  waiting("Envoi de ta réponse…");
  try {
    await sendToHost("answer", { id: me.id, secret: me.secret, q, choice });
    if (isCurrentQuestion(q)) waiting("Réponse envoyée ! Attends la fin du temps…");
  } catch (e) {
    answeredLocally.delete(q);
    if (isCurrentQuestion(q)) {
      showQuestion(lastState);
      $("answerError").textContent = "Envoi impossible, réessaie. (" + e.message + ")";
    }
  }
}

function showResult(s, mine) {
  clearInterval(timerId);
  const ranking = [...s.players].sort((a, b) => b.score - a.score);
  const rank = ranking.findIndex((p) => p.id === me.id) + 1;

  if (s.phase === "finished") {
    $("resultIcon").textContent = ["🏆", "🥈", "🥉"][rank - 1] ?? "🎉";
    $("resultMsg").textContent = "Partie terminée !";
  } else {
    const answerText = s.question.choices[s.correct];
    if (mine.ok) {
      $("resultIcon").textContent = "✅";
      $("resultMsg").textContent = `Bonne réponse ! +${mine.last} pts`;
    } else if (mine.answered) {
      $("resultIcon").textContent = "❌";
      $("resultMsg").textContent = `Raté… C'était : ${answerText}`;
    } else {
      $("resultIcon").textContent = "⌛";
      $("resultMsg").textContent = `Pas de réponse à temps. C'était : ${answerText}`;
    }
  }
  $("scoreMsg").textContent = `Total : ${mine.score} pts · ${rank}${rank === 1 ? "er" : "e"} sur ${ranking.length}`;
  show("resultView");
}

// Téléphone déverrouillé → on redemande l'état sans attendre
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && me && joined) sendJoin();
});

// ───────── Au chargement : code dans l'URL + reprise après rechargement ─────────
const urlPin = new URLSearchParams(location.search).get("pin");
if (urlPin) $("pinInput").value = urlPin;

const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
if (saved && (!urlPin || urlPin === saved.pin)) start(saved.pin, saved.me);
