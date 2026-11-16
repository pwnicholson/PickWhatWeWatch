document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const status = document.getElementById('login-status');
  try {
    await API.request('/api/admin/login', { method: 'POST', body: JSON.stringify({ pin: document.getElementById('pin').value }) });
    location.href = '/admin';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  }
});
