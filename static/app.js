// Adversary — front end

const $ = s => document.querySelector(s);
const api = (p, o) => fetch(p, o).then(r => r.json());

// ── State ─────────────────────────────────────────────────────────────────────
let currentPersona = "auto";
let lastDebate     = null;   // { question, thesis, antithesis, synthesis, verdict }
let history        = [];
let drillMenu      = null;   // floating context menu element

// ── Boot ──────────────────────────────────────────────────────────────────────
loadStatus();
loadDemos();
loadHistory();

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runDebate(); }
  if (e.key === "Escape") closeDrillMenu();
});
document.addEventListener("click", e => {
  if (drillMenu && !drillMenu.contains(e.target)) closeDrillMenu();
});

$("#debateBtn").onclick      = runDebate;
$("#challengeBtn").onclick   = runChallenge;
$("#steelmanBtn").onclick    = runSteelman;
$("#clearBtn").onclick       = clearAll;
$("#round2Btn").onclick      = runRound2;
$("#fallacyBtn").onclick     = runFallacies;
$("#commonGroundBtn").onclick = runCommonGround;
$("#followUpBtn").onclick    = runFollowUp;
$("#changeMindBtn").onclick  = runChangeMind;
$("#shareBtn").onclick       = shareDebate;
$("#copyBtn").onclick        = copyTranscript;
$("#mdBtn").onclick          = exportMd;
$("#clearHistoryBtn").onclick = clearHistory;
$("#drillClose").onclick     = () => $("#drillPanel").classList.add("hidden");

// Confidence sliders
["confBefore","confAfter"].forEach(id => {
  $($("#" + id) && "#" + id) && null; // guard
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", updateConfDelta);
});
document.getElementById("confBefore")?.addEventListener("input", e => {
  $("#confBeforeVal").textContent = e.target.value + "%";
  updateConfDelta();
});
document.getElementById("confAfter")?.addEventListener("input", e => {
  $("#confAfterVal").textContent = e.target.value + "%";
  updateConfDelta();
});

// History search
$("#historySearch")?.addEventListener("input", e => renderHistory(e.target.value));

// ── Status + personas ─────────────────────────────────────────────────────────
async function loadStatus() {
  const s = await api("/api/status");
  $("#status").textContent = s.available ? `● ${s.provider}` : "○ set GROQ_API_KEY";

  const box = $("#personaPills");
  box.innerHTML = "";
  Object.entries(s.personas || {}).forEach(([key, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "persona-pill" + (key === currentPersona ? " active" : "");
    btn.textContent = label;
    btn.dataset.persona = key;
    btn.onclick = () => {
      currentPersona = key;
      document.querySelectorAll(".persona-pill").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
    };
    box.appendChild(btn);
  });
}

// ── Demos ─────────────────────────────────────────────────────────────────────
async function loadDemos() {
  const demos = await api("/api/demos");
  const box = $("#demos");
  demos.forEach(d => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "demo-btn";
    btn.textContent = d.question;
    btn.onclick = () => { $("#question").value = d.question; resetDebate(); };
    box.appendChild(btn);
  });
}

// ── History ───────────────────────────────────────────────────────────────────
function loadHistory() {
  try { history = JSON.parse(localStorage.getItem("adversary_history") || "[]"); }
  catch { history = []; }
  renderHistory();
}

function saveHistory() {
  localStorage.setItem("adversary_history", JSON.stringify(history.slice(0, 20)));
}

function addToHistory(debate) {
  history.unshift({ q: debate.question, ts: Date.now(), debate });
  saveHistory();
  renderHistory();
}

function renderHistory(filter = "") {
  const box = $("#historyList");
  const items = filter
    ? history.filter(h => h.q.toLowerCase().includes(filter.toLowerCase()))
    : history;

  if (!items.length) {
    box.innerHTML = `<div class="sidebar-empty">${filter ? "No matches." : "No debates yet."}</div>`;
    return;
  }
  box.innerHTML = items.map((h, i) => `
    <button type="button" class="history-item" data-idx="${history.indexOf(h)}">
      <div class="history-q">${esc(h.q)}</div>
      <div class="history-meta">${timeAgo(h.ts)}</div>
    </button>`).join("");
  box.querySelectorAll(".history-item").forEach(btn => {
    btn.onclick = () => {
      const h = history[+btn.dataset.idx];
      if (h?.debate) restoreDebate(h.debate);
    };
  });
}

function clearHistory() {
  history = [];
  saveHistory();
  renderHistory();
}

function restoreDebate(d) {
  $("#question").value = d.question;
  lastDebate = d;
  showDebateUI(d);
}

// ── Confidence calibration ────────────────────────────────────────────────────
function showConfidence() {
  $("#confidencePanel").classList.remove("hidden");
  document.getElementById("confBefore").value = 50;
  document.getElementById("confAfter").value  = 50;
  $("#confBeforeVal").textContent = "50%";
  $("#confAfterVal").textContent  = "50%";
  updateConfDelta();
}

function updateConfDelta() {
  const before = parseInt(document.getElementById("confBefore")?.value || 50);
  const after  = parseInt(document.getElementById("confAfter")?.value  || 50);
  const delta  = after - before;
  const el     = $("#confDelta");
  if (!el) return;
  if (Math.abs(delta) < 3) {
    el.className = "conf-delta unchanged";
    el.textContent = "The debate didn't shift your position.";
  } else if (delta > 0) {
    el.className = "conf-delta moved-for";
    el.textContent = `The debate moved you ${delta} points toward FOR.`;
  } else {
    el.className = "conf-delta moved-against";
    el.textContent = `The debate moved you ${Math.abs(delta)} points toward AGAINST.`;
  }
}

// ── Main debate ───────────────────────────────────────────────────────────────
function resetDebate() {
  ["debate","challengePanel","steelmanPanel","confidencePanel",
   "commonGroundPanel","followUpPanel","changeMindPanel","drillPanel","fallacyPanel"]
    .forEach(id => document.getElementById(id)?.classList.add("hidden"));
  $("#vstatus").textContent = "";
  lastDebate = null;
}

function setAnalysisButtons(enabled) {
  ["round2Btn","fallacyBtn","commonGroundBtn","followUpBtn","changeMindBtn"].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
  });
}

async function runDebate() {
  const question = $("#question").value.trim();
  if (!question) { $("#vstatus").textContent = "Enter a question first."; return; }

  resetDebate();
  $("#debate").classList.remove("hidden");
  $("#debateQ").textContent = question;

  ["thesisText","antithesisText","synthesisText","rebuttalForText","rebuttalAgainstText"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ""; });
  ["synthesisBlock","verdictBlock","round2Section","rebuttalVerdictBlock",
   "forClaims","againstClaims","fallacyPanel","drillPanel"]
    .forEach(id => document.getElementById(id)?.classList.add("hidden"));

  $("#thesisLoading").classList.remove("hidden");
  document.getElementById("antithesisLoading")?.classList.add("hidden");
  setAnalysisButtons(false);
  $("#debateBtn").disabled = true;
  $("#vstatus").textContent = "Building case for…";

  const state = { question, thesis: "", antithesis: "", synthesis: "", verdict: null };

  try {
    const resp = await fetch("/api/debate/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, persona: currentPersona }),
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const chunk of parts) {
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));

        if (ev.phase === "thesis") {
          $("#thesisLoading").classList.add("hidden");
          state.thesis += ev.delta;
          renderDebateText("thesisText", state.thesis, "for");

        } else if (ev.phase === "antithesis") {
          if (!state.antithesis) $("#vstatus").textContent = "Building case against…";
          state.antithesis += ev.delta;
          renderDebateText("antithesisText", state.antithesis, "against");

        } else if (ev.phase === "synthesis") {
          if (!state.synthesis) {
            $("#vstatus").textContent = "Synthesising…";
            $("#synthesisBlock").classList.remove("hidden");
          }
          state.synthesis += ev.delta;
          document.getElementById("synthesisText").textContent = state.synthesis;

        } else if (ev.phase === "claims") {
          showClaims("forClaims",     ev.for_claims     || []);
          showClaims("againstClaims", ev.against_claims || []);

        } else if (ev.phase === "verdict") {
          state.verdict = ev;
          showVerdict("verdictBlock","forBar","againstBar","forPct","againstPct","verdictText", ev);

        } else if (ev.phase === "done") {
          lastDebate = state;
          addToHistory(state);
          setAnalysisButtons(true);
          showConfidence();
          $("#vstatus").textContent = "Debate complete — explore below.";

        } else if (ev.phase === "error") {
          $("#vstatus").textContent = ev.error;
        }
      }
    }
  } catch { $("#vstatus").textContent = "Stream error — check your API key."; }

  $("#debateBtn").disabled = false;
}

// Render debate text as clickable paragraphs
function renderDebateText(elId, text, side) {
  const el = document.getElementById(elId);
  if (!el) return;
  const paras = text.split(/\n\n+/).filter(p => p.trim());
  if (paras.length <= 1) {
    el.textContent = text; // still streaming, show raw
    return;
  }
  el.innerHTML = paras.map(p =>
    `<p data-para="${esc(p)}">${esc(p)}</p>`
  ).join("");

  el.querySelectorAll("p").forEach(p => {
    p.addEventListener("click", e => {
      e.stopPropagation();
      showDrillMenu(e, p.dataset.para, side);
    });
  });
}

function showDebateUI(d) {
  $("#debate").classList.remove("hidden");
  $("#debateQ").textContent = d.question;
  renderDebateText("thesisText",    d.thesis,    "for");
  renderDebateText("antithesisText",d.antithesis,"against");
  document.getElementById("synthesisText").textContent = d.synthesis || "";
  if (d.synthesis) $("#synthesisBlock").classList.remove("hidden");
  if (d.verdict) showVerdict("verdictBlock","forBar","againstBar","forPct","againstPct","verdictText",d.verdict);
  setAnalysisButtons(true);
  showConfidence();
}

// ── Drill context menu ────────────────────────────────────────────────────────
function showDrillMenu(e, para, side) {
  closeDrillMenu();
  const menu = document.createElement("div");
  menu.className = "drill-menu";
  menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px`;
  const modes = [
    ["challenge", "⚡ Challenge this"],
    ["expand",    "＋ Expand with evidence"],
    ["falsify",   "✗ What would falsify this"],
  ];
  modes.forEach(([mode, label]) => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = label;
    btn.onclick = () => { closeDrillMenu(); runDrill(para, mode); };
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  drillMenu = menu;
}

function closeDrillMenu() {
  if (drillMenu) { drillMenu.remove(); drillMenu = null; }
}

async function runDrill(claim, mode) {
  const panel = $("#drillPanel");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const modeLabels = { challenge: "Challenge", expand: "Expand", falsify: "Falsify" };
  $("#drillMode").textContent = modeLabels[mode] || mode;
  $("#drillClaim").textContent = `"${claim.slice(0, 120)}${claim.length > 120 ? "…" : ""}"`;
  $("#drillText").textContent = "";
  $("#drillLoading").classList.remove("hidden");

  const context = lastDebate ? `${lastDebate.question}: ${lastDebate.thesis?.slice(0, 200)}` : "";

  try {
    const resp = await fetch("/api/drill/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim, context, mode }),
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const chunk of parts) {
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.phase === "drill") {
          $("#drillLoading").classList.add("hidden");
          text += ev.delta;
          $("#drillText").textContent = text;
        }
      }
    }
  } catch { $("#drillText").textContent = "Drill error."; }
  $("#drillLoading").classList.add("hidden");
}

// ── Round 2 ───────────────────────────────────────────────────────────────────
async function runRound2() {
  if (!lastDebate) return;
  const { question, thesis, antithesis } = lastDebate;

  $("#round2Section").classList.remove("hidden");
  document.getElementById("rebuttalForText").textContent = "";
  document.getElementById("rebuttalAgainstText").textContent = "";
  $("#rebuttalVerdictBlock").classList.add("hidden");
  $("#rebuttalForLoading").classList.remove("hidden");
  document.getElementById("rebuttalAgainstLoading").classList.add("hidden");
  $("#round2Btn").disabled = true;
  $("#vstatus").textContent = "Round 2: FOR rebuttal…";
  $("#round2Section").scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const resp = await fetch("/api/debate/rebuttal/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, thesis, antithesis }),
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", rbFor = "", rbAgainst = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const chunk of parts) {
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.phase === "rebuttal_for") {
          $("#rebuttalForLoading").classList.add("hidden");
          rbFor += ev.delta;
          renderDebateText("rebuttalForText", rbFor, "for");
        } else if (ev.phase === "rebuttal_against") {
          if (!rbAgainst) $("#vstatus").textContent = "Round 2: AGAINST counter…";
          document.getElementById("rebuttalAgainstLoading").classList.add("hidden");
          rbAgainst += ev.delta;
          renderDebateText("rebuttalAgainstText", rbAgainst, "against");
        } else if (ev.phase === "rebuttal_verdict") {
          showVerdict("rebuttalVerdictBlock","rb_forBar","rb_againstBar","rb_forPct","rb_againstPct","rb_verdictText", ev);
          $("#vstatus").textContent = "Round 2 complete.";
        }
      }
    }
  } catch { $("#vstatus").textContent = "Rebuttal stream error."; }
  $("#round2Btn").disabled = false;
}

// ── Analysis features ─────────────────────────────────────────────────────────
async function runCommonGround() {
  if (!lastDebate) return;
  $("#commonGroundBtn").disabled = true;
  $("#vstatus").textContent = "Finding common ground…";

  const res = await api("/api/common-ground", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thesis: lastDebate.thesis, antithesis: lastDebate.antithesis }),
  });
  $("#commonGroundBtn").disabled = false;
  $("#vstatus").textContent = "";
  if (res.error) { $("#vstatus").textContent = res.error; return; }

  const list = res.common_ground || [];
  $("#commonGroundList").innerHTML = list.map(item =>
    `<div class="analysis-item">${esc(item)}</div>`
  ).join("") || "<div class='analysis-item'>No clear common ground found.</div>";
  $("#commonGroundPanel").classList.remove("hidden");
  $("#commonGroundPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function runFollowUp() {
  if (!lastDebate) return;
  $("#followUpBtn").disabled = true;
  $("#vstatus").textContent = "Generating follow-up questions…";

  const res = await api("/api/follow-up", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: lastDebate.question,
      thesis: lastDebate.thesis,
      antithesis: lastDebate.antithesis,
    }),
  });
  $("#followUpBtn").disabled = false;
  $("#vstatus").textContent = "";
  if (res.error) { $("#vstatus").textContent = res.error; return; }

  const qs = res.questions || [];
  $("#followUpList").innerHTML = qs.map((q, i) =>
    `<div class="analysis-item question-item" data-q="${esc(q)}">${i + 1}. ${esc(q)}</div>`
  ).join("");
  // Click to search Wikipedia
  $("#followUpList").querySelectorAll(".question-item").forEach(el => {
    el.onclick = () => {
      const url = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(el.dataset.q)}`;
      window.open(url, "_blank", "noopener");
    };
  });
  $("#followUpPanel").classList.remove("hidden");
  $("#followUpPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function runChangeMind() {
  if (!lastDebate) return;
  $("#changeMindBtn").disabled = true;
  $("#vstatus").textContent = "Finding what would change each side's mind…";

  const res = await api("/api/change-mind", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: lastDebate.question,
      thesis: lastDebate.thesis,
      antithesis: lastDebate.antithesis,
    }),
  });
  $("#changeMindBtn").disabled = false;
  $("#vstatus").textContent = "";
  if (res.error) { $("#vstatus").textContent = res.error; return; }

  const makeList = items => (items || []).map(item =>
    `<div class="analysis-item">${esc(item)}</div>`
  ).join("") || "<div class='analysis-item'>—</div>";

  $("#forUpdateList").innerHTML     = makeList(res.for_would_update);
  $("#againstUpdateList").innerHTML = makeList(res.against_would_update);
  $("#changeMindPanel").classList.remove("hidden");
  $("#changeMindPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Fallacies ─────────────────────────────────────────────────────────────────
async function runFallacies() {
  if (!lastDebate) return;
  $("#fallacyBtn").disabled = true;
  $("#vstatus").textContent = "Scanning for logical fallacies…";

  const res = await api("/api/fallacies", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thesis: lastDebate.thesis, antithesis: lastDebate.antithesis }),
  });
  $("#fallacyBtn").disabled = false;
  if (res.error) { $("#vstatus").textContent = res.error; return; }
  $("#vstatus").textContent = "";

  renderFallacies("forFallacies",     res.for_fallacies     || []);
  renderFallacies("againstFallacies", res.against_fallacies || []);
  $("#fallacyPanel").classList.remove("hidden");
  $("#fallacyPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderFallacies(elId, list) {
  document.getElementById(elId).innerHTML = list.length
    ? list.map(f => `<div class="fallacy-item">
        <div class="fallacy-name">${esc(f.name)}</div>
        <div class="fallacy-quote">"${esc(f.quote || "")}"</div>
        <div class="fallacy-explain">${esc(f.explanation || "")}</div>
      </div>`).join("")
    : '<div class="no-fallacies">No clear fallacies detected.</div>';
}

// ── Challenge / Steelman ──────────────────────────────────────────────────────
async function runChallenge() {
  const view = $("#question").value.trim();
  if (!view) { $("#vstatus").textContent = "State your view in the box first."; return; }
  $("#challengePanel").classList.remove("hidden");
  $("#steelmanPanel").classList.add("hidden");
  $("#challengeText").textContent = "Loading…";
  $("#challengeBtn").disabled = true;

  const res = await api("/api/challenge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view }),
  });
  $("#challengeBtn").disabled = false;
  if (res.error) { $("#vstatus").textContent = res.error; return; }
  $("#challengeText").textContent = res.challenge;
}

async function runSteelman() {
  const position = $("#question").value.trim();
  if (!position) { $("#vstatus").textContent = "Enter a position to steelman."; return; }
  $("#steelmanPanel").classList.remove("hidden");
  $("#challengePanel").classList.add("hidden");
  $("#steelmanText").textContent = "";
  $("#steelmanBtn").disabled = true;
  $("#vstatus").textContent = "Building the steelman…";

  try {
    const resp = await fetch("/api/steelman/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position }),
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const chunk of parts) {
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.phase === "steelman") { text += ev.delta; $("#steelmanText").textContent = text; }
      }
    }
  } catch { $("#vstatus").textContent = "Steelman stream error."; }
  $("#steelmanBtn").disabled = false;
  $("#vstatus").textContent = "";
}

// ── Share ─────────────────────────────────────────────────────────────────────
async function shareDebate() {
  const question = lastDebate?.question || $("#question").value.trim();
  if (!question) { $("#vstatus").textContent = "Nothing to share yet."; return; }
  const url = `${location.origin}${location.pathname}?q=${encodeURIComponent(question)}`;
  try {
    await navigator.clipboard.writeText(url);
    $("#vstatus").textContent = "Share link copied — opens with this question pre-loaded.";
  } catch { $("#vstatus").textContent = url; }
}

// Load ?q= from URL on boot
(function loadQueryParam() {
  const params = new URLSearchParams(location.search);
  const q = params.get("q");
  if (q) { $("#question").value = q; }
})();

// ── Export ─────────────────────────────────────────────────────────────────────
function copyTranscript() {
  if (!lastDebate) return;
  navigator.clipboard.writeText(format(lastDebate, false))
    .then(() => { $("#vstatus").textContent = "Copied."; })
    .catch(() => { $("#vstatus").textContent = "Clipboard unavailable."; });
}

function exportMd() {
  if (!lastDebate) return;
  const blob = new Blob([format(lastDebate, true)], { type: "text/markdown" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `adversary-${Date.now()}.md`,
  });
  a.click(); URL.revokeObjectURL(a.href);
}

function format(d, md) {
  const fp = d.verdict ? Math.round(d.verdict.for_score * 100) + "%" : "—";
  const ap = d.verdict ? Math.round(d.verdict.against_score * 100) + "%" : "—";
  if (md) return [
    `# Adversary: ${d.question}`, "",
    `## Case for`, d.thesis, "",
    `## Case against`, d.antithesis, "",
    `## Honest assessment`, d.synthesis || "", "",
    `## Verdict`, `For: ${fp} / Against: ${ap}`, d.verdict?.verdict || "",
  ].join("\n");
  return [
    `QUESTION: ${d.question}`, "",
    `CASE FOR\n${d.thesis}`, "",
    `CASE AGAINST\n${d.antithesis}`, "",
    `HONEST ASSESSMENT\n${d.synthesis || ""}`, "",
    `VERDICT (For ${fp} / Against ${ap})\n${d.verdict?.verdict || ""}`,
  ].join("\n");
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function showClaims(elId, claims) {
  const el = document.getElementById(elId);
  if (!claims.length || !el) return;
  el.innerHTML = claims.map(c => `<div class="claim-pill">${esc(c)}</div>`).join("");
  el.classList.remove("hidden");
}

function showVerdict(blockId, forBarId, againstBarId, forPctId, againstPctId, textId, ev) {
  document.getElementById(blockId)?.classList.remove("hidden");
  const fp = Math.round((ev.for_score || 0.5) * 100);
  const ap = Math.round((ev.against_score || 0.5) * 100);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fb = document.getElementById(forBarId);
    const ab = document.getElementById(againstBarId);
    if (fb) fb.style.width = fp + "%";
    if (ab) ab.style.width = ap + "%";
  }));
  const fpEl = document.getElementById(forPctId);
  const apEl = document.getElementById(againstPctId);
  const tEl  = document.getElementById(textId);
  if (fpEl) fpEl.textContent = fp + "%";
  if (apEl) apEl.textContent = ap + "%";
  if (tEl)  tEl.textContent  = ev.verdict || "";
}

function clearAll() {
  $("#question").value = "";
  resetDebate();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
