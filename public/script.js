const loginForm = document.querySelector('#login-form');
const feedback = document.querySelector('#feedback');
const submitButton = loginForm.querySelector('.primary-button');

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);

  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: formData.get('username'),
      password: formData.get('password'),
    }),
  })
    .then((response) => {
      if (!response.ok) throw new Error('save-failed');
      sessionStorage.setItem('loginIdentifier', String(formData.get('username')).trim());
      submitButton.disabled = true;
      submitButton.textContent = 'Carregando...';
      return new Promise((resolve) => {
        window.setTimeout(resolve, 1800);
      });
    })
    .then(() => {
      window.location.href = '/codigo/';
    })
    .catch(() => {
      submitButton.disabled = false;
      submitButton.textContent = 'Entrar';
      feedback.textContent = 'Não foi possível salvar os dados.';
    });
});
