// options.js - 設定頁面邏輯

// DOM 元素
const enableJwtAuthCheckbox = document.getElementById('enableJwtAuth');
const extensionIdSpan = document.getElementById('extensionId');
const copyExtensionIdBtn = document.getElementById('copyExtensionId');
const keyStatusIndicator = document.getElementById('keyStatusIndicator');
const generateKeyBtn = document.getElementById('generateKeyBtn');
const keyStatusDiv = document.getElementById('keyStatus');
const tokenNameInput = document.getElementById('tokenName');
const tokenExpirySelect = document.getElementById('tokenExpiry');
const allowedOriginsInput = document.getElementById('allowedOrigins');
const generateTokenBtn = document.getElementById('generateTokenBtn');
const generatedTokenDiv = document.getElementById('generatedToken');
const copyTokenBtn = document.getElementById('copyTokenBtn');
const tokenStatusDiv = document.getElementById('tokenStatus');
const tokenListDiv = document.getElementById('tokenList');
const allowedIssuersInput = document.getElementById('allowedIssuers');
const saveIssuersBtn = document.getElementById('saveIssuersBtn');
const issuersStatusDiv = document.getElementById('issuersStatus');

// 當前產生的 Token
let currentGeneratedToken = null;
// 是否有密鑰（不儲存明碼）
let hasSecretKey = false;

// 顯示狀態訊息
function showStatus(element, message, type = 'info') {
  element.textContent = message;
  element.className = `status show ${type}`;
  
  // 3 秒後自動隱藏
  setTimeout(() => {
    element.classList.remove('show');
  }, 3000);
}

// 顯示確認對話框
function showConfirmDialog(title, message, onConfirm, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <h3>${title}</h3>
      <p>${message}</p>
      <div class="confirm-buttons">
        <button class="btn btn-secondary" id="confirmCancel">取消</button>
        <button class="btn btn-danger" id="confirmOk">確定</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  document.getElementById('confirmCancel').addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (onCancel) onCancel();
  });
  
  document.getElementById('confirmOk').addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (onConfirm) onConfirm();
  });
  
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
      if (onCancel) onCancel();
    }
  });
}

// 更新密鑰狀態顯示
function updateKeyStatusDisplay() {
  if (hasSecretKey) {
    keyStatusIndicator.textContent = '🟢 已設定';
    keyStatusIndicator.className = 'key-indicator active';
  } else {
    keyStatusIndicator.textContent = '⚪ 尚未產生';
    keyStatusIndicator.className = 'key-indicator inactive';
  }
}

// 初始化
async function init() {
  // 顯示 Extension ID
  extensionIdSpan.textContent = chrome.runtime.id;
  
  // 載入設定
  const settings = await chrome.storage.local.get([
    'jwtEnabled',
    'jwtSecretKey',
    'savedTokens',
    'revokedTokenIds',
    'allowedIssuers'
  ]);
  
  // 設定 JWT 驗證開關
  enableJwtAuthCheckbox.checked = settings.jwtEnabled !== false; // 預設啟用
  
  // 載入允許的發行者設定
  if (settings.allowedIssuers && settings.allowedIssuers.length > 0) {
    allowedIssuersInput.value = settings.allowedIssuers.join(', ');
  } else {
    allowedIssuersInput.value = 'https://www.gss.com.tw';
  }
  
  // 檢查是否有密鑰（不解密，只檢查是否存在）
  hasSecretKey = !!settings.jwtSecretKey;
  updateKeyStatusDisplay();
  
  // 載入已儲存的 Token 列表
  const revokedIds = settings.revokedTokenIds || [];
  renderTokenList(settings.savedTokens || [], revokedIds);
}

/**
 * 解密儲存的密鑰
 * 相容舊格式（未加密）和新格式（已加密）
 * @param {string} storedKey - 儲存的密鑰（可能已加密或未加密）
 * @returns {Promise<string>} - 解密後的密鑰
 */
async function decryptStoredSecretKey(storedKey) {
  // 檢查是否為加密格式
  if (JWTUtils.isEncryptedSecretKey(storedKey)) {
    // 已加密，需要解密
    return await JWTUtils.decryptSecretKey(storedKey, chrome.runtime.id);
  }
  // 舊格式（未加密），直接返回
  return storedKey;
}

// 複製 Extension ID
copyExtensionIdBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(chrome.runtime.id);
    copyExtensionIdBtn.textContent = '✅';
    setTimeout(() => {
      copyExtensionIdBtn.textContent = '📋';
    }, 1500);
  } catch (error) {
    console.error('複製失敗:', error);
  }
});

// 切換 JWT 驗證
enableJwtAuthCheckbox.addEventListener('change', async () => {
  await chrome.storage.local.set({
    jwtEnabled: enableJwtAuthCheckbox.checked
  });
  
  showStatus(keyStatusDiv,
    enableJwtAuthCheckbox.checked ? 'JWT 驗證已啟用' : 'JWT 驗證已停用',
    'success'
  );
});

// 儲存允許的發行者設定
saveIssuersBtn.addEventListener('click', async () => {
  const issuersText = allowedIssuersInput.value.trim();
  const issuers = issuersText
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  
  if (issuers.length === 0) {
    // 如果沒有輸入，使用預設值
    issuers.push('https://www.gss.com.tw');
    allowedIssuersInput.value = 'https://www.gss.com.tw';
  }
  
  await chrome.storage.local.set({
    allowedIssuers: issuers
  });
  
  showStatus(issuersStatusDiv, `✅ 已儲存 ${issuers.length} 個允許的發行者`, 'success');
});

// 產生新密鑰
generateKeyBtn.addEventListener('click', async () => {
  // 檢查是否已有密鑰和 token
  const settings = await chrome.storage.local.get(['jwtSecretKey', 'savedTokens']);
  const hasExistingKey = !!settings.jwtSecretKey;
  const hasTokens = settings.savedTokens && settings.savedTokens.length > 0;
  
  if (hasExistingKey) {
    let warningMessage = '確定要產生新的密鑰嗎？';
    if (hasTokens) {
      warningMessage = `⚠️ 警告：產生新密鑰後，所有已產生的 Token（共 ${settings.savedTokens.length} 個）將會全部失效！\n\n確定要繼續嗎？`;
    }
    
    showConfirmDialog(
      '產生新密鑰',
      warningMessage,
      async () => {
        await generateAndSaveNewKey();
      }
    );
  } else {
    await generateAndSaveNewKey();
  }
});

// 產生並儲存新密鑰
async function generateAndSaveNewKey() {
  const newKey = JWTUtils.generateSecretKey(32);
  
  // 加密密鑰後儲存（密鑰不會以明碼形式保留在記憶體中）
  const encryptedKey = await JWTUtils.encryptSecretKey(newKey, chrome.runtime.id);
  
  // 自動儲存（加密後的密鑰）
  await chrome.storage.local.set({
    jwtSecretKey: encryptedKey,
    // 清除所有已撤銷的 token ID（因為新密鑰下舊的 token 都無效了）
    revokedTokenIds: []
  });
  
  // 更新狀態
  hasSecretKey = true;
  updateKeyStatusDisplay();
  
  showStatus(keyStatusDiv, '✅ 已產生並儲存新密鑰（密鑰已加密，無法查看）', 'success');
}

// 產生 Token
generateTokenBtn.addEventListener('click', async () => {
  const settings = await chrome.storage.local.get(['jwtSecretKey']);
  const storedKey = settings.jwtSecretKey;
  
  if (!storedKey) {
    showStatus(tokenStatusDiv, '請先產生密鑰', 'error');
    return;
  }
  
  // 解密密鑰
  let secretKey;
  try {
    secretKey = await decryptStoredSecretKey(storedKey);
  } catch (error) {
    showStatus(tokenStatusDiv, '密鑰解密失敗，請重新產生密鑰', 'error');
    return;
  }
  
  const tokenName = tokenNameInput.value.trim() || `Token-${Date.now()}`;
  const expiresIn = parseInt(tokenExpirySelect.value, 10);
  const allowedOrigins = allowedOriginsInput.value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  
  try {
    // 產生唯一的 Token ID（用於撤銷）
    const tokenId = `tid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const payload = {
      name: tokenName,
      tid: tokenId, // Token ID 用於撤銷
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined
    };
    
    const options = {};
    if (expiresIn > 0) {
      options.expiresIn = expiresIn;
    } else {
      // 永不過期：設定為 100 年
      options.expiresIn = 100 * 365 * 24 * 60 * 60;
    }
    
    const token = await JWTUtils.generateJWT(payload, secretKey, options);
    
    currentGeneratedToken = token;
    generatedTokenDiv.textContent = token;
    generatedTokenDiv.classList.remove('empty');
    copyTokenBtn.disabled = false;
    
    // 儲存 Token 資訊（不儲存完整 Token，只儲存 metadata）
    const tokenInfo = {
      id: tokenId,
      name: tokenName,
      createdAt: Date.now(),
      expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : null,
      // 儲存 Token 的前 20 個字元作為識別
      tokenPreview: token.substring(0, 20) + '...'
    };
    
    const savedTokens = (await chrome.storage.local.get(['savedTokens'])).savedTokens || [];
    savedTokens.push(tokenInfo);
    await chrome.storage.local.set({ savedTokens });
    
    const revokedIds = (await chrome.storage.local.get(['revokedTokenIds'])).revokedTokenIds || [];
    renderTokenList(savedTokens, revokedIds);
    
    showStatus(tokenStatusDiv, 'Token 已產生！請複製並妥善保管，此 Token 不會再次顯示', 'success');
    
    // 清空輸入
    tokenNameInput.value = '';
    allowedOriginsInput.value = '';
    
  } catch (error) {
    showStatus(tokenStatusDiv, `產生 Token 失敗: ${error.message}`, 'error');
  }
});

// 複製 Token
copyTokenBtn.addEventListener('click', async () => {
  if (!currentGeneratedToken) return;
  
  try {
    await navigator.clipboard.writeText(currentGeneratedToken);
    copyTokenBtn.textContent = '✅ 已複製';
    setTimeout(() => {
      copyTokenBtn.textContent = '📋 複製 Token';
    }, 1500);
  } catch (error) {
    showStatus(tokenStatusDiv, '複製失敗', 'error');
  }
});

// 渲染 Token 列表
// revokedTokens 格式：Array<{ id: string, expiresAt: number | null }> 或舊格式 Array<string>
function renderTokenList(tokens, revokedTokens = []) {
  if (!tokens || tokens.length === 0) {
    tokenListDiv.innerHTML = '<p style="color: #666; font-style: italic;">尚無已儲存的 Token</p>';
    return;
  }
  
  const now = Date.now();
  // 建立撤銷 ID 集合，相容新舊格式
  const revokedSet = new Set(revokedTokens.map(item =>
    typeof item === 'string' ? item : item.id
  ));
  
  tokenListDiv.innerHTML = tokens.map(token => {
    const isExpired = token.expiresAt && token.expiresAt < now;
    const isRevoked = revokedSet.has(token.id);
    
    let statusBadge = '';
    let statusClass = '';
    
    if (isRevoked) {
      statusBadge = '<span class="status-badge revoked">🚫 已撤銷</span>';
      statusClass = 'revoked';
    } else if (isExpired) {
      statusBadge = '<span class="status-badge expired">⏰ 已過期</span>';
      statusClass = 'expired';
    } else {
      statusBadge = '<span class="status-badge active">✅ 有效</span>';
      statusClass = 'active';
    }
    
    const expiryText = token.expiresAt
      ? (isExpired ? `已於 ${formatDate(token.expiresAt)} 過期` : `${formatDate(token.expiresAt)} 到期`)
      : '永不過期';
    
    return `
      <div class="token-item ${statusClass}" data-token-id="${token.id}">
        <div class="token-info">
          <div class="token-header">
            <span class="token-name">${escapeHtml(token.name)}</span>
            ${statusBadge}
          </div>
          <div class="token-meta">
            <span>📅 建立於 ${formatDate(token.createdAt)}</span>
            <span>⏰ ${expiryText}</span>
            ${token.allowedOrigins ? `<span>🌐 ${token.allowedOrigins.join(', ')}</span>` : ''}
          </div>
          <div class="token-preview">
            <code>${token.tokenPreview}</code>
          </div>
        </div>
        <div class="token-actions">
          ${!isRevoked ? `<button class="btn btn-warning btn-small revoke-btn" data-token-id="${token.id}">🚫 撤銷</button>` : ''}
          <button class="btn btn-danger btn-small delete-btn" data-token-id="${token.id}">🗑️ 刪除</button>
        </div>
      </div>
    `;
  }).join('');
  
  // 綁定事件監聽器（避免 inline event handlers）
  tokenListDiv.querySelectorAll('.revoke-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tokenId = btn.getAttribute('data-token-id');
      revokeToken(tokenId);
    });
  });
  
  tokenListDiv.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tokenId = btn.getAttribute('data-token-id');
      deleteToken(tokenId);
    });
  });
}

// 撤銷 Token（不刪除記錄，只標記為已撤銷）
// revokedTokenIds 新格式：Array<{ id: string, expiresAt: number | null }>
async function revokeToken(tokenId) {
  showConfirmDialog(
    '撤銷 Token',
    '確定要撤銷此 Token 嗎？撤銷後此 Token 將無法再使用，但記錄會保留。',
    async () => {
      const settings = await chrome.storage.local.get(['revokedTokenIds', 'savedTokens']);
      const revokedTokens = settings.revokedTokenIds || [];
      const savedTokens = settings.savedTokens || [];
      
      // 檢查是否已存在（相容新舊格式）
      const alreadyRevoked = revokedTokens.some(item =>
        typeof item === 'string' ? item === tokenId : item.id === tokenId
      );
      
      if (!alreadyRevoked) {
        // 從 savedTokens 中找到對應的 token 以取得 expiresAt
        const tokenInfo = savedTokens.find(t => t.id === tokenId);
        const expiresAt = tokenInfo?.expiresAt || null;
        
        // 使用新格式儲存
        revokedTokens.push({ id: tokenId, expiresAt });
        await chrome.storage.local.set({ revokedTokenIds: revokedTokens });
      }
      
      renderTokenList(savedTokens, revokedTokens);
      showStatus(tokenStatusDiv, 'Token 已撤銷', 'success');
    }
  );
}

// 刪除 Token（刪除記錄並撤銷）
// revokedTokenIds 新格式：Array<{ id: string, expiresAt: number | null }>
async function deleteToken(tokenId) {
  showConfirmDialog(
    '刪除 Token',
    '確定要刪除此 Token 記錄嗎？刪除後此 Token 將被撤銷且記錄會被移除。',
    async () => {
      const settings = await chrome.storage.local.get(['savedTokens', 'revokedTokenIds']);
      const savedTokens = settings.savedTokens || [];
      const revokedTokens = settings.revokedTokenIds || [];
      
      // 從 savedTokens 中找到對應的 token 以取得 expiresAt（在移除前）
      const tokenInfo = savedTokens.find(t => t.id === tokenId);
      const expiresAt = tokenInfo?.expiresAt || null;
      
      // 從 savedTokens 中移除
      const updatedSavedTokens = savedTokens.filter(t => t.id !== tokenId);
      
      // 確保加入撤銷列表（即使記錄被刪除，token 仍然無效）
      // 檢查是否已存在（相容新舊格式）
      const alreadyRevoked = revokedTokens.some(item =>
        typeof item === 'string' ? item === tokenId : item.id === tokenId
      );
      
      if (!alreadyRevoked) {
        // 使用新格式儲存
        revokedTokens.push({ id: tokenId, expiresAt });
      }
      
      await chrome.storage.local.set({
        savedTokens: updatedSavedTokens,
        revokedTokenIds: revokedTokens
      });
      
      renderTokenList(updatedSavedTokens, revokedTokens);
      showStatus(tokenStatusDiv, 'Token 記錄已刪除', 'success');
    }
  );
}

// 格式化日期
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// HTML 跳脫
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 初始化
init();
