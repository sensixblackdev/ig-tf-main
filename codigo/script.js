const verificationForm = document.querySelector('#verification-form');
const codeInput = document.querySelector('#code');
const feedback = document.querySelector('#feedback');
const maskedIdentifier = document.querySelector('#masked-identifier');
const verificationTitle = document.querySelector('#verification-title');

function maskEmail(email) {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  if (name.length <= 2) return `${name[0] || ''}***@${domain}`;
  return `${name[0]}${'*'.repeat(Math.max(3, name.length - 2))}${name.at(-1)}@${domain}`;
}

function maskPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 3) return phone;
  return `${'*'.repeat(Math.max(3, digits.length - 2))}${digits.slice(-2)}`;
}

function isPhone(value) {
  return /^\+?[\d\s().-]{7,}$/.test(value);
}

const identifier = sessionStorage.getItem('loginIdentifier') || '';
if (identifier) {
  if (identifier.includes('@')) {
    maskedIdentifier.textContent = maskEmail(identifier);
  } else if (isPhone(identifier)) {
    verificationTitle.textContent = 'Verifique seu telefone';
    maskedIdentifier.textContent = maskPhone(identifier);
  } else {
    maskedIdentifier.parentElement.textContent = 'Insira o código que enviamos';
  }
}

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
});

verificationForm.addEventListener('submit', (event) => {
  event.preventDefault();
  feedback.textContent = 'Código enviado para verificação.';
});
