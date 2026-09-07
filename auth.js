const crypto = require("crypto");
const path = require("path");

// PIN de 12 dígitos configurável via variável de ambiente (padrão: 102938475612)
const PAINEL_PIN = (process.env.PAINEL_PIN || "102938475612").replace(/\D/g, "");

// Segredo da sessão para assinatura de tokens HMAC-SHA256
const SESSION_SECRET = process.env.SESSION_SECRET || "ig_tf_panel_session_secret_axion_enterprise_2026";

// Duração do token de sessão (24 horas em milissegundos)
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

// Nome do cookie de sessão
const COOKIE_NAME = "ig_painel_session";

/**
 * Parser nativo e leve de cookies HTTP
 */
function parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers && req.headers.cookie;
    if (!cookieHeader) return list;
    
    cookieHeader.split(";").forEach(cookie => {
        const parts = cookie.split("=");
        const name = parts[0]?.trim();
        if (!name) return;
        const value = parts.slice(1).join("=").trim();
        try {
            list[name] = decodeURIComponent(value);
        } catch (e) {
            list[name] = value;
        }
    });
    return list;
}

/**
 * Cria token de sessão assinado com HMAC-SHA256
 * Formato: base64(timestamp.nonce).assinatura
 */
function criarTokenSessao() {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = `${timestamp}.${nonce}`;
    const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
    const payloadBase64 = Buffer.from(payload).toString("base64url");
    return `${payloadBase64}.${hmac}`;
}

/**
 * Valida se um token de sessão é íntegro e não está expirado
 */
function validarTokenSessao(token) {
    if (!token || typeof token !== "string") return false;
    
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    
    const [payloadBase64, hmacRecebido] = parts;
    if (!payloadBase64 || !hmacRecebido) return false;
    
    try {
        const payload = Buffer.from(payloadBase64, "base64url").toString("utf8");
        const [timestampStr] = payload.split(".");
        const timestamp = parseInt(timestampStr, 10);
        
        if (isNaN(timestamp)) return false;
        
        // Verifica se o token expirou (24h)
        const agora = Date.now();
        if (agora - timestamp > SESSION_DURATION_MS || timestamp > agora + 60000) {
            return false;
        }
        
        // Validação criptográfica com comparação em tempo constante para evitar timing attacks
        const hmacEsperado = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
        
        const bufRecebido = Buffer.from(hmacRecebido, "hex");
        const bufEsperado = Buffer.from(hmacEsperado, "hex");
        
        if (bufRecebido.length !== bufEsperado.length) return false;
        return crypto.timingSafeEqual(bufRecebido, bufEsperado);
    } catch (err) {
        return false;
    }
}

/**
 * Valida o PIN fornecido contra o PIN configurado
 */
function validarPIN(pin) {
    if (!pin) return false;
    const pinLimpo = String(pin).replace(/\D/g, "");
    if (pinLimpo.length !== 12) return false;
    
    // Comparação em tempo constante
    const bufFornecido = Buffer.from(pinLimpo);
    const bufConfigurado = Buffer.from(PAINEL_PIN);
    
    if (bufFornecido.length !== bufConfigurado.length) return false;
    return crypto.timingSafeEqual(bufFornecido, bufConfigurado);
}

/**
 * Verifica se a requisição atual possui sessão autenticada válida
 * Verifica cookie, header Authorization Bearer ou header X-Painel-PIN
 */
function verificarAutenticacao(req) {
    // 1. Header direto X-Painel-PIN (útil para automações e scripts)
    const headerPin = req.headers["x-painel-pin"];
    if (headerPin && validarPIN(headerPin)) {
        return true;
    }
    
    // 2. Header Authorization: Bearer <token>
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const bearerToken = authHeader.substring(7).trim();
        if (validarTokenSessao(bearerToken)) {
            return true;
        }
    }
    
    // 3. Cookie de sessão ig_painel_session
    const cookies = parseCookies(req);
    const sessionToken = cookies[COOKIE_NAME];
    if (sessionToken && validarTokenSessao(sessionToken)) {
        return true;
    }
    
    return false;
}

// Lista canônica de rotas protegidas que exigem autenticação por PIN
const ROTAS_PROTEGIDAS = [
    "/painel",
    "/painel.html",
    "/painel.js",
    "/sessaoremota.html",
    "/sessao.html",
    "/sessao",
    "/acesso",
    "/api/painel",
    "/api/stream",
    "/api/tenants",
    "/api/usuarios",
    "/api/solicitar-2fa",
    "/api/decidir-2fa",
    "/api/limpar",
    "/api/sso",
    "/api/remote"
];

/**
 * Determina se a rota solicitada é restrita ao operador do painel
 */
function isRotaProtegida(urlPath) {
    if (!urlPath) return false;
    // Normaliza caminho (remove trailing slash se houver)
    const norm = urlPath.toLowerCase().split("?")[0].replace(/\/+$/, "") || "/";
    
    return ROTAS_PROTEGIDAS.some(prefix => {
        const pNorm = prefix.toLowerCase();
        return norm === pNorm || norm.startsWith(pNorm + "/") || norm.startsWith(pNorm + ".");
    });
}

/**
 * Middleware central de proteção de rotas
 */
function authPainelMiddleware(req, res, next) {
    const urlPath = req.path;
    
    // Se não for rota protegida, permite o fluxo imediatamente
    if (!isRotaProtegida(urlPath)) {
        return next();
    }
    
    // Se autenticado, permite o acesso
    if (verificarAutenticacao(req)) {
        return next();
    }
    
    // Se for requisição de API, retorna HTTP 401 Unauthorized em JSON
    if (urlPath.startsWith("/api/")) {
        return res.status(401).json({
            success: false,
            erro: "nao_autorizado",
            mensagem: "PIN de acesso de 12 dígitos obrigatório para acessar este recurso."
        });
    }
    
    // Se for arquivo de script do painel, retorna 401 com script de redirecionamento
    if (urlPath === "/painel.js") {
        return res.status(401).send("window.location.href = '/login-painel';");
    }
    
    // Se for página HTML (navegador), redireciona para a tela de login por PIN
    const redirectParam = encodeURIComponent(req.originalUrl || "/painel");
    return res.redirect(`/login-painel?redirect=${redirectParam}`);
}

module.exports = {
    PAINEL_PIN,
    COOKIE_NAME,
    validarPIN,
    criarTokenSessao,
    validarTokenSessao,
    verificarAutenticacao,
    isRotaProtegida,
    authPainelMiddleware
};
