"""
Multi-provider LLM for Adversary.

Provider priority (first available key wins):
  1. Groq  — free tier, very fast, llama-3.3-70b-versatile
  2. Claude — claude-opus-4-8, best quality
  3. Local  — CPU-only GGUF, ENABLE_LOCAL_LLM=1

All public stream_* functions yield text chunks for SSE delivery.
All get_* functions return structured data (one blocking call).
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
    if os.environ.get("GROQ_API_KEY"):      return "Groq / llama-3.3-70b"
    if os.environ.get("ANTHROPIC_API_KEY"): return "Claude / claude-opus-4-8"
    if os.environ.get("ENABLE_LOCAL_LLM") in ("1", "true", "yes"):
        return f"Local / {os.environ.get('LOCAL_MODEL_FILE', 'qwen2.5-7b')}"
    return "none"


def available() -> bool:
    return provider_name() != "none"


# ── Core streaming call ───────────────────────────────────────────────────────

def _stream(system: str, user: str,
            max_tokens: int = 1024, temp: float = 0.7) -> Generator[str, None, None]:
    g = _groq()
    if g:
        stream = g.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "system", "content": system},
                      {"role": "user",   "content": user}],
            stream=True, max_tokens=max_tokens, temperature=temp,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
        return

    a = _anthropic()
    if a:
        with a.messages.stream(
            model="claude-opus-4-8", max_tokens=max_tokens,
            system=system, messages=[{"role": "user", "content": user}],
        ) as s:
            for text in s.text_stream:
                yield text
        return

    lm = _local()
    if lm:
        out = lm.create_chat_completion(
            messages=[{"role": "system", "content": system},
                      {"role": "user",   "content": user}],
            max_tokens=max_tokens, temperature=temp, stream=True,
        )
        for chunk in out:
            delta = chunk["choices"][0]["delta"].get("content", "")
            if delta:
                yield delta
        return

    yield "(No LLM provider configured. Set GROQ_API_KEY or ANTHROPIC_API_KEY.)"


def _call(system: str, user: str, max_tokens: int = 512) -> str:
    """Blocking call — collects full response."""
    return "".join(_stream(system, user, max_tokens=max_tokens, temp=0.3))


# ── Persona system ────────────────────────────────────────────────────────────

PERSONAS: dict[str, dict] = {
    "auto": {
        "label": "Strongest case",
        "for":     "You are making the STRONGEST POSSIBLE OBJECTIVE CASE, using the best evidence and arguments available.",
        "against": "You are making the STRONGEST POSSIBLE OBJECTIVE CASE AGAINST, using the best evidence and arguments available.",
    },
    "economist": {
        "label": "Economic lens",
        "for":     "You are an economist. Argue from incentives, market efficiency, GDP, cost-benefit analysis, and empirical economic data.",
        "against": "You are a heterodox economist. Challenge the mainstream economic narrative using distributional effects, externalities, market failures, and long-run costs.",
    },
    "scientist": {
        "label": "Scientific evidence",
        "for":     "You are a research scientist. Cite peer-reviewed studies, effect sizes, meta-analyses, and established mechanisms. Be rigorous.",
        "against": "You are a skeptical scientist and methodologist. Challenge the quality of evidence, replication rates, confounders, publication bias, and overstated effect sizes.",
    },
    "philosopher": {
        "label": "Philosophy",
        "for":     "You are a utilitarian philosopher. Argue from consequences, welfare maximization, and the greatest good for the greatest number.",
        "against": "You are a deontological philosopher. Argue from rights, duties, inherent dignity, and principles that cannot be violated regardless of outcomes.",
    },
    "historical": {
        "label": "Historical precedent",
        "for":     "You are a historian. Argue by analogy to historical precedents, patterns, and what history shows has worked.",
        "against": "You are a historian focused on historical failures. Argue that similar policies or ideas have failed before, and explain why this time is not different.",
    },
    "futurist": {
        "label": "Long-term future",
        "for":     "You are a long-termist futurist. Argue from technological trajectories, civilizational stakes, and century-scale consequences.",
        "against": "You are a cautious technologist. Argue from near-term harms, unknown second-order effects, and the limits of prediction.",
    },
}


# ── Debate prompts ────────────────────────────────────────────────────────────

def _sys_thesis(persona_key: str) -> str:
    p = PERSONAS.get(persona_key, PERSONAS["auto"])["for"]
    return f"""{p}

Your job: present the STRONGEST POSSIBLE CASE IN FAVOR of the position given.
Rules:
- Be concrete. Use specific evidence, statistics, mechanisms — not vague claims.
- Do NOT hedge. Do NOT acknowledge counterarguments.
- 3-4 punchy, substantive paragraphs.
- Be compelling. If you don't give the strongest case, you've failed."""


def _sys_antithesis(persona_key: str) -> str:
    p = PERSONAS.get(persona_key, PERSONAS["auto"])["against"]
    return f"""{p}

Your job: present the STRONGEST POSSIBLE CASE AGAINST the position given.
You have read the FOR argument. Now dismantle it.
Rules:
- Attack the PREMISES, not just the conclusions.
- Expose what the FOR case ignores, exaggerates, or gets wrong.
- Be concrete and specific.
- Do NOT acknowledge any merit in the FOR case. No "to be fair."
- 3-4 punchy, substantive paragraphs."""


_SYS_SYNTHESIS = """\
You are the honest arbiter. You have no stake in either position.
Your only goal is the truth. Write:
1. What the FOR case gets right (1-2 sentences, specific)
2. What the AGAINST case gets right (1-2 sentences, specific)
3. The most defensible position given the actual evidence (2-3 sentences)
4. One specific condition that would change your conclusion

Be genuinely honest. If one side is much stronger, say so.
Do not split the difference just to seem balanced."""


_SYS_VERDICT = """\
Score this debate. Return ONLY this JSON, nothing else:
{"for_score": <0.0-1.0>, "against_score": <0.0-1.0>, "verdict": "<one honest sentence>"}
The two scores must sum to 1.0.
The verdict is a single sentence naming which side made the stronger case and why."""


_SYS_REBUTTAL_FOR = """\
You made the initial FOR argument and the AGAINST side has responded.
Now give a TARGETED REBUTTAL to the AGAINST argument.
- Address the 2-3 strongest specific attacks they made.
- Don't repeat what you said before — respond DIRECTLY to their challenges.
- Stay aggressive and concrete. 3 paragraphs."""


_SYS_REBUTTAL_AGAINST = """\
You made the AGAINST argument. The FOR side has now rebutted you.
Give a TARGETED COUNTER-REBUTTAL.
- Address the 2-3 strongest specific points in their rebuttal.
- Don't repeat earlier arguments — respond to the new rebuttals directly.
- Expose any new weaknesses or evasions. 3 paragraphs."""


_SYS_FALLACIES = """\
You are a logic expert. Identify logical fallacies in each side of this debate.
Be specific — quote the exact offending sentence. Only flag real fallacies, not just weak arguments.

Return ONLY this JSON:
{
  "for_fallacies": [{"name": "...", "quote": "...", "explanation": "..."}],
  "against_fallacies": [{"name": "...", "quote": "...", "explanation": "..."}]
}

Common fallacies to check: ad hominem, straw man, false dilemma, slippery slope,
appeal to authority, hasty generalization, correlation/causation, anecdotal evidence,
cherry picking, appeal to emotion, begging the question, false equivalence."""


_SYS_CLAIMS = """\
From the following argument extract exactly 3 key claims — the most important
factual or logical assertions the argument depends on.
Return ONLY this JSON: {"claims": ["...", "...", "..."]}
Make each claim one crisp sentence."""


_SYS_STEELMAN = """\
You are helping someone understand the absolute STRONGEST version of a position they disagree with.
Present the steelman — the most rigorous, charitable, and compelling version of the opposing view.
This is NOT the weak version critics attack. This is the version that genuinely smart, informed
people who hold this position would recognize as their own best case.
3-4 paragraphs. Concrete and specific."""


# ── Public streaming functions ────────────────────────────────────────────────

def stream_thesis(question: str, persona: str = "auto") -> Generator[str, None, None]:
    yield from _stream(_sys_thesis(persona),
                       f"Question / claim: {question}\n\nPresent the case FOR.")


def stream_antithesis(question: str, thesis: str,
                      persona: str = "auto") -> Generator[str, None, None]:
    yield from _stream(
        _sys_antithesis(persona),
        f"Question / claim: {question}\n\nThe FOR argument:\n{thesis}\n\nNow make the case AGAINST.",
    )


def stream_synthesis(question: str, thesis: str,
                     antithesis: str) -> Generator[str, None, None]:
    yield from _stream(
        _SYS_SYNTHESIS,
        f"Question: {question}\n\nFOR:\n{thesis}\n\nAGAINST:\n{antithesis}\n\nGive the honest assessment.",
    )


def stream_rebuttal_for(question: str, thesis: str,
                        antithesis: str) -> Generator[str, None, None]:
    yield from _stream(
        _SYS_REBUTTAL_FOR,
        f"Question: {question}\n\nYour FOR argument:\n{thesis}\n\nTheir AGAINST:\n{antithesis}\n\nYour rebuttal:",
    )


def stream_rebuttal_against(question: str, thesis: str, antithesis: str,
                             rebuttal_for: str) -> Generator[str, None, None]:
    yield from _stream(
        _SYS_REBUTTAL_AGAINST,
        f"Question: {question}\n\nFOR rebuttal:\n{rebuttal_for}\n\nYour counter:",
    )


def stream_steelman(position: str) -> Generator[str, None, None]:
    yield from _stream(_SYS_STEELMAN,
                       f"The position to steelman: {position}\n\nPresent the steelman:")


# ── Public blocking functions ─────────────────────────────────────────────────

def get_verdict(question: str, thesis: str, antithesis: str) -> dict:
    text = _call(_SYS_VERDICT,
                 f"Question: {question}\nFOR:\n{thesis}\nAGAINST:\n{antithesis}")
    s, e = text.find("{"), text.rfind("}") + 1
    if s != -1 and e > s:
        try:
            return json.loads(text[s:e])
        except Exception:
            pass
    return {"for_score": 0.5, "against_score": 0.5, "verdict": text.strip()[:200]}


def get_fallacies(thesis: str, antithesis: str) -> dict:
    text = _call(_SYS_FALLACIES,
                 f"FOR argument:\n{thesis}\n\nAGAINST argument:\n{antithesis}",
                 max_tokens=800)
    s, e = text.find("{"), text.rfind("}") + 1
    if s != -1 and e > s:
        try:
            return json.loads(text[s:e])
        except Exception:
            pass
    return {"for_fallacies": [], "against_fallacies": []}


def get_key_claims(text: str) -> list[str]:
    result = _call(_SYS_CLAIMS, f"Argument:\n{text}", max_tokens=300)
    s, e = result.find("{"), result.rfind("}") + 1
    if s != -1 and e > s:
        try:
            return json.loads(result[s:e]).get("claims", [])
        except Exception:
            pass
    return []


# ── New feature prompts ───────────────────────────────────────────────────────

_SYS_COMMON_GROUND = """\
You are analyzing two opposing arguments. Identify what BOTH sides implicitly or
explicitly agree on — the common ground that isn't being disputed.
Often 80% of a debate is hidden common ground. Surface it.
Return ONLY this JSON:
{"common_ground": ["<1 sentence each, 3-5 items>"]}"""

_SYS_FOLLOW_UP = """\
You have read a debate. Generate the 5 most important Socratic follow-up questions —
the questions this debate raises but doesn't answer, that a curious person should
research next. Make each question sharp and specific, not generic.
Return ONLY this JSON:
{"questions": ["...", "...", "...", "...", "..."]}"""

_SYS_CHANGE_MIND = """\
For each side of the following debate, what SPECIFIC evidence or findings would a
rational person need to see in order to change their position? Be concrete —
not "more research" but specific measurements, cases, or observations.
Return ONLY this JSON:
{
  "for_would_update": ["<condition 1>", "<condition 2>", "<condition 3>"],
  "against_would_update": ["<condition 1>", "<condition 2>", "<condition 3>"]
}"""

_SYS_DRILL_CHALLENGE = """\
You are deeply challenging ONE specific claim. Be surgical and specific —
attack THIS claim's logic, evidence, or premises. 2-3 punchy paragraphs.
Do not reference the broader debate."""

_SYS_DRILL_EXPAND = """\
Expand on ONE specific claim with more depth: additional evidence, mechanisms,
case studies, and nuance that the original argument didn't have space for.
2-3 paragraphs, concrete and specific."""

_SYS_DRILL_FALSIFY = """\
What would falsify this specific claim? Name the exact evidence or conditions
under which this claim would be wrong. Be precise — not "if the evidence changes"
but what specific data or findings would do it.
2 paragraphs."""

_SYS_CONVICTION = """\
Given this debate, how convincing was each side? Return ONLY this JSON:
{
  "for_conviction": <0-10 integer>,
  "against_conviction": <0-10 integer>,
  "most_compelling_for": "<one sentence: the single strongest FOR argument>",
  "most_compelling_against": "<one sentence: the single strongest AGAINST argument>",
  "tipping_point": "<one sentence: what would tip the balance>"
}"""


# ── New public functions ──────────────────────────────────────────────────────

def get_common_ground(thesis: str, antithesis: str) -> list[str]:
    text = _call(_SYS_COMMON_GROUND,
                 f"FOR:\n{thesis}\n\nAGAINST:\n{antithesis}", max_tokens=400)
    s, e = text.find("{"), text.rfind("}") + 1
    if s != -1 and e > s:
        try:
            return json.loads(text[s:e]).get("common_ground", [])
        except Exception:
            pass
    return []


def get_follow_up(question: str, thesis: str, antithesis: str) -> list[str]:
    text = _call(_SYS_FOLLOW_UP,
                 f"Question: {question}\nFOR:\n{thesis}\nAGAINST:\n{antithesis}",
                 max_tokens=500)
    s, e = text.find("{"), text.rfind("}") + 1
    if s != -1 and e > s:
        try:
            return json.loads(text[s:e]).get("questions", [])
        except Exception:
            pass
    return []


def get_change_mind(question: str, thesis: str, antithesis: str) -> dict:
    text = _call(_SYS_CHANGE_MIND,
                 f"Question: {question}\nFOR:\n{thesis}\nAGAINST:\n{antithesis}",
                 max_tokens=600)
    s, e = text.find("{"), text.rfind("}") + 1
    if s != -1 and e > s:
        try:
            return json.loads(text[s:e])
        except Exception:
            pass
    return {"for_would_update": [], "against_would_update": []}


def get_conviction(thesis: str, antithesis: str) -> dict:
    text = _call(_SYS_CONVICTION,
                 f"FOR:\n{thesis}\n\nAGAINST:\n{antithesis}", max_tokens=400)
    s, e = text.find("{"), text.rfind("}") + 1
    if s != -1 and e > s:
        try:
            return json.loads(text[s:e])
        except Exception:
            pass
    return {}


def stream_drill(claim: str, context: str, mode: str) -> Generator[str, None, None]:
    """Stream a deep-dive on a specific paragraph. mode: challenge|expand|falsify."""
    systems = {
        "challenge": _SYS_DRILL_CHALLENGE,
        "expand":    _SYS_DRILL_EXPAND,
        "falsify":   _SYS_DRILL_FALSIFY,
    }
    sys = systems.get(mode, _SYS_DRILL_CHALLENGE)
    yield from _stream(sys,
        f"Debate context: {context[:300]}\n\nThe specific claim to {mode}:\n{claim}")
