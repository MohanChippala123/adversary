"""
Adversary — Flask backend.

Every AI answer is a prosecution that was never cross-examined.
Adversary applies the adversarial principle to every question: generate
the strongest case FOR, the strongest case AGAINST, and an honest synthesis
that neither side alone could produce.

Run:
    pip install -r requirements.txt
    GROQ_API_KEY=... python app.py   →  http://127.0.0.1:5080
"""

from __future__ import annotations

import json

from flask import Flask, Response, jsonify, request, send_from_directory

import llm

app = Flask(__name__, static_folder="static", static_url_path="")

DEMOS = [
    {"id": "ai_jobs",    "question": "Will AI replace most programmers within 10 years?"},
    {"id": "remote",     "question": "Is remote work better for productivity than in-office?"},
    {"id": "aspirin",    "question": "Should healthy adults take a daily low-dose aspirin?"},
    {"id": "capitalism", "question": "Is capitalism the best economic system humanity has developed?"},
    {"id": "social",     "question": "Is social media net harmful to teenagers?"},
    {"id": "nuclear",    "question": "Should nuclear power be a cornerstone of climate strategy?"},
]


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/status")
def status():
    return jsonify({
        "provider": llm.provider_name(),
        "available": llm.available(),
    })


@app.get("/api/demos")
def demos():
    return jsonify(DEMOS)


@app.post("/api/debate/stream")
def debate_stream():
    """SSE stream that emits the full debate in 4 phases.

    Events:
      {phase:"thesis",    delta:"<text chunk>"}
      {phase:"antithesis",delta:"<text chunk>"}
      {phase:"synthesis", delta:"<text chunk>"}
      {phase:"verdict",   for_score:N, against_score:N, verdict:"..."}
      {phase:"done"}
      {phase:"error",     error:"..."}
    """
    data = request.get_json(force=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        def _err():
            yield "data: " + json.dumps({"phase": "error", "error": "No question provided."}) + "\n\n"
        return Response(_err(), mimetype="text/event-stream")

    if not llm.available():
        def _no_llm():
            yield "data: " + json.dumps({
                "phase": "error",
                "error": "No LLM configured. Set GROQ_API_KEY, ANTHROPIC_API_KEY, or ENABLE_LOCAL_LLM=1."
            }) + "\n\n"
        return Response(_no_llm(), mimetype="text/event-stream")

    def _generate():
        thesis = []
        antithesis = []
        synthesis = []

        # Phase 1: Thesis
        for chunk in llm.stream_thesis(question):
            thesis.append(chunk)
            yield "data: " + json.dumps({"phase": "thesis", "delta": chunk}) + "\n\n"

        thesis_text = "".join(thesis)

        # Phase 2: Antithesis
        for chunk in llm.stream_antithesis(question, thesis_text):
            antithesis.append(chunk)
            yield "data: " + json.dumps({"phase": "antithesis", "delta": chunk}) + "\n\n"

        antithesis_text = "".join(antithesis)

        # Phase 3: Synthesis
        for chunk in llm.stream_synthesis(question, thesis_text, antithesis_text):
            synthesis.append(chunk)
            yield "data: " + json.dumps({"phase": "synthesis", "delta": chunk}) + "\n\n"

        # Phase 4: Verdict (not streamed — one JSON object)
        verdict = llm.get_verdict(question, thesis_text, antithesis_text)
        yield "data: " + json.dumps({"phase": "verdict", **verdict}) + "\n\n"

        yield "data: " + json.dumps({"phase": "done"}) + "\n\n"

    return Response(
        _generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/challenge")
def challenge():
    """Non-streaming: given a user's stated view, return the strongest counterargument."""
    data = request.get_json(force=True) or {}
    view = (data.get("view") or "").strip()
    if not view:
        return jsonify({"error": "No view provided."}), 400
    if not llm.available():
        return jsonify({"error": "No LLM configured."}), 503

    chunks = list(llm._stream(
        "You are the most rigorous devil's advocate. The user has stated a belief. "
        "Give the single strongest argument that should make them reconsider. "
        "Be specific. Challenge a core premise, not a peripheral point. "
        "3 paragraphs maximum. Do not soften the challenge.",
        f"My view: {view}\n\nGive me the strongest case against this.",
    ))
    return jsonify({"challenge": "".join(chunks)})


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "5080"))
    debug = os.environ.get("FLASK_DEBUG", "") in ("1", "true", "True")
    app.run(host="0.0.0.0", port=port, debug=debug)
