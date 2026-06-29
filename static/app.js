// Adversary — front end

const $ = s => document.querySelector(s);
const api = (p, o) => fetch(p, o).then(r => r.json());

let lastDebate = null;

// ── Status ────────────────────────────────────────────────────────────────────

async function loadStatus() {
  const s = await api("/api/status");
  const on = s.available;
  $("#status").textContent = on
    ? `provider: ${s.provider}`
    : "no llm — set GROQ_API_KEY or ANTHROPIC_API_KEY";
}

// ── Demos ─────────────────────────────────────────────────────────────────────

async function loadDemos() {
  const demos = await api("/api/demos");
  const box = $("#demos");
  demos.forEach(d => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "demo-btn";
    btn.textContent = d.question;
    btn.onclick = () => {
      $("#question").value = d.question;
      resetDebate();
    };
    box.appendChild(btn);
  });
}

// ── Debate ────────────────────────────────────────────────────────────────────

function resetDebate() {
  $("#debate").classList.add("hidden");
  $("#challengePanel").classList.add("hidden");
  $("#vstatus").textContent = "";
  lastDebate = null;
}

async function runDebate() {
  const question = $("#question").value.trim();
  if (!question) { $("#vstatus").textContent = "Enter a question first."; return; }

  // Setup UI
  $("#debate").classList.remove("hidden");
  $("#debateQ").textContent = question;
  $("#synthesisBlock").classList.add("hidden");
  $("#verdictBlock").classList.add("hidden");
  $("#challengePanel").classList.add("hidden");
  $("#thesisText").textContent = "";
  $("#antithesisText").textContent = "";
  $("#synthesisText").textContent = "";
  $("#thesisLoading").classList.remove("hidden");
  $("#antithesisLoading").classList.add("hidden");
  $("#debateBtn").disabled = true;
  $("#challengeBtn").disabled = true;
  $("#vstatus").textContent = "Building case for…";

  const state = { thesis: "", antithesis: "", synthesis: "" };

  try {
    const resp = await fetch("/api/debate/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();

      for (const chunk of parts) {
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));

        if (ev.phase === "thesis") {
          $("#thesisLoading").classList.add("hidden");
          state.thesis += ev.delta;
          $("#thesisText").textContent = state.thesis;

        } else if (ev.phase === "antithesis") {
          if (!$("#antithesisLoading").classList.contains("hidden")) {
            // first antithesis chunk — show its loading dots briefly had already been shown
          }
          if (state.antithesis === "") {
            $("#vstatus").textContent = "Building case against…";
            // Show antithesis loading briefly then hide on first text
          }
          state.antithesis += ev.delta;
          $("#antithesisText").textContent = state.antithesis;

        } else if (ev.phase === "synthesis") {
          if (state.synthesis === "") {
            $("#vstatus").textContent = "Synthesising…";
            $("#synthesisBlock").classList.remove("hidden");
          }
          state.synthesis += ev.delta;
          $("#synthesisText").textContent = state.synthesis;

        } else if (ev.phase === "verdict") {
          showVerdict(ev);
          lastDebate = { question, ...state, verdict: ev };

        } else if (ev.phase === "done") {
          $("#vstatus").textContent = "Debate complete.";

        } else if (ev.phase === "error") {
          $("#vstatus").textContent = ev.error;
        }
      }
    }
  } catch (e) {
    $("#vstatus").textContent = "Stream error — try again.";
  }

  $("#debateBtn").disabled = false;
  $("#challengeBtn").disabled = false;
}

function showVerdict(ev) {
  $("#verdictBlock").classList.remove("hidden");
  const fp = Math.round((ev.for_score || 0.5) * 100);
  const ap = Math.round((ev.against_score || 0.5) * 100);
  // Animate bars after a tick so the transition fires
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      $("#forBar").style.width = fp + "%";
      $("#againstBar").style.width = ap + "%";
    });
  });
  $("#forPct").textContent = fp + "%";
  $("#againstPct").textContent = ap + "%";
  $("#verdictText").textContent = ev.verdict || "";
}

// ── Challenge my view ─────────────────────────────────────────────────────────

async function challengeView() {
  const view = $("#question").value.trim();
  if (!view) { $("#vstatus").textContent = "State your view in the box first."; return; }

  $("#challengeBtn").disabled = true;
  $("#vstatus").textContent = "Finding the strongest counterargument…";
  $("#challengePanel").classList.remove("hidden");
  $("#challengeText").textContent = "";

  const res = await api("/api/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view }),
  });

  $("#challengeBtn").disabled = false;
  $("#vstatus").textContent = "";

  if (res.error) { $("#vstatus").textContent = res.error; return; }
  $("#challengeText").textContent = res.challenge;
}

// ── Export ────────────────────────────────────────────────────────────────────

function copyTranscript() {
  if (!lastDebate) return;
  const text = formatTranscript(lastDebate);
  navigator.clipboard.writeText(text)
    .then(() => { $("#vstatus").textContent = "Copied."; })
    .catch(() => { $("#vstatus").textContent = "Clipboard unavailable."; });
}

function exportMd() {
  if (!lastDebate) return;
  const md = formatTranscript(lastDebate, true);
  const blob = new Blob([md], { type: "text/markdown" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `adversary-${Date.now()}.md`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function formatTranscript(d, markdown = false) {
  if (markdown) {
    return [
      `# Adversary debate`,
      `**Question:** ${d.question}`,
      ``,
      `## Case for`,
      d.thesis,
      ``,
      `## Case against`,
      d.antithesis,
      ``,
      `## Honest assessment`,
      d.synthesis,
      ``,
      `## Verdict`,
      d.verdict ? `For: ${Math.round(d.verdict.for_score * 100)}% / Against: ${Math.round(d.verdict.against_score * 100)}%` : "",
      d.verdict?.verdict || "",
    ].join("\n");
  }
  return [
    `QUESTION: ${d.question}`,
    ``,
    `CASE FOR\n${d.thesis}`,
    ``,
    `CASE AGAINST\n${d.antithesis}`,
    ``,
    `HONEST ASSESSMENT\n${d.synthesis}`,
    ``,
    d.verdict ? `VERDICT (${Math.round(d.verdict.for_score * 100)}% for / ${Math.round(d.verdict.against_score * 100)}% against)\n${d.verdict.verdict}` : "",
  ].join("\n");
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runDebate();
  }
});

$("#debateBtn").onclick = runDebate;
$("#challengeBtn").onclick = challengeView;
$("#clearBtn").onclick = () => { $("#question").value = ""; resetDebate(); };
$("#copyBtn").onclick = copyTranscript;
$("#mdBtn").onclick = exportMd;

loadStatus();
loadDemos();
