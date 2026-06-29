"""
Adversary — Flask backend.

Run:
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
    {"id": "ubi",        "question": "Should governments implement a universal basic income?"},
    {"id": "grades",     "question": "Should schools abolish grades and standardised testing?"},
]


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/status")
def status():
    return jsonify({
        "provider":  llm.provider_name(),
        "available": llm.available(),
        "personas":  {k: v["label"] for k, v in llm.PERSONAS.items()},
    })


@app.get("/api/demos")
def demos():
    return jsonify(DEMOS)


# ── Main debate stream ────────────────────────────────────────────────────────

@app.post("/api/debate/stream")
def debate_stream():
    """SSE: thesis → antithesis → synthesis → key claims → verdict.

    Events:
      {phase:"thesis",    delta:"<chunk>"}
      {phase:"antithesis",delta:"<chunk>"}
      {phase:"synthesis", delta:"<chunk>"}
      {phase:"claims",    for_claims:[...], against_claims:[...]}
      {phase:"verdict",   for_score:N, against_score:N, verdict:"..."}
      {phase:"done"}
      {phase:"error",     error:"..."}
    """
    data = request.get_json(force=True) or {}
    question = (data.get("question") or "").strip()
    persona  = (data.get("persona")  or "auto").strip()
    if persona not in llm.PERSONAS:
        persona = "auto"

    if not question:
        def _err():
            yield "data: " + json.dumps({"phase": "error", "error": "No question."}) + "\n\n"
        return Response(_err(), mimetype="text/event-stream")

    if not llm.available():
        def _no_llm():
            yield "data: " + json.dumps({
                "phase": "error",
                "error": "No LLM configured. Set GROQ_API_KEY or ANTHROPIC_API_KEY.",
            }) + "\n\n"
        return Response(_no_llm(), mimetype="text/event-stream")

    def _generate():
        thesis, antithesis, synthesis = [], [], []

        for chunk in llm.stream_thesis(question, persona):
            thesis.append(chunk)
            yield "data: " + json.dumps({"phase": "thesis", "delta": chunk}) + "\n\n"
        thesis_text = "".join(thesis)

        for chunk in llm.stream_antithesis(question, thesis_text, persona):
            antithesis.append(chunk)
            yield "data: " + json.dumps({"phase": "antithesis", "delta": chunk}) + "\n\n"
        antithesis_text = "".join(antithesis)

        for chunk in llm.stream_synthesis(question, thesis_text, antithesis_text):
            synthesis.append(chunk)
            yield "data: " + json.dumps({"phase": "synthesis", "delta": chunk}) + "\n\n"

        # Key claims for both sides (parallel extraction)
        for_claims     = llm.get_key_claims(thesis_text)
        against_claims = llm.get_key_claims(antithesis_text)
        yield "data: " + json.dumps({
            "phase": "claims",
            "for_claims": for_claims,
            "against_claims": against_claims,
        }) + "\n\n"

        verdict = llm.get_verdict(question, thesis_text, antithesis_text)
        yield "data: " + json.dumps({"phase": "verdict", **verdict}) + "\n\n"
        yield "data: " + json.dumps({"phase": "done"}) + "\n\n"

    return Response(_generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Round 2: rebuttal ─────────────────────────────────────────────────────────

@app.post("/api/debate/rebuttal/stream")
def rebuttal_stream():
    """SSE: FOR rebuttal → AGAINST counter-rebuttal → updated verdict."""
    data = request.get_json(force=True) or {}
    question   = (data.get("question")   or "").strip()
    thesis     = (data.get("thesis")     or "").strip()
    antithesis = (data.get("antithesis") or "").strip()

    if not (question and thesis and antithesis):
        def _err():
            yield "data: " + json.dumps({"phase": "error", "error": "Missing debate content."}) + "\n\n"
        return Response(_err(), mimetype="text/event-stream")

    def _generate():
        rb_for, rb_against = [], []

        for chunk in llm.stream_rebuttal_for(question, thesis, antithesis):
            rb_for.append(chunk)
            yield "data: " + json.dumps({"phase": "rebuttal_for", "delta": chunk}) + "\n\n"
        rb_for_text = "".join(rb_for)

        for chunk in llm.stream_rebuttal_against(question, thesis, antithesis, rb_for_text):
            rb_against.append(chunk)
            yield "data: " + json.dumps({"phase": "rebuttal_against", "delta": chunk}) + "\n\n"
        rb_against_text = "".join(rb_against)

        verdict = llm.get_verdict(question, rb_for_text, rb_against_text)
        verdict["phase"] = "rebuttal_verdict"
        yield "data: " + json.dumps(verdict) + "\n\n"
        yield "data: " + json.dumps({"phase": "done"}) + "\n\n"

    return Response(_generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Fallacy scanner ───────────────────────────────────────────────────────────

@app.post("/api/fallacies")
def fallacies():
    data = request.get_json(force=True) or {}
    thesis     = (data.get("thesis")     or "").strip()
    antithesis = (data.get("antithesis") or "").strip()
    if not (thesis and antithesis):
        return jsonify({"error": "Need both sides to scan."}), 400
    if not llm.available():
        return jsonify({"error": "No LLM configured."}), 503
    return jsonify(llm.get_fallacies(thesis, antithesis))


# ── Steelman ──────────────────────────────────────────────────────────────────

@app.post("/api/steelman/stream")
def steelman_stream():
    """SSE: generate the strongest version of a position you disagree with."""
    data = request.get_json(force=True) or {}
    position = (data.get("position") or "").strip()
    if not position:
        def _err():
            yield "data: " + json.dumps({"phase": "error", "error": "No position."}) + "\n\n"
        return Response(_err(), mimetype="text/event-stream")

    def _gen():
        for chunk in llm.stream_steelman(position):
            yield "data: " + json.dumps({"phase": "steelman", "delta": chunk}) + "\n\n"
        yield "data: " + json.dumps({"phase": "done"}) + "\n\n"

    return Response(_gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── New analysis endpoints ────────────────────────────────────────────────────

@app.post("/api/common-ground")
def common_ground():
    data = request.get_json(force=True) or {}
    thesis     = (data.get("thesis")     or "").strip()
    antithesis = (data.get("antithesis") or "").strip()
    if not (thesis and antithesis):
        return jsonify({"error": "Need both sides."}), 400
    if not llm.available():
        return jsonify({"error": "No LLM configured."}), 503
    return jsonify({"common_ground": llm.get_common_ground(thesis, antithesis)})


@app.post("/api/follow-up")
def follow_up():
    data = request.get_json(force=True) or {}
    question   = (data.get("question")   or "").strip()
    thesis     = (data.get("thesis")     or "").strip()
    antithesis = (data.get("antithesis") or "").strip()
    if not (question and thesis and antithesis):
        return jsonify({"error": "Need question and both sides."}), 400
    if not llm.available():
        return jsonify({"error": "No LLM configured."}), 503
    return jsonify({"questions": llm.get_follow_up(question, thesis, antithesis)})


@app.post("/api/change-mind")
def change_mind():
    data = request.get_json(force=True) or {}
    question   = (data.get("question")   or "").strip()
    thesis     = (data.get("thesis")     or "").strip()
    antithesis = (data.get("antithesis") or "").strip()
    if not (question and thesis and antithesis):
        return jsonify({"error": "Need question and both sides."}), 400
    if not llm.available():
        return jsonify({"error": "No LLM configured."}), 503
    return jsonify(llm.get_change_mind(question, thesis, antithesis))


@app.post("/api/conviction")
def conviction():
    data = request.get_json(force=True) or {}
    thesis     = (data.get("thesis")     or "").strip()
    antithesis = (data.get("antithesis") or "").strip()
    if not (thesis and antithesis):
        return jsonify({"error": "Need both sides."}), 400
    if not llm.available():
        return jsonify({"error": "No LLM configured."}), 503
    return jsonify(llm.get_conviction(thesis, antithesis))


@app.post("/api/drill/stream")
def drill_stream():
    """SSE: deep-dive on a specific paragraph. mode: challenge|expand|falsify."""
    data = request.get_json(force=True) or {}
    claim   = (data.get("claim")   or "").strip()
    context = (data.get("context") or "").strip()
    mode    = (data.get("mode")    or "challenge").strip()
    if not claim:
        def _err():
            yield "data: " + json.dumps({"phase": "error", "error": "No claim."}) + "\n\n"
        return Response(_err(), mimetype="text/event-stream")

    def _gen():
        for chunk in llm.stream_drill(claim, context, mode):
            yield "data: " + json.dumps({"phase": "drill", "delta": chunk}) + "\n\n"
        yield "data: " + json.dumps({"phase": "done"}) + "\n\n"

    return Response(_gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Challenge my view (non-streaming) ────────────────────────────────────────

@app.post("/api/challenge")
def challenge():
    data = request.get_json(force=True) or {}
    view = (data.get("view") or "").strip()
    if not view:
        return jsonify({"error": "No view provided."}), 400
    if not llm.available():
        return jsonify({"error": "No LLM configured."}), 503
    chunks = list(llm._stream(
        "You are the sharpest devil's advocate. The user has stated a belief. "
        "Give the single strongest argument that should make them reconsider. "
        "Challenge a CORE PREMISE, not a peripheral point. "
        "3 paragraphs max. No softening. No 'to be fair.'",
        f"My view: {view}\n\nGive me the strongest case against this.",
    ))
    return jsonify({"challenge": "".join(chunks)})


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "5080"))
    debug = os.environ.get("FLASK_DEBUG", "") in ("1", "true", "True")
    app.run(host="0.0.0.0", port=port, debug=debug)
