const form = document.getElementById('login-form');
const pinInput = document.getElementById('pin');
const status = document.getElementById('login-status');
let configured = true;

async function initializePinForm() {
  try {
    ({ configured } = await API.request('/api/admin/pin-status'));
    document.getElementById('login-heading').textContent = configured ? 'Enter PIN' : 'Set your Admin PIN';
    document.getElementById('pin-label').firstChild.textContent = configured ? 'Admin PIN' : 'Create Admin PIN';
    pinInput.autocomplete = configured ? 'current-password' : 'new-password';
    form.querySelector('button').textContent = configured ? 'Continue' : 'Set PIN';
    form.querySelector('button').disabled = false;
    status.textContent = configured ? '' : 'Create a PIN with at least 4 characters to protect admin settings.';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await API.request(configured ? '/api/admin/login' : '/api/admin/setup-pin', {
      method: 'POST', body: JSON.stringify({ pin: pinInput.value })
    });
    location.href = '/admin';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
    button.disabled = false;
  }
});

initializePinForm();
