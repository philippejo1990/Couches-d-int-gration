// host.js — Écran animateur (Supabase Realtime, sans base de données)
import { supabase, topics } from "./supabase-config.js";
import { QUESTIONS } from "./questions.js";

const COLORS = ["#e21b3c", "#1368ce", "#d89e00", "#26890c"];
const SHAPES = ["▲", "◆", "●", "■"];
const MAX_PLAYERS = 80; // marge de sécurité vis-à-vis de la limite de 100 messages/s du plan gratuit
const MAX_NAME = 20;

const $ = (id) => document.getElementById(id);

// ───────── État de la partie (uniquement en mémoire, dans cet onglet) ─────────
let questions = QUESTIONS;
let pin = null;
let pubChannel = null;    // animateur → joueurs
let inboxChannel = null;  // joueurs → animateur
let phase = "setup";      // setup | lobby | question | reveal | finished
let current = -1;
let questionStartedAt = 0;
let timerId = null;
let syncTimer = null;
const players = new Map(); // id → { name, secret, score, last, answered, ok }
const answers = new Map(); // id → { choice, at }   (question en cours uniquement)
const banned = new Set();

// ───────── Affichage ─────────
function show(view) {
  for (const v of ["setupView", "lobbyView", "questionView", "leaderboardView"]) {
    $(v).hidden = v !== view;
  }
}
const setStatus = (msg) => ($("status").textContent = msg);

function renderChoices(ul, choices, correct = null) {
  ul.innerHTML = "";
  choices.forEach((c, i) => {
    const li = document.createElement("li");
    li.textContent = `${SHAPES[i]} ${c}`;          // textContent = pas d'injection HTML
    li.style.background = COLORS[i];
    if (correct !== null && i !== correct) li.classList.add("dim");
    ul.append(li);
  });
}

function renderPlayers() {
  $("count").textContent = players.size;
  $("playerCount").textContent = players.size;
  $("startBtn").disabled = players.size === 0;
  const ul = $("playerList");
  ul.innerHTML = "";
  for (const [id, p] of players) {
    const li = document.createElement("li");
    li.textContent = p.name;
    const kick = document.createElement("button");
    kick.textContent = "✖";
    kick.title = "Exclure ce joueur";
    kick.onclick = () => {
      banned.add(id);
      players.delete(id);
      renderPlayers();
      scheduleSync();
    };
    li.append(kick);
    ul.append(li);
  }
}

function renderLeaderboard(title) {
  $("lbTitle").textContent = title;
  const ol = $("leaderboard");
  ol.innerHTML = "";
  [...players.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10) // top 10 à l'écran ; chaque joueur voit son rang sur son téléphone
    .forEach((p) => {
      const li = document.createElement("li");
      li.textContent = `${p.name} — ${p.score} pts` + (phase === "reveal" ? ` (+${p.last})` : "");
      ol.append(li);
    });
  show("leaderboardView");
}

// ───────── 1. Questions ─────────
function validateQuestions(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("Il faut une liste de questions non vide.");
  list.forEach((q, i) => {
    const n = i + 1;
    if (typeof q.text !== "string" || !q.text.trim()) throw new Error(`Question ${n} : texte manquant.`);
    if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 4)
      throw new Error(`Question ${n} : il faut 2 à 4 choix.`);
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.choices.length)
      throw new Error(`Question ${n} : "correct" doit être la position d'un choix (0 = premier).`);
    if (!(q.duration > 0)) q.duration = 20;
  });
  return list;
}

try {
  validateQuestions(questions);
  $("qSource").textContent = `${questions.length} questions (questions.js)`;
} catch (e) {
  $("qSource").textContent = "⚠️ questions.js invalide";
  $("setupError").textContent = e.message;
}

$("fileInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    questions = validateQuestions(JSON.parse(await file.text()));
    $("qSource").textContent = `${questions.length} questions (${file.name})`;
    $("setupError").textContent = "";
  } catch (err) {
    $("setupError").textContent = "Fichier invalide : " + err.message;
  }
};

// ───────── 2. Connexion aux canaux ─────────
function subscribe(channel) {
  return new Promise((resolve, reject) => {
    let first = true;
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        setStatus("🟢 Connecté");
        if (first) { first = false; resolve(); }
        else scheduleSync(); // reconnexion automatique : on renvoie l'état aux joueurs
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setStatus("🟠 Connexion perdue, reconnexion…");
        if (first) { first = false; reject(err || new Error(status)); }
      }
    });
  });
}

$("createBtn").onclick = async () => {
  try { validateQuestions(questions); }
  catch (e) { $("setupError").textContent = e.message; return; }

  $("createBtn").disabled = true;
  $("setupError").textContent = "";
  setStatus("Connexion à Supabase…");
  await supabase.removeAllChannels();

  pin = String(Math.floor(100000 + Math.random() * 900000));
  pubChannel = supabase.channel(topics.public(pin), { config: { broadcast: { ack: true } } });
  inboxChannel = supabase
    .channel(topics.inbox(pin))
    .on("broadcast", { event: "join" }, ({ payload }) => onJoin(payload))
    .on("broadcast", { event: "answer" }, ({ payload }) => onAnswer(payload));

  try {
    await Promise.all([subscribe(pubChannel), subscribe(inboxChannel)]);
  } catch (e) {
    $("setupError").textContent = "Connexion impossible (URL/clé Supabase ? réseau ?) : " + e.message;
    $("createBtn").disabled = false;
    return;
  }

  phase = "lobby";
  $("pin").textContent = pin;
  const url = new URL("play.html", location.href);
  url.searchParams.set("pin", pin);
  $("joinUrl").href = url.href;
  $("joinUrl").textContent = url.href;
  renderPlayers();
  show("lobbyView");
};

// ───────── 3. Messages reçus des joueurs ─────────
function uniqueName(name) {
  const taken = new Set([...players.values()].map((p) => p.name.toLowerCase()));
  let candidate = name, n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${name} (${n++})`;
  return candidate;
}

function onJoin({ id, secret, name } = {}) {
  if (phase === "setup" || typeof id !== "string" || typeof secret !== "string" || banned.has(id)) return;

  const existing = players.get(id);
  if (existing) {
    // Joueur déjà inscrit qui se reconnecte (page rechargée, téléphone déverrouillé…)
    if (existing.secret === secret) scheduleSync();
    return;
  }
  if (phase === "finished" || players.size >= MAX_PLAYERS) return; // le joueur verra « partie introuvable/pleine »

  name = String(name ?? "").trim().slice(0, MAX_NAME);
  if (!name) return;
  players.set(id, { name: uniqueName(name), secret, score: 0, last: 0, answered: false, ok: false });
  renderPlayers();
  scheduleSync();
}

function onAnswer({ id, secret, q, choice } = {}) {
  const p = players.get(id);
  if (!p || p.secret !== secret) return;                          // usurpation → ignoré
  if (phase !== "question" || q !== current || answers.has(id)) return; // trop tard / doublon
  if (!Number.isInteger(choice) || choice < 0 || choice >= questions[current].choices.length) return;

  answers.set(id, { choice, at: Date.now() }); // l'heure est mesurée ICI : impossible à falsifier
  p.answered = true;
  $("answerCount").textContent = answers.size;
  if (answers.size >= players.size) reveal();  // tout le monde a répondu
}

// ───────── 4. Diffusion de l'état aux joueurs ─────────
function snapshot() {
  const q = questions[current];
  const s = {
    phase,
    qIndex: current,
    total: questions.length,
    players: [...players].map(([id, p]) => ({
      id, name: p.name, score: p.score, last: p.last, answered: p.answered, ok: p.ok,
    })), // ⚠️ le "secret" n'est jamais diffusé
  };
  if (phase === "question" || phase === "reveal") s.question = { text: q.text, choices: q.choices };
  if (phase === "question") s.remaining = Math.max(0, q.duration - (Date.now() - questionStartedAt) / 1000);
  if (phase === "reveal") s.correct = q.correct; // la bonne réponse n'est envoyée qu'à la révélation
  return s;
}

async function broadcastState() {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (!pubChannel || phase === "setup") return;
  const res = await pubChannel.send({ type: "broadcast", event: "state", payload: snapshot() });
  if (res !== "ok") {
    setStatus("🟠 Envoi non confirmé, nouvel essai…");
    scheduleSync(1500);
  }
}

// Regroupe les envois (ex. 30 joueurs qui arrivent en même temps = quelques envois, pas 30)
function scheduleSync(delay = Math.max(800, players.size * 25)) {
  if (syncTimer) return;
  syncTimer = setTimeout(broadcastState, delay);
}

// ───────── 5. Déroulé de la partie ─────────
function nextQuestion() {
  current++;
  if (current >= questions.length) return finish();

  const q = questions[current];
  phase = "question";
  answers.clear();
  for (const p of players.values()) { p.answered = false; p.ok = false; p.last = 0; }
  questionStartedAt = Date.now();
  broadcastState();

  $("qProgress").textContent = `Question ${current + 1} / ${questions.length}`;
  $("qText").textContent = q.text;
  renderChoices($("qChoices"), q.choices);
  $("answerCount").textContent = 0;
  $("playerCount").textContent = players.size;
  show("questionView");

  clearInterval(timerId);
  const tick = () => {
    const left = Math.ceil(q.duration - (Date.now() - questionStartedAt) / 1000);
    $("timer").textContent = Math.max(0, left);
    if (left <= 0) reveal();
  };
  tick();
  timerId = setInterval(tick, 250);
}

function reveal() {
  if (phase !== "question") return;
  phase = "reveal";
  clearInterval(timerId);

  const q = questions[current];
  for (const [id, p] of players) {
    const a = answers.get(id);
    p.ok = !!a && a.choice === q.correct;
    p.last = 0;
    if (p.ok) {
      // Façon Kahoot : 1000 pts si réponse immédiate, 500 pts à la dernière seconde
      const elapsed = Math.max(0, (a.at - questionStartedAt) / 1000);
      p.last = Math.round(1000 * (1 - Math.min(1, elapsed / q.duration) / 2));
      p.score += p.last;
    }
  }
  broadcastState();

  renderChoices($("revealChoices"), q.choices, q.correct);
  renderLeaderboard(`Bonne réponse : ${q.choices[q.correct]}`);
  $("nextBtn").textContent =
    current + 1 >= questions.length ? "🏁 Classement final" : "Question suivante ➡️";
}

function finish() {
  phase = "finished";
  clearInterval(timerId);
  broadcastState();
  $("revealChoices").innerHTML = "";
  renderLeaderboard("🏆 Classement final");
  $("nextBtn").hidden = true;
  setStatus("Partie terminée. Recharge la page pour en créer une nouvelle.");
}

$("startBtn").onclick = nextQuestion;
$("nextBtn").onclick = nextQuestion;
$("revealBtn").onclick = reveal;

// La partie n'existe que dans cet onglet : on évite de la perdre par erreur
window.addEventListener("beforeunload", (e) => {
  if (phase !== "setup" && phase !== "finished") { e.preventDefault(); e.returnValue = ""; }
});
