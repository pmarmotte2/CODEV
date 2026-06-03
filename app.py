import os
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pypdf import PdfReader


MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
MAX_PDF_CHARS = 20_000
MAX_HISTORY_MESSAGES = 12
DEFAULT_INPUT_PRICE_PER_1M = 0.15
DEFAULT_CACHED_INPUT_PRICE_PER_1M = 0.075
DEFAULT_OUTPUT_PRICE_PER_1M = 0.60

app = FastAPI(title="Simulateur de negociation")
app.mount("/static", StaticFiles(directory="static"), name="static")


def get_client() -> OpenAI:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY est manquante dans l'environnement.",
        )
    return OpenAI()


def extract_pdf_text(file: UploadFile | None) -> str:
    if file is None:
        return ""

    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Le fichier doit etre un PDF.")

    try:
        reader = PdfReader(file.file)
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
    except Exception as exc:
        raise HTTPException(status_code=400, detail="PDF illisible ou invalide.") from exc

    text = "\n\n".join(page for page in pages if page)
    return text[:MAX_PDF_CHARS]


def get_price_per_1m(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


def get_nested_usage_value(source: object, name: str) -> int:
    if source is None:
        return 0
    if isinstance(source, dict):
        value = source.get(name, 0)
    else:
        value = getattr(source, name, 0)
    return value or 0


def build_usage_report(usage: object | None) -> dict[str, int | float | str]:
    prompt_tokens = get_nested_usage_value(usage, "prompt_tokens")
    completion_tokens = get_nested_usage_value(usage, "completion_tokens")
    total_tokens = get_nested_usage_value(usage, "total_tokens")
    prompt_details = get_nested_usage_value(usage, "prompt_tokens_details")
    cached_prompt_tokens = get_nested_usage_value(prompt_details, "cached_tokens")
    billable_prompt_tokens = max(prompt_tokens - cached_prompt_tokens, 0)

    input_price = get_price_per_1m("OPENAI_INPUT_PRICE_PER_1M", DEFAULT_INPUT_PRICE_PER_1M)
    cached_input_price = get_price_per_1m(
        "OPENAI_CACHED_INPUT_PRICE_PER_1M",
        DEFAULT_CACHED_INPUT_PRICE_PER_1M,
    )
    output_price = get_price_per_1m("OPENAI_OUTPUT_PRICE_PER_1M", DEFAULT_OUTPUT_PRICE_PER_1M)

    cost_usd = (
        (billable_prompt_tokens * input_price)
        + (cached_prompt_tokens * cached_input_price)
        + (completion_tokens * output_price)
    ) / 1_000_000

    return {
        "model": MODEL,
        "prompt_tokens": prompt_tokens,
        "cached_prompt_tokens": cached_prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cost_usd": cost_usd,
    }


def build_system_prompt(topic: str, agreement_text: str) -> str:
    context = (
        f"\n\nAccord de reference extrait du PDF:\n{agreement_text}"
        if agreement_text
        else "\n\nAucun accord PDF n'a ete fourni."
    )
    return f"""
Tu joues le role de la direction dans une simulation de negociation sociale.
Sujet de negociation: {topic}
{context}

Objectif:
- Repondre comme une direction credible, ferme mais professionnelle.
- Contrer les arguments de l'utilisateur avec des objections concretes.
- Utiliser le PDF uniquement s'il est fourni et pertinent.
- Reconnaitre les points valables sans conceder trop vite.
- Poser une question tactique quand cela aide a faire avancer la negociation.
- Rester en francais.

Format de reponse:
1. Position de la direction en 2 a 4 phrases.
2. Contre-arguments sous forme de puces.
3. Question ou condition de negociation.
""".strip()


@app.get("/")
def index() -> FileResponse:
    return FileResponse("static/index.html")


@app.post("/api/negotiate")
async def negotiate(
    topic: Annotated[str, Form()],
    argument: Annotated[str, Form()],
    history: Annotated[str, Form()] = "[]",
    agreement: Annotated[UploadFile | None, File()] = None,
) -> dict[str, object]:
    if not topic.strip():
        raise HTTPException(status_code=400, detail="Le sujet est obligatoire.")
    if not argument.strip():
        raise HTTPException(status_code=400, detail="L'argument est obligatoire.")

    agreement_text = extract_pdf_text(agreement)

    try:
        import json

        raw_history = json.loads(history)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Historique invalide.") from exc

    messages = [{"role": "system", "content": build_system_prompt(topic, agreement_text)}]
    for item in raw_history[-MAX_HISTORY_MESSAGES:]:
        role = item.get("role")
        content = item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": argument})

    response = get_client().chat.completions.create(
        model=MODEL,
        messages=messages,
        temperature=0.7,
    )

    content = response.choices[0].message.content or ""
    return {"reply": content.strip(), "usage": build_usage_report(response.usage)}
