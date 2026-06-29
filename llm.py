"""
Multi-provider LLM for Adversary.

Provider priority (first available key wins):
  1. Groq  — free tier, very fast, llama-3.3-70b
  2. Claude — best quality, needs ANTHROPIC_API_KEY
  3. Local  — CPU-only GGUF, set ENABLE_LOCAL_LLM=1

Every public function yields text chunks so the caller can SSE-stream
each debate phase to the browser character by character.
"""

from __future__ import annotations

import json
import os
from typing import Generator

# ── Provider detection ────────────────────────────────────────────────────────

def _groq():
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return None
    try:
        from groq import Groq
        return Groq(api_key=key)
    except ImportError:
        return None


def _anthropic():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        import anthropic
        return anthropic.Anthropic(api_key=key)
    except ImportError:
        return None


def _local():
    if os.environ.get("ENABLE_LOCAL_LLM") not in ("1", "true", "yes"):
        return None
    try:
        from llama_cpp import Llama
        repo  = os.environ.get("LOCAL_MODEL_REPO",  "Qwen/Qwen2.5-7B-Instruct-GGUF")
        fname = os.environ.get("LOCAL_MODEL_FILE",  "qwen2.5-7b-instruct-q4_k_m.gguf")
        n_ctx = int(os.environ.get("MODEL_N_CTX", "4096"))
        n_thr = int(os.environ.get("MODEL_N_THREADS", str(os.cpu_count() or 4)))
        return Llama.from_pretrained(repo_id=repo, filename=fname,
                                     n_ctx=n_ctx, n_threads=n_thr, verbose=False)
    except Exception:
        return None


def provider_name() -> str:
    if os.environ.get("GROQ_API_KEY"):
        return "Groq / llama-3.3-70b"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "Claude / claude-opus-4-8"
    if os.environ.get("ENABLE_LOCAL_LLM") in ("1", "true", "yes"):
        return f"Local / {os.environ.get('LOCAL_MODEL_FILE','qwen2.5-7b-instruct-q4_k_m.gguf')}"
    return "none"


def available() -> bool:
    return provider_name() != "none"


# ── Core streaming call ───────────────────────────────────────────────────────

def _stream(system: str, user: str) -> Generator[str, None, None]:
    """Yield text chunks from whichever provider is configured."""

    # 1. Groq
    g = _groq()
    if g:
        stream = g.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "system", "content": system},
                      {"role": "user",   "content": user}],
            stream=True,
            max_tokens=1024,
            temperature=0.7,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
        return

    # 2. Claude
    a = _anthropic()
    if a:
        with a.messages.stream(
            model="claude-opus-4-8",
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": user}],
        ) as s:
            for text in s.text_stream:
                yield text
        return

    # 3. Local
    lm = _local()
    if lm:
        out = lm.create_chat_completion(
            messages=[{"role": "system", "content": system},
                      {"role": "user",   "content": user}],
            max_tokens=1024,
            temperature=0.7,
            stream=True,
        )
        for chunk in out:
            delta = chunk["choices"][0]["delta"].get("content", "")
            if delta:
                yield delta
        return

    yield "(No LLM provider configured. Set GROQ_API_KEY, ANTHROPIC_API_KEY, or ENABLE_LOCAL_LLM=1.)"


# ── Debate phases ─────────────────────────────────────────────────────────────

_SYS_THESIS = """\
You are the most persuasive advocate imaginable. Your job is to present the
STRONGEST POSSIBLE CASE in favor of the position given.
Rules:
- Be concrete. Use specific evidence, statistics, mechanisms — not vague claims.
- Do NOT hedge, do NOT acknowledge counterarguments, do NOT say "of course it's complex."
- Write 3-4 punchy, substantive paragraphs.
- Be compelling. If you don't give the strongest case, you've failed.
"""

_SYS_ANTITHESIS = """\
You are the most rigorous devil's advocate imaginable. Your job is to present the
STRONGEST POSSIBLE CASE AGAINST the position given.
You have read the argument FOR. Now dismantle it.
Rules:
- Attack the premises, not just the conclusions.
- Expose what the FOR case ignores, exaggerates, or gets wrong.
- Be concrete and specific — not vague gestures at complexity.
- Do NOT acknowledge any merit in the FOR case. No "to be fair." No "however."
- Write 3-4 punchy, substantive paragraphs.
"""

_SYS_SYNTHESIS = """\
You have heard both sides of a debate and you are now the honest arbiter.
You have no stake in either position. Your only goal is the truth.
Write:
1. What the FOR case gets right (1-2 sentences, specific)
2. What the AGAINST case gets right (1-2 sentences, specific)
3. The most defensible position given the actual evidence (2-3 sentences)
4. One specific condition that would change your conclusion

Be genuinely honest. If one side is much stronger, say so.
Do not split the difference to seem balanced if the evidence doesn't support it.
"""

_SYS_VERDICT = """\
You are scoring a debate. Given the FOR argument and the AGAINST argument,
return ONLY a JSON object, nothing else:
{"for_score": <0.0-1.0>, "against_score": <0.0-1.0>, "verdict": "<one sentence>"}
where the two scores sum to 1.0 and verdict is a single honest sentence about which
side made the stronger case and why.
"""


def stream_thesis(question: str) -> Generator[str, None, None]:
    yield from _stream(_SYS_THESIS, f"Question / claim: {question}\n\nPresent the case FOR.")


def stream_antithesis(question: str, thesis: str) -> Generator[str, None, None]:
    yield from _stream(
        _SYS_ANTITHESIS,
        f"Question / claim: {question}\n\nThe FOR argument:\n{thesis}\n\nNow make the case AGAINST.",
    )


def stream_synthesis(question: str, thesis: str, antithesis: str) -> Generator[str, None, None]:
    yield from _stream(
        _SYS_SYNTHESIS,
        f"Question: {question}\n\nFOR:\n{thesis}\n\nAGAINST:\n{antithesis}\n\nGive the honest assessment.",
    )


def get_verdict(question: str, thesis: str, antithesis: str) -> dict:
    """Return {for_score, against_score, verdict} — not streamed."""
    text = "".join(_stream(
        _SYS_VERDICT,
        f"Question: {question}\nFOR:\n{thesis}\nAGAINST:\n{antithesis}",
    ))
    # Extract JSON — tolerate LLM preamble
    start = text.find("{")
    end = text.rfind("}") + 1
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end])
        except Exception:
            pass
    return {"for_score": 0.5, "against_score": 0.5, "verdict": text.strip()[:200]}
