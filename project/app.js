// ============ STARS GENERATOR ============
(function generateStars() {
  const container = document.getElementById('stars');
  const count = 120;
  for (let i = 0; i < count; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    star.style.left = Math.random() * 100 + '%';
    star.style.top = Math.random() * 100 + '%';
    star.style.setProperty('--duration', (2 + Math.random() * 4) + 's');
    star.style.setProperty('--max-opacity', (0.3 + Math.random() * 0.7));
    star.style.animationDelay = (Math.random() * 5) + 's';
    star.style.width = star.style.height = (1 + Math.random() * 2) + 'px';
    container.appendChild(star);
  }
})();

// ============ STATE ============
let verified = false;
let selectedFile = null;

// ============ HELP MODAL ============
function toggleHelp() {
  const modal = document.getElementById('helpModal');
  modal.classList.toggle('show');
}

document.getElementById('helpModal').addEventListener('click', function (e) {
  if (e.target === this) toggleHelp();
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    document.getElementById('helpModal').classList.remove('show');
  }
});

// ============ PASSWORD TOGGLE ============
function togglePassword() {
  const input = document.getElementById('apiKey');
  const icon = document.getElementById('eyeIcon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

// ============ TOAST ============
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: 'check-circle', error: 'exclamation-circle', info: 'info-circle' };
  toast.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ============ VERIFY CREDENTIALS ============
async function verifyCredentials() {
  const userId = document.getElementById('userId').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const btn = document.getElementById('verifyBtn');
  const result = document.getElementById('verifyResult');

  if (!userId) {
    showToast('Please enter your User ID', 'error');
    document.getElementById('userId').focus();
    return;
  }
  if (!/^\d+$/.test(userId)) {
    showToast('User ID must be a number', 'error');
    document.getElementById('userId').focus();
    return;
  }
  if (!apiKey) {
    showToast('Please enter your API Key', 'error');
    document.getElementById('apiKey').focus();
    return;
  }
  if (apiKey.length < 20) {
    showToast('API Key seems too short', 'error');
    return;
  }

  btn.classList.add('loading');
  btn.disabled = true;
  result.className = 'verify-result';
  result.style.display = 'none';

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-action': 'verify-user'
      },
      body: JSON.stringify({ userId, apiKey })
    });

    const data = await res.json();

    if (res.ok && data.valid) {
      verified = true;
      result.className = 'verify-result success show';
      let msg = `<i class="fas fa-check-circle"></i><div><strong>Verified!</strong> Welcome, ${data.displayName}`;
      if (data.keyValid === false) {
        msg += `<br><small style="color:var(--warning)">⚠ API Key might lack permissions: ${data.keyError}</small>`;
      }
      msg += `</div>`;
      result.innerHTML = msg;

      document.getElementById('step1Status').innerHTML = '<i class="fas fa-check-circle" style="color:var(--success)"></i>';

      const step2 = document.getElementById('step2');
      step2.classList.remove('locked');
      step2.classList.add('unlocked');
      step2.querySelector('.lock-icon')?.remove();

      showToast('Credentials verified!', 'success');
    } else {
      result.className = 'verify-result error show';
      result.innerHTML = `<i class="fas fa-exclamation-circle"></i><div>${data.error || 'Verification failed'}</div>`;
      showToast(data.error || 'Verification failed', 'error');
    }
  } catch (err) {
    result.className = 'verify-result error show';
    result.innerHTML = `<i class="fas fa-exclamation-circle"></i><div>Network error: ${err.message}</div>`;
    showToast('Network error', 'error');
  }

  btn.classList.remove('loading');
  btn.disabled = false;
}

// ============ FILE HANDLING ============
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

function handleFile(file) {
  const validExts = ['.rbxm', '.rbxmx', '.fbx', '.obj', '.png', '.jpg', '.jpeg', '.mp3', '.ogg'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!validExts.includes(ext)) {
    showToast('Unsupported file type. Use: ' + validExts.join(', '), 'error');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showToast('File too large (max 50MB)', 'error');
    return;
  }

  selectedFile = file;
  dropZone.style.display = 'none';
  document.getElementById('fileInfo').style.display = 'block';
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatSize(file.size);

  // Auto-detect type
  const typeMap = {
    '.rbxm': 'Model', '.rbxmx': 'Model',
    '.png': 'Decal', '.jpg': 'Decal', '.jpeg': 'Decal',
    '.mp3': 'Audio', '.ogg': 'Audio',
    '.fbx': 'Mesh', '.obj': 'Mesh'
  };
  if (typeMap[ext]) document.getElementById('assetType').value = typeMap[ext];

  // Auto-fill name
  if (!document.getElementById('assetName').value) {
    document.getElementById('assetName').value = file.name.replace(/\.[^.]+$/, '');
  }

  showToast('File ready: ' + file.name, 'success');
}

function removeFile() {
  selectedFile = null;
  fileInput.value = '';
  dropZone.style.display = '';
  document.getElementById('fileInfo').style.display = 'none';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ============ UPLOAD ============
async function uploadAsset() {
  if (!verified) {
    showToast('Please verify credentials first', 'error');
    return;
  }
  if (!selectedFile) {
    showToast('Please select a file', 'error');
    return;
  }

  const userId = document.getElementById('userId').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const assetName = document.getElementById('assetName').value.trim() || selectedFile.name.replace(/\.[^.]+$/, '');
  const assetType = document.getElementById('assetType').value;
  const assetDesc = document.getElementById('assetDesc').value.trim();

  const btn = document.getElementById('uploadBtn');
  btn.classList.add('loading');
  btn.disabled = true;

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('userId', userId);
  formData.append('apiKey', apiKey);
  formData.append('assetType', assetType);
  formData.append('displayName', assetName);
  formData.append('description', assetDesc || 'Uploaded via RBXM Converter');

  try {
    showToast('Uploading to Roblox...', 'info');

    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (res.ok && data.success) {
      // Unlock step 3
      const step3 = document.getElementById('step3');
      step3.classList.remove('locked');
      step3.classList.add('unlocked');
      step3.querySelector('.lock-icon')?.remove();

      document.getElementById('resultAssetId').textContent = data.assetId || 'Processing...';
      document.getElementById('resultInsertUrl').textContent = data.insertUrl || 'Processing...';

      if (data.toolboxUrl) {
        const link = document.getElementById('resultToolboxLink');
        link.href = data.toolboxUrl;
        link.style.display = 'flex';
      }

      if (!data.assetId && data.raw) {
        document.getElementById('resultTitle').textContent = 'Upload Submitted!';
        document.getElementById('resultAssetId').textContent = 'Processing (check Roblox inventory)';
      } else {
        document.getElementById('resultTitle').textContent = 'Asset Uploaded!';
      }

      document.getElementById('resultContent').querySelector('.result-icon').innerHTML = '<i class="fas fa-check-circle"></i>';
      document.getElementById('resultContent').querySelector('.result-icon').className = 'result-icon success-icon';

      step3.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast('Upload successful!', 'success');
    } else {
      // Show error in step 3
      const step3 = document.getElementById('step3');
      step3.classList.remove('locked');
      step3.classList.add('unlocked');
      step3.querySelector('.lock-icon')?.remove();

      document.getElementById('resultTitle').textContent = 'Upload Failed';
      document.getElementById('resultContent').querySelector('.result-icon').innerHTML = '<i class="fas fa-times-circle"></i>';
      document.getElementById('resultContent').querySelector('.result-icon').className = 'result-icon error-icon-result';

      const errorMsg = data.error || 'Unknown error';
      document.getElementById('resultAssetId').textContent = 'Error';
      document.getElementById('resultInsertUrl').textContent = errorMsg;
      document.getElementById('resultToolboxLink').style.display = 'none';

      step3.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast('Upload failed: ' + errorMsg, 'error');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  }

  btn.classList.remove('loading');
  btn.disabled = false;
}

// ============ COPY ============
function copyText(el) {
  const code = el.querySelector('code');
  if (!code) return;
  const text = code.textContent;
  if (!text || text === '—' || text === 'Error') return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied!', 'success');
    el.style.borderColor = 'var(--success)';
    setTimeout(() => el.style.borderColor = '', 1000);
  });
}

// ============ RESET ============
function resetAll() {
  removeFile();
  document.getElementById('assetName').value = '';
  document.getElementById('assetDesc').value = '';
  document.getElementById('assetType').value = 'Model';

  const step3 = document.getElementById('step3');
  step3.classList.add('locked');
  step3.classList.remove('unlocked');

  document.getElementById('resultAssetId').textContent = '—';
  document.getElementById('resultInsertUrl').textContent = '—';
  document.getElementById('resultToolboxLink').style.display = 'none';
  document.getElementById('resultTitle').textContent = 'Asset Uploaded!';
  document.getElementById('resultContent').querySelector('.result-icon').innerHTML = '<i class="fas fa-check-circle"></i>';
  document.getElementById('resultContent').querySelector('.result-icon').className = 'result-icon success-icon';

  document.getElementById('step2').scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast('Ready for another upload', 'info');
}
