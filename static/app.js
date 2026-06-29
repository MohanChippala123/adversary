// Adversary — front end

const $ = s => document.querySelector(s);
const api = (p, o) => fetch(p, o).then(r => r.json());

// ── State ─────────────────────────────────────────────────────────────────────
let currentPersona = "auto";
let lastDebate = null;          // { question, thesis, antithesis, synthesis, verdict }
let history = [];               // persisted in localStorage

// ── Boot ──────────────────────────────────────────────────────────────────────
loadStatus();
loadDemos();
loadHistory();

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runDebate(); }
});
$("#debateBtn").onclick   = runDebate;
$("#challengeBtn").onclick = runChallenge;
$("#steelmanBtn").onclick  = runSteelman;
$("#clearBtn").onclick     = clearAll;
$("#round2Btn").onclick    = runRound2;
$("#fallacyBtn").onclick   = runFallacies;
$("#copyBtn").onclick      = copyTranscript;
$("#mdBtn").onclick        = exportMd;
$("#clearHistoryBtn").onclick = clearHistory;

// ── Status ────────────────────────────────────────────────────────────────────
async function loadStatus() {
  const s = await api("/api/status");
  $("#status").textContent = s.available
    ? `● ${s.provider}`
    : "○ no llm — set GROQ_API_KEY";

  // Build persona pills
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

function renderHistory() {
  const box = $("#historyList");
  if (!history.length) {
    box.innerHTML = '<div class="sidebar-empty">No debates yet.</div>';
    return;
  }
  box.innerHTML = history.map((h, i) => `
    <button type="button" class="history-item" data-idx="${i}">
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

// ── Main debate ───────────────────────────────────────────────────────────────
function resetDebate() {
  $("#debate").classList.add("hidden");
  $("#challengePanel").classList.add("hidden");
  $("#steelmanPanel").classList.add("hidden");
  $("#vstatus").textContent = "";
  lastDebate = null;
}

async function runDebate() {
  const question = $("#question").value.trim();
  if (!question) { $("#vstatus").textContent = "Enter a question first."; return; }

  resetDebate();
  $("#debate").classList.remove("hidden");
  $("#debateQ").textContent = question;

  // Reset all panels
  ["thesisText","antithesisText","synthesisText","rebuttalForText","rebuttalAgainstText"].forEach(id => {
    const el = $("#" + id); if (el) el.textContent = "";
  });
  ["synthesisBlock","verdictBlock","round2Section","rebuttalVerdictBlock","fallacyPanel","forClaims","againstClaims"].forEach(id => {
    const el = $("#" + id); if (el) el.classList.add("hidden");
  });
  $("#thesisLoading").classList.remove("hidden");
  $("#antithesisLoading").classList.add("hidden");
  $("#round2Btn").disabled = true;
  $("#fallacyBtn").disabled = true;
  $("#debateBtn").disabled = true;
  $("#vstatus").textContent = "Building case for…";

  const state = { question, thesis: "", antithesis: "", synthesis: "", verdict: null };

  try {
    const resp = await fetch("/api/debate/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
          $("#thesisText").textContent = state.thesis;

        } else if (ev.phase === "antithesis") {
          if (!state.antithesis) $("#vstatus").textContent = "Building case against…";
          state.antithesis += ev.delta;
          $("#antithesisText").textContent = state.antithesis;

        } else if (ev.phase === "synthesis") {
          if (!state.synthesis) {
            $("#vstatus").textContent = "Synthesising…";
            $("#synthesisBlock").classList.remove("hidden");
          }
          state.synthesis += ev.delta;
          $("#synthesisText").textContent = state.synthesis;

        } else if (ev.phase === "claims") {
          showClaims("forClaims", ev.for_claims || []);
          showClaims("againstClaims", ev.against_claims || []);

        } else if (ev.phase === "verdict") {
          state.verdict = ev;
          showVerdict("verdictBlock","forBar","againstBar","forPct","againstPct","verdictText", ev);

        } else if (ev.phase === "done") {
          $("#vstatus").textContent = "Debate complete.";
          lastDebate = state;
          addToHistory(state);
          $("#round2Btn").disabled = false;
          $("#fallacyBtn").disabled = false;

        } else if (ev.phase === "error") {
          $("#vstatus").textContent = ev.error;
        }
      }
    }
  } catch {
    $("#vstatus").textContent = "Stream error — check your LLM key and try again.";
  }

  $("#debateBtn").disabled = false;
}

function showDebateUI(d) {
  $("#debate").classList.remove("hidden");
  $("#debateQ").textContent = d.question;
  $("#thesisText").textContent = d.thesis;
  $("#antithesisText").textContent = d.antithesis;
  $("#synthesisText").textContent = d.synthesis;
  $("#thesisLoading").classList.add("hidden");
  if (d.synthesis) $("#synthesisBlock").classList.remove("hidden");
  if (d.verdict) {
    showVerdict("verdictBlock","forBar","againstBar","forPct","againstPct","verdictText", d.verdict);
  }
  $("#round2Btn").disabled = false;
  $("#fallacyBtn").disabled = false;
}

function showClaims(elId, claims) {
  const el = $("#" + elId);
  if (!claims.length) return;
  el.innerHTML = claims.map(c => `<div class="claim-pill">${esc(c)}</div>`).join("");
  el.classList.remove("hidden");
}

function showVerdict(blockId, forBarId, againstBarId, forPctId, againstPctId, textId, ev) {
  const block = $("#" + blockId);
  block.classList.remove("hidden");
  const fp = Math.round((ev.for_score || 0.5) * 100);
  const ap = Math.round((ev.against_score || 0.5) * 100);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $("#" + forBarId).style.width = fp + "%";
    $("#" + againstBarId).style.width = ap + "%";
  }));
  $("#" + forPctId).textContent = fp + "%";
  $("#" + againstPctId).textContent = ap + "%";
  $("#" + textId).textContent = ev.verdict || "";
}

// ── Round 2 ───────────────────────────────────────────────────────────────────
async function runRound2() {
  if (!lastDebate) return;
  const { question, thesis, antithesis } = lastDebate;

  $("#round2Section").classList.remove("hidden");
  $("#rebuttalForText").textContent = "";
  $("#rebuttalAgainstText").textContent = "";
  $("#rebuttalVerdictBlock").classList.add("hidden");
  $("#rebuttalForLoading").classList.remove("hidden");
  $("#rebuttalAgainstLoading").classList.add("hidden");
  $("#round2Btn").disabled = true;
  $("#vstatus").textContent = "Round 2: FOR rebuttal…";

  // Scroll to round 2
  $("#round2Section").scrollIntoView({ behavior: "smooth", block: "start" });

  const state = { rb_for: "", rb_against: "" };

  try {
    const resp = await fetch("/api/debate/rebuttal/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, thesis, antithesis }),
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

        if (ev.phase === "rebuttal_for") {
          $("#rebuttalForLoading").classList.add("hidden");
          state.rb_for += ev.delta;
          $("#rebuttalForText").textContent = state.rb_for;

        } else if (ev.phase === "rebuttal_against") {
          if (!state.rb_against) {
            $("#vstatus").textContent = "Round 2: AGAINST counter…";
            $("#rebuttalAgainstLoading").classList.remove("hidden");
          }
          $("#rebuttalAgainstLoading").classList.add("hidden");
          state.rb_against += ev.delta;
          $("#rebuttalAgainstText").textContent = state.rb_against;

        } else if (ev.phase === "rebuttal_verdict") {
          showVerdict("rebuttalVerdictBlock","rb_forBar","rb_againstBar","rb_forPct","rb_againstPct","rb_verdictText", ev);
          $("#vstatus").textContent = "Round 2 complete.";

        } else if (ev.phase === "done") {
          // nothing extra

        } else if (ev.phase === "error") {
          $("#vstatus").textContent = ev.error;
        }
      }
    }
  } catch {
    $("#vstatus").textContent = "Rebuttal stream error.";
  }

  $("#round2Btn").disabled = false;
}

// ── Fallacy scanner ────────────────────────────────────────────────────────────
async function runFallacies() {
  if (!lastDebate) return;
  $("#fallacyBtn").disabled = true;
  $("#vstatus").textContent = "Scanning for logical fallacies…";

  const res = await api("/api/fallacies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thesis: lastDebate.thesis, antithesis: lastDebate.antithesis }),
  });

  $("#fallacyBtn").disabled = false;
  if (res.error) { $("#vstatus").textContent = res.error; return; }

  renderFallacies("forFallacies",     res.for_fallacies     || []);
  renderFallacies("againstFallacies", res.against_fallacies || []);
  $("#fallacyPanel").classList.remove("hidden");
  $("#fallacyPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#vstatus").textContent = "";
}

function renderFallacies(elId, list) {
  const el = $("#" + elId);
  if (!list.length) {
    el.innerHTML = '<div class="no-fallacies">No clear fallacies detected.</div>';
    return;
  }
  el.innerHTML = list.map(f => `
    <div class="fallacy-item">
      <div class="fallacy-name">${esc(f.name)}</div>
      <div class="fallacy-quote">"${esc(f.quote || "")}"</div>
      <div class="fallacy-explain">${esc(f.explanation || "")}</div>
    </div>`).join("");
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
    href: URL.createObjectURL(blob), download: `adversary-${Date.now()}.md`,
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
    `## Verdict`, `For: ${fp} / Against: ${ap}`,
    d.verdict?.verdict || "",
  ].join("\n");
  return [
    `QUESTION: ${d.question}`, "",
    `CASE FOR\n${d.thesis}`, "",
    `CASE AGAINST\n${d.antithesis}`, "",
    `HONEST ASSESSMENT\n${d.synthesis || ""}`, "",
    `VERDICT (For ${fp} / Against ${ap})\n${d.verdict?.verdict || ""}`,
  ].join("\n");
}

// ── Utils ──────────────────────────────────────────────────────────────────────
function clearAll() {
  $("#question").value = ""; resetDebate();
  $("#challengePanel").classList.add("hidden");
  $("#steelmanPanel").classList.add("hidden");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
