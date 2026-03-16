// background.js - Service Worker 處理工作流程執行

const DEFAULT_TIMEOUT_MS = 30000;

// ============================================
// JWT 驗證工具函式（內嵌版本，供 Service Worker 使用）
// ============================================

/**
 * Base64URL 編碼
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {string}
 */
function base64UrlEncode(data) {
  let bytes;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = data;
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64URL 解碼
 * @param {string} str
 * @returns {Uint8Array}
 */
function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 驗證 HMAC-SHA256 簽名
 * @param {string} data - 原始資料
 * @param {string} signature - Base64URL 編碼的簽名
 * @param {string} secret - Base64URL 編碼的密鑰
 * @returns {Promise<boolean>}
 */
async function hmacVerify(data, signature, secret) {
  const encoder = new TextEncoder();
  const keyData = base64UrlDecode(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signatureBytes = base64UrlDecode(signature);

  return await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(data)
  );
}

/**
 * 驗證 JWT Token
 * @param {string} token - JWT Token
 * @param {string} secret - Base64URL 編碼的密鑰
 * @param {string} origin - 請求來源（可選）
 * @param {string[]} allowedIssuers - 允許的發行者列表（可選，預設為 ['https://www.gss.com.tw']）
 * @returns {Promise<Object>} - 驗證結果 { valid: boolean, payload?: Object, error?: string }
 */
async function verifyJWT(token, secret, origin = null, allowedIssuers = ['https://www.gss.com.tw']) {
  try {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Token is required' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid token format' };
    }

    const [headerEncoded, payloadEncoded, signature] = parts;

    // 驗證簽名
    const dataToVerify = `${headerEncoded}.${payloadEncoded}`;
    const isValid = await hmacVerify(dataToVerify, signature, secret);

    if (!isValid) {
      return { valid: false, error: 'Invalid signature' };
    }

    // 解析 payload
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadEncoded));
    const payload = JSON.parse(payloadJson);

    // 檢查過期時間
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token expired', payload };
    }

    // 檢查發行者（支援多個允許的發行者）
    if (allowedIssuers && allowedIssuers.length > 0) {
      if (!payload.iss || !allowedIssuers.includes(payload.iss)) {
        return { valid: false, error: 'Invalid issuer', payload };
      }
    }

    // 檢查允許的來源
    if (origin && payload.allowedOrigins && payload.allowedOrigins.length > 0) {
      const originMatches = payload.allowedOrigins.some(allowed => {
        // 支援萬用字元匹配
        if (allowed.includes('*')) {
          const regex = new RegExp('^' + allowed.replace(/\*/g, '.*') + '$');
          return regex.test(origin);
        }
        return origin === allowed || origin.startsWith(allowed);
      });

      if (!originMatches) {
        return { valid: false, error: 'Origin not allowed', payload };
      }
    }

    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// ============================================
// 密鑰解密相關函式（內嵌版本，供 Service Worker 使用）
// ============================================

/**
 * 從 Extension ID 衍生加密密鑰
 * 使用 PBKDF2 從 Extension ID 衍生出 AES 密鑰
 * @param {string} extensionId - Chrome Extension ID
 * @returns {Promise<CryptoKey>} - AES-GCM 密鑰
 */
async function deriveEncryptionKey(extensionId) {
  const encoder = new TextEncoder();

  // 使用 Extension ID 作為密碼
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(extensionId),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // 使用固定的 salt（因為 Extension ID 本身就是唯一的）
  const salt = encoder.encode('https://www.gss.com.tw-salt-v1');

  // 衍生 AES-GCM 密鑰
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 解密 JWT 密鑰
 * @param {string} encryptedData - 加密後的資料（Base64URL 編碼，包含 IV）
 * @param {string} extensionId - Chrome Extension ID
 * @returns {Promise<string>} - 解密後的 JWT 密鑰（Base64URL 編碼）
 */
async function decryptSecretKey(encryptedData, extensionId) {
  const encryptionKey = await deriveEncryptionKey(extensionId);

  // 解碼 Base64URL
  const combined = base64UrlDecode(encryptedData);

  // 分離 IV 和加密資料
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  // 解密
  const decryptedData = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    encryptionKey,
    ciphertext
  );

  return new TextDecoder().decode(decryptedData);
}

/**
 * 檢查密鑰是否已加密
 * 加密後的資料會比原始密鑰長（包含 IV 和認證標籤）
 * @param {string} data - 要檢查的資料
 * @returns {boolean} - 是否為加密格式
 */
function isEncryptedSecretKey(data) {
  if (!data || typeof data !== 'string') {
    return false;
  }

  try {
    const decoded = base64UrlDecode(data);
    // 加密後的資料至少包含 12 bytes IV + 16 bytes auth tag + 原始資料
    // 原始密鑰通常是 32 bytes，加密後至少 60 bytes
    return decoded.length >= 60;
  } catch (e) {
    return false;
  }
}

/**
 * 解密儲存的密鑰
 * 相容舊格式（未加密）和新格式（已加密）
 * @param {string} storedKey - 儲存的密鑰（可能已加密或未加密）
 * @returns {Promise<string>} - 解密後的密鑰
 */
async function decryptStoredSecretKey(storedKey) {
  // 檢查是否為加密格式
  if (isEncryptedSecretKey(storedKey)) {
    // 已加密，需要解密
    return await decryptSecretKey(storedKey, chrome.runtime.id);
  }
  // 舊格式（未加密），直接返回
  return storedKey;
}

/**
 * 驗證外部請求的 JWT
 * @param {Object} message - 訊息物件，應包含 token 欄位
 * @param {string} senderUrl - 發送者 URL
 * @returns {Promise<Object>} - { authorized: boolean, error?: string }
 */
async function authorizeExternalRequest(message, senderUrl) {
  // 取得設定
  const settings = await chrome.storage.local.get(['jwtEnabled', 'jwtSecretKey', 'revokedTokenIds', 'allowedIssuers']);

  // 如果 JWT 驗證未啟用，直接允許
  if (settings.jwtEnabled === false) {
    console.log('[JWT] JWT 驗證已停用，允許請求');
    return { authorized: true };
  }

  // 如果沒有設定密鑰，拒絕請求
  if (!settings.jwtSecretKey) {
    console.warn('[JWT] 未設定 JWT 密鑰，拒絕請求');
    return { authorized: false, error: 'JWT secret key not configured. Please configure it in extension options.' };
  }

  // 解密密鑰
  let secretKey;
  try {
    secretKey = await decryptStoredSecretKey(settings.jwtSecretKey);
  } catch (error) {
    console.error('[JWT] 密鑰解密失敗:', error);
    return { authorized: false, error: 'Failed to decrypt secret key' };
  }

  // 檢查 token
  const token = message.token;
  if (!token) {
    console.warn('[JWT] 請求未提供 token');
    return { authorized: false, error: 'JWT token is required' };
  }

  // 解析來源
  let origin = null;
  try {
    if (senderUrl) {
      const url = new URL(senderUrl);
      origin = url.origin;
    }
  } catch (e) {
    // 忽略解析錯誤
  }

  // 取得允許的發行者列表（預設為 ['https://www.gss.com.tw']）
  const allowedIssuers = settings.allowedIssuers && settings.allowedIssuers.length > 0
    ? settings.allowedIssuers
    : ['https://www.gss.com.tw'];

  // 驗證 token
  const result = await verifyJWT(token, secretKey, origin, allowedIssuers);

  if (!result.valid) {
    console.warn('[JWT] Token 驗證失敗:', result.error);
    return { authorized: false, error: `JWT verification failed: ${result.error}` };
  }

  // 檢查 Token 是否已被撤銷
  // revokedTokenIds 格式：Array<{ id: string, expiresAt: number | null }>
  // 相容舊格式：Array<string>
  const revokedTokens = settings.revokedTokenIds || [];
  const tokenId = result.payload?.tid;

  if (tokenId) {
    const isRevoked = revokedTokens.some(item => {
      // 相容舊格式（純字串）
      if (typeof item === 'string') {
        return item === tokenId;
      }
      // 新格式（物件）
      return item.id === tokenId;
    });

    if (isRevoked) {
      console.warn('[JWT] Token 已被撤銷:', tokenId);
      return { authorized: false, error: 'Token has been revoked' };
    }
  }

  // 清理已過期的撤銷 Token ID（非同步執行，不阻塞驗證流程）
  cleanupExpiredRevokedTokenIds(revokedTokens);

  console.log('[JWT] Token 驗證成功:', result.payload?.name || 'unnamed');
  return { authorized: true, payload: result.payload };
}

/**
 * 清理已過期的撤銷 Token ID
 * 當 token 已過期時，即使不在撤銷列表中也無法使用，因此可以安全移除
 * revokedTokenIds 格式：Array<{ id: string, expiresAt: number | null }>
 * 相容舊格式：Array<string>（舊格式無法判斷過期，會保留）
 * @param {Array<Object|string>} revokedTokens - 已撤銷的 Token 列表
 */
async function cleanupExpiredRevokedTokenIds(revokedTokens) {
  if (!revokedTokens || revokedTokens.length === 0) {
    return;
  }

  const now = Date.now();

  // 過濾出尚未過期的撤銷 Token
  const validRevokedTokens = revokedTokens.filter(item => {
    // 相容舊格式（純字串）- 無法判斷過期，保留
    if (typeof item === 'string') {
      return true;
    }

    // 新格式（物件）
    // 如果沒有過期時間（永不過期），保留
    if (!item.expiresAt) {
      return true;
    }

    // 如果已過期，可以移除
    if (item.expiresAt < now) {
      console.log(`[JWT] 清理已過期的撤銷 Token ID: ${item.id}`);
      return false;
    }

    // 尚未過期，保留
    return true;
  });

  // 如果有變化，更新儲存
  if (validRevokedTokens.length !== revokedTokens.length) {
    const removedCount = revokedTokens.length - validRevokedTokens.length;
    console.log(`[JWT] 已清理 ${removedCount} 個過期的撤銷 Token ID`);

    await chrome.storage.local.set({ revokedTokenIds: validRevokedTokens });
  }
}

// ============================================
// 原有的工作流程執行邏輯
// ============================================

// 替換變數
function replaceVariables(text, variables) {
  if (typeof text !== 'string') return text;

  var result = text.replace(/\{\{([\w.]+)\}\}/g, (match, varPath) => {
    // 支援嵌套屬性，例如 user.name
    const parts = varPath.split('.');
    let current = variables;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return match;
      }
      current = current[part];
    }

    return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : match;
  });
  return result;
}

// 等待指定時間（短時間使用 setTimeout，長時間使用 chrome.alarms）
function delay(ms) {
  console.log(`[delay] 開始等待 ${ms} 毫秒`);

  // 對於短時間等待（小於 25 秒），使用 setTimeout
  // 對於長時間等待，使用 chrome.alarms 以避免 Service Worker 被終止
  if (ms < 25000) {
    return new Promise(resolve => {
      setTimeout(() => {
        console.log(`[delay] setTimeout 完成，${ms} 毫秒已過`);
        resolve();
      }, ms);
    });
  } else {
    return new Promise(resolve => {
      const alarmName = `delay_${Date.now()}_${Math.random()}`;
      console.log(`[delay] 使用 chrome.alarms，alarm name: ${alarmName}`);

      const listener = (alarm) => {
        if (alarm.name === alarmName) {
          console.log(`[delay] chrome.alarms 完成，${ms} 毫秒已過`);
          chrome.alarms.onAlarm.removeListener(listener);
          resolve();
        }
      };

      chrome.alarms.onAlarm.addListener(listener);
      chrome.alarms.create(alarmName, { delayInMinutes: ms / 60000 });
    });
  }
}

// 等待 tab 載入完成
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (tab && tab.status === 'complete') {
        return resolve(tab);
      }

      let resolved = false;
      let fallbackInterval;

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearInterval(fallbackInterval);
        reject(new Error('Tab 載入超時'));
      }, DEFAULT_TIMEOUT_MS); // 30 秒超時

      const listener = (updatedTabId, changeInfo, tab) => {
        if (resolved) return;
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          resolved = true;
          clearTimeout(timeout);
          clearInterval(fallbackInterval);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);

      // 追加 fallback 檢查：
      // 避免因為 iframe (如 X-Frame-Options 阻擋) 導致 Tab status 卡在 loading，
      // 透過 executeScript 定期檢查主文件 document.readyState。
      fallbackInterval = setInterval(async () => {
        if (resolved) return;
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.readyState
          });
          if (results && results[0] && (results[0].result === 'complete' || results[0].result === 'interactive')) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            clearInterval(fallbackInterval);
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.get(tabId, (t) => resolve(t || tab));
          }
        } catch (e) {
          // ignore error
        }
      }, 1000);
    });
  });
}

// 在 tab 中執行腳本（可選擇執行 world）
// world: 'MAIN' => 注入到 page context（透過 <script> 或 chrome.scripting 的 world），否則在 extension isolated world 執行
async function executeInTab(tabId, func, args = [], world = 'ISOLATED') {
  try {
    const options = {
      target: { tabId },
      func,
      args
    };
    if (world === 'MAIN') {
      options.world = 'MAIN';
    }

    const results = await chrome.scripting.executeScript(options);
    return results[0]?.result;
  } catch (error) {
    throw new Error(`腳本執行失敗: ${error.message}`);
  }
}

// 注入並設定 dialog 處理（alert/confirm/prompt）
// 盡可能在 page main world 直接覆寫原生方法；若未成功則嘗試多次注入，最後 fallback 到 isolated world
async function setupDialogHandling(tabId, mode = 'autoAccept') {
  // mode: 'autoAccept' | 'autoDismiss' | 'reportOnly'

  // 嘗試多次注入到 MAIN world，增加成功率（頁面可能在載入時覆蓋 window.alert）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await executeInTab(tabId, (m) => {
        try {
          if (window.__rpaDialogInstrumented && window.__rpaDialogMode === m) return { success: true };
          window.__rpaDialogInstrumented = true;
          window.__rpaDialogMode = m;
          window.__rpaLastDialog = null;

          const originalAlert = window.alert;
          const originalConfirm = window.confirm;
          const originalPrompt = window.prompt;

          window.alert = function (msg) {
            try { window.__rpaLastDialog = { type: 'alert', message: String(msg), timestamp: Date.now() }; } catch (e) { }
            if (m === 'reportOnly') return originalAlert.call(window, msg);
            return undefined;
          };
          window.confirm = function (msg) {
            try { window.__rpaLastDialog = { type: 'confirm', message: String(msg), timestamp: Date.now() }; } catch (e) { }
            if (m === 'reportOnly') return originalConfirm.call(window, msg);
            if (m === 'autoAccept') return true;
            if (m === 'autoDismiss') return false;
            return false;
          };
          window.prompt = function (msg, def) {
            try { window.__rpaLastDialog = { type: 'prompt', message: String(msg), defaultValue: def, timestamp: Date.now() }; } catch (e) { }
            if (m === 'reportOnly') return originalPrompt.call(window, msg, def);
            if (m === 'autoAccept') return def || '';
            if (m === 'autoDismiss') return null;
            return null;
          };

          return { success: true };
        } catch (e) {
          return { success: false, error: e && e.message };
        }
      }, [mode], 'MAIN');

      if (res && res.success) return res;
    } catch (e) {
      // ignore and retry
    }

    // 等一點時間再試（讓頁面載入或其它腳本完成覆蓋）
    await delay(200);
  }

  // 最後 fallback 到 isolated world 的覆寫（雖然對某些頁面可能無效）
  try {
    const fallback = await executeInTab(tabId, (m) => {
      try {
        if (window.__rpaDialogInstrumented && window.__rpaDialogMode === m) return { success: true };
        window.__rpaDialogInstrumented = true;
        window.__rpaDialogMode = m;
        window.__rpaLastDialog = null;

        const originalAlert = window.alert;
        const originalConfirm = window.confirm;
        const originalPrompt = window.prompt;

        window.alert = function (msg) {
          try { window.__rpaLastDialog = { type: 'alert', message: String(msg), timestamp: Date.now() }; } catch (e) { }
          if (m === 'reportOnly') return originalAlert.call(window, msg);
          return undefined;
        };
        window.confirm = function (msg) {
          try { window.__rpaLastDialog = { type: 'confirm', message: String(msg), timestamp: Date.now() }; } catch (e) { }
          if (m === 'reportOnly') return originalConfirm.call(window, msg);
          if (m === 'autoAccept') return true;
          if (m === 'autoDismiss') return false;
          return false;
        };
        window.prompt = function (msg, def) {
          try { window.__rpaLastDialog = { type: 'prompt', message: String(msg), defaultValue: def, timestamp: Date.now() }; } catch (e) { }
          if (m === 'reportOnly') return originalPrompt.call(window, msg, def);
          if (m === 'autoAccept') return def || '';
          if (m === 'autoDismiss') return null;
          return null;
        };

        return { success: true };
      } catch (e) {
        return { success: false, error: e && e.message };
      }
    }, [mode]);

    return fallback;
  } catch (e) {
    return { success: false, error: e && e.message };
  }
}

// 執行 goto 動作 - 開新 tab
// 新增 dialogMode 參數（'autoAccept' | 'autoDismiss' | 'reportOnly'）
async function executeGoto(url, context, dialogMode = 'autoAccept', active = true) {
  const tab = await chrome.tabs.create({ url, active });

  // 盡早嘗試注入 dialog 處理（在 navigation 前嘗試覆寫），提高攔截在 page 載入過程中發生的 alert/confirm 的機率
  try {
    await setupDialogHandling(tab.id, dialogMode);
  } catch (e) {
    console.warn('[setupDialogHandling] 早期注入失敗:', e && e.message);
  }

  // 等待頁面載入完成
  await waitForTabLoad(tab.id);

  // 再次嘗試注入以確保覆寫（某些頁面在載入過程會覆蓋 window.alert）
  try {
    await setupDialogHandling(tab.id, dialogMode);
  } catch (e) {
    console.warn('[setupDialogHandling] 後期注入失敗:', e && e.message);
  }

  // 額外等待一下確保頁面完全載入
  await delay(500);

  return {
    success: true,
    tabId: tab.id,
    url: tab.url,
    title: tab.title
  };
}

// 執行 click 動作（改進版：處理可能的 navigation、AJAX 及 dialog）
async function executeClick(tabId, selector, dialogMode = 'autoAccept') {
  try {
    // 注入 dialog 處理（若需要）到 page 主世界
    try {
      await setupDialogHandling(tabId, dialogMode, 'MAIN');
    } catch (e) {
      console.warn('[executeClick] setupDialogHandling 注入失敗:', e && e.message);
    }

    // 1) 先在頁面內注入簡單的 network instrumentation（如果尚未注入）
    await executeInTab(tabId, () => {
      try {
        if (window.__rpaNetworkInstrumented) return { success: true };
        window.__rpaNetworkInstrumented = true;
        window.__rpaActiveRequests = 0;

        // 包裝 fetch
        if (window.fetch) {
          const _fetch = window.fetch.bind(window);
          window.fetch = function (...args) {
            window.__rpaActiveRequests++;
            return _fetch(...args).finally(() => {
              try { window.__rpaActiveRequests--; } catch (e) { }
            });
          };
        }

        // 包裝 XMLHttpRequest
        try {
          const _XHR = window.XMLHttpRequest;
          function WrappedXHR() {
            const xhr = new _XHR();
            const origOpen = xhr.open;
            xhr.addEventListener('loadstart', () => { window.__rpaActiveRequests++; });
            xhr.addEventListener('loadend', () => { window.__rpaActiveRequests--; });
            return xhr;
          }
          // 嘗試替換（部分頁面可能會阻擋或不可改寫）
          try { window.XMLHttpRequest = WrappedXHR; } catch (e) { }
        } catch (e) { }

        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 2) 取得 click 前的 URL
    const tabBefore = await chrome.tabs.get(tabId);
    const prevUrl = tabBefore?.url;

    // 3) 在頁面內執行 click，同時回傳元素基本資訊（是否為連結或可能觸發 form submit）
    const clickResult = await executeInTab(tabId, (sel) => {
      const element = document.querySelector(sel);
      if (!element) {
        return { success: false, error: `找不到元素: ${sel}` };
      }

      const tagName = element.tagName;
      const isAnchor = tagName === 'A' && element.href;
      const form = element.closest ? element.closest('form') : null;
      const willSubmitForm = !!form;

      element.click();

      return {
        success: true,
        tagName,
        text: element.textContent?.substring(0, 100),
        isAnchor: !!isAnchor,
        willSubmitForm
      };
    }, [selector]);

    if (!clickResult || !clickResult.success) {
      return clickResult;
    }

    // 4) 嘗試偵測是否發生 navigation（URL 改變或 tab 進入 loading 狀態）
    const navigationDetected = await (async () => {
      const timeoutMs = 5000; // 偵測 timeframe
      const pollInterval = 200;
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const t = await chrome.tabs.get(tabId);
        if (!t) break;
        if (t.url !== prevUrl || t.status === 'loading') {
          try {
            // 等到載入完成
            await waitForTabLoad(tabId);
          } catch (e) {
            // 若等待失敗（timeout 等），仍視為有 navigation 發生
          }
          return true;
        }
        await new Promise(r => setTimeout(r, pollInterval));
      }
      return false;
    })();

    if (navigationDetected) {
      // navigation 完成後略為等待以確保資源載入
      await delay(500);

      // 取得可能的最後一個 dialog 訊息
      const lastDialog = await executeInTab(tabId, () => {
        try { return window.__rpaLastDialog || null; } catch (e) { return null; }
      });

      return { ...clickResult, navigation: true, lastDialog, success: true };
    }

    // 5) 若沒有 navigation，等待 network idle（使用先前注入的 instrumentation）
    const networkIdleResult = await executeInTab(tabId, (idleTimeoutMs = 10000, idleWindow = 500) => {
      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      return (async () => {
        if (typeof window.__rpaActiveRequests !== 'number') {
          // 未能注入 instrumentation，直接回傳
          return { waited: false, reason: 'noInstrumentation' };
        }

        const start = Date.now();
        let lastZeroTime = null;

        while (Date.now() - start < idleTimeoutMs) {
          const cnt = window.__rpaActiveRequests;
          if (cnt === 0) {
            if (lastZeroTime === null) lastZeroTime = Date.now();
            if (Date.now() - lastZeroTime >= idleWindow) {
              return { waited: true };
            }
          } else {
            lastZeroTime = null;
          }
          await sleep(100);
        }

        return { waited: false, reason: 'timeout' };
      })();
    }, [10000, 500]);

    // 取得可能的最後一個 dialog 訊息
    const lastDialog = await executeInTab(tabId, () => {
      try { return window.__rpaLastDialog || null; } catch (e) { return null; }
    });

    return { ...clickResult, navigation: false, networkIdle: networkIdleResult, lastDialog, success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 執行 typeText 動作
async function executeTypeText(tabId, selector, text) {
  try {
    const result = await executeInTab(tabId, (sel, txt) => {
      const element = document.querySelector(sel);
      if (!element) {
        return { success: false, error: `找不到元素: ${sel}` };
      }

      // 聚焦元素
      element.focus();

      // 設定值
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        element.value = txt;
        // 觸發 input 事件
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = txt;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        return { success: false, error: `元素不支援輸入: ${sel}` };
      }

      return {
        success: true,
        inputText: txt,
        tagName: element.tagName
      };
    }, [selector, text]);

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 執行上下文 - 每個分支維護自己的上下文
 * @typedef {Object} ExecutionContext
 * @property {number|null} tabId - 當前分支的 tab ID
 * @property {Object} variables - 變數
 * @property {Object} nodeResults - 各節點的執行結果
 * @property {string} branchId - 分支 ID
 */

/**
 * 建立新的執行上下文
 * @param {Object} variables - 初始變數
 * @param {string} branchId - 分支 ID
 * @returns {ExecutionContext}
 */
function createExecutionContext(variables = {}, branchId = 'main') {
  let cancelResolve;
  const cancelPromise = new Promise((_, reject) => {
    cancelResolve = reject;
  });

  return {
    tabId: null,
    variables: { ...variables },
    nodeResults: {},
    branchId,
    isCancelled: false,
    cancelPromise,
    cancelResolve
  };
}

/**
 * 複製執行上下文（用於分支）
 * @param {ExecutionContext} context - 原始上下文
 * @param {string} newBranchId - 新分支 ID
 * @returns {ExecutionContext}
 */
function cloneExecutionContext(context, newBranchId) {
  return {
    tabId: context.tabId,
    variables: { ...context.variables },
    nodeResults: { ...context.nodeResults },
    branchId: newBranchId,
    get isCancelled() { return context.isCancelled; },
    set isCancelled(val) { context.isCancelled = val; },
    cancelPromise: context.cancelPromise,
    cancelResolve: context.cancelResolve
  };
}

/**
 * 執行單一節點
 * @param {Object} node - 節點
 * @param {ExecutionContext} context - 執行上下文
 * @returns {Promise<Object>} - 執行結果（不會拋出 exception，錯誤會放在 result.success = false）
 */
async function executeNode(node, context) {
  if (context.isCancelled) {
    return {
      success: false,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      timestamp: Date.now(),
      originalParameters: node.parameters,
      executeTimeout: DEFAULT_TIMEOUT_MS,
      error: '工作流程已取消',
      cancelled: true
    };
  }

  // 取得節點設定的 timeout (預設 DEFAULT_TIMEOUT_MS 毫秒)
  const timeoutMs = node.parameters?.timeout ? parseInt(node.parameters.timeout, 10) : DEFAULT_TIMEOUT_MS;

  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`節點執行超時 (${timeoutMs}ms)`));
    }, timeoutMs);
    context.currentTimer = timer;
  });

  try {
    const result = await Promise.race([
      executeNodeInner(node, context),
      timeoutPromise,
      context.cancelPromise
    ]);
    if (context.currentTimer) clearTimeout(context.currentTimer);
    if (result && typeof result === 'object') {
      result.executeTimeout = timeoutMs;
    }
    return result;
  } catch (error) {
    if (context.currentTimer) clearTimeout(context.currentTimer);

    // 如果是取消引發的 reject
    if (error.message === 'CANCELLED') {
      return {
        success: false,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        timestamp: Date.now(),
        originalParameters: node.parameters,
        executeTimeout: timeoutMs,
        error: '工作流程已取消',
        cancelled: true
      };
    }

    return {
      success: false,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      timestamp: Date.now(),
      originalParameters: node.parameters,
      executeTimeout: timeoutMs,
      error: error.message || '未知錯誤'
    };
  }
}

/**
 * 執行 sandboxScript
 */
async function executeSandboxScript(script, previousResult, inputData, variables, timeoutMs = 30000) {
  const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
  if (chrome.offscreen) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });
    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['DOM_PARSER'],
        justification: 'Execute sandboxed scripts'
      }).catch(e => {
        // 如果已經存在或發生錯誤，忽略
      });
    }
  }

  return new Promise((resolve) => {
    const messageId = Date.now().toString() + Math.random().toString();

    let timerId = setTimeout(() => {
      resolve({
        success: false,
        error: 'Sandbox 腳本執行超時'
      });
    }, timeoutMs);

    chrome.runtime.sendMessage({
      type: 'EXECUTE_SANDBOX_SCRIPT',
      id: messageId,
      script,
      previousResult,
      inputData,
      variables
    }).then((response) => {
      clearTimeout(timerId);
      if (response && response.success) {
        resolve({
          success: true,
          data: response.data,
          inputData: response.inputData,
          variables: response.variables,
          message: 'Sandbox 腳本執行成功'
        });
      } else {
        resolve({
          success: false,
          error: (response && response.error) || 'Sandbox 腳本執行錯誤'
        });
      }
    }).catch(err => {
      clearTimeout(timerId);
      resolve({
        success: false,
        error: `無法傳送訊息到 Sandbox: ${err.message}`
      });
    });
  });
}

/**
 * 內部執行單一節點的核心邏輯
 */
async function executeNodeInner(node, context) {
  const type = node.type;
  const params = node.parameters || {};
  const variables = context.variables;

  let result;

  try {
    switch (type) {
      case 'start':
        result = {
          success: true,
          type: 'start',
          message: '工作流程開始'
        };
        break;

      case 'end':
        if (params.autoCloseTab && context.tabId) {
          try {
            await chrome.tabs.remove(context.tabId);
            console.log(`[${context.branchId}] 工作流程結束，已自動關閉 tab: ${context.tabId}`);
          } catch (e) {
            console.warn(`[${context.branchId}] 工作流程結束，自動關閉 tab 失敗: ${e.message}`);
          }
        }
        result = {
          success: true,
          type: 'end',
          message: '工作流程結束'
        };
        break;

      case 'goto': {
        const url = replaceVariables(params.url, variables);
        if (!url) {
          result = { success: false, error: 'goto 節點缺少 url 參數' };
          break;
        }
        try {
          // 支援在 goto 節點設定 dialogMode（autoAccept/autoDismiss/reportOnly）
          const dialogMode = replaceVariables(params.dialogMode || 'autoAccept', variables);
          const runInBackground = params.background === true || params.background === 'true';
          result = await executeGoto(url, context, dialogMode, !runInBackground);
          // 更新上下文的 tabId
          if (result.success) {
            context.tabId = result.tabId;
          }
        } catch (error) {
          result = { success: false, error: error.message };
        }
        break;
      }

      case 'click': {
        const selector = replaceVariables(params.selector, variables);
        if (!selector) {
          result = { success: false, error: 'click 節點缺少 selector 參數' };
          break;
        }
        if (!context.tabId) {
          result = { success: false, error: '沒有可用的 tab，請先執行 goto 動作' };
          break;
        }
        // 支援在 click 節點設定 dialogMode（autoAccept/autoDismiss/reportOnly）
        const dialogMode = replaceVariables(params.dialogMode || 'autoAccept', variables);
        result = await executeClick(context.tabId, selector, dialogMode);
        break;
      }

      case 'typeText': {
        const selector = replaceVariables(params.selector, variables);
        const text = replaceVariables(params.text, variables);
        if (!selector) {
          result = { success: false, error: 'typeText 節點缺少 selector 參數' };
          break;
        }
        if (!context.tabId) {
          result = { success: false, error: '沒有可用的 tab，請先執行 goto 動作' };
          break;
        }
        result = await executeTypeText(context.tabId, selector, text);
        break;
      }

      case 'wait': {
        // duration 參數，以毫秒為單位
        let waitTime = 0;

        if (params.duration !== undefined) {
          waitTime = parseInt(replaceVariables(String(params.duration), variables), 10);
        } else {
          result = { success: false, error: 'wait 節點缺少 duration 參數' };
          break;
        }

        if (isNaN(waitTime) || waitTime < 0) {
          result = { success: false, error: 'wait 節點的 duration 必須是有效的正整數（毫秒）' };
          break;
        }

        console.log(`[wait] 開始等待 ${waitTime} 毫秒...`);
        await delay(waitTime);
        console.log(`[wait] 等待完成，繼續執行下一個節點`);
        result = {
          success: true,
          type: 'wait',
          waitTime,
          message: `已等待 ${waitTime} 毫秒`
        };
        break;
      }

      case 'extractData': {
        const selector = replaceVariables(params.selector, variables);
        const outputVariable = params.outputVariable;

        if (!selector) {
          result = { success: false, error: 'extractData 節點缺少 selector 參數' };
          break;
        }
        if (!context.tabId) {
          result = { success: false, error: '沒有可用的 tab，請先執行 goto 動作' };
          break;
        }

        try {
          result = await executeInTab(context.tabId, (sel) => {
            const element = document.querySelector(sel);
            if (!element) {
              return { success: false, error: `找不到元素: ${sel}` };
            }

            // 根據元素類型取得內容
            let extractedData;
            const tagName = element.tagName.toUpperCase();

            if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
              extractedData = element.value;
            } else if (tagName === 'SELECT') {
              extractedData = element.value;
            } else if (tagName === 'IMG') {
              extractedData = element.src;
            } else if (tagName === 'A') {
              extractedData = {
                text: element.textContent?.trim(),
                href: element.href
              };
            } else {
              extractedData = element.textContent?.trim();
            }

            return {
              success: true,
              data: extractedData,
              tagName: tagName,
              selector: sel
            };
          }, [selector]);

          // 如果成功且有指定輸出變數名稱，將資料存入變數
          if (result.success && outputVariable) {
            context.variables[outputVariable] = result.data;
            result.outputVariable = outputVariable;
            result.data = { [outputVariable]: result.data };
          }

          if (result.success) {
            result.type = 'extractData';
            result.message = `已從 ${selector} 擷取資料`;
          }
        } catch (error) {
          result = { success: false, error: error.message };
        }
        break;
      }

      case 'extractWebContent': {
        const startSelector = replaceVariables(params.startSelector, variables);
        const endSelector = replaceVariables(params.endSelector, variables);
        const contentType = replaceVariables(params.contentType || 'html', variables);
        const outputVariable = params.outputVariable;

        if (!startSelector || !endSelector) {
          result = { success: false, error: 'extractWebContent 節點缺少 startSelector 或 endSelector 參數' };
          break;
        }
        if (!context.tabId) {
          result = { success: false, error: '沒有可用的 tab，請先執行 goto 動作' };
          break;
        }

        try {
          result = await executeInTab(context.tabId, (startSel, endSel, cType) => {
            try {
              const startNode = document.querySelector(startSel);
              const endNode = document.querySelector(endSel);

              if (!startNode || !endNode) {
                return { success: false, error: `找不到起始或結束元素` };
              }

              function findTextNodes(element) {
                const textNodes = [];
                const walker = document.createTreeWalker(
                  element,
                  NodeFilter.SHOW_TEXT,
                  { acceptNode: function (node) { return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } }
                );
                let node;
                while (node = walker.nextNode()) textNodes.push(node);
                return textNodes;
              }

              const startTextNodes = findTextNodes(startNode);
              const endTextNodes = findTextNodes(endNode);

              const range = document.createRange();
              const startTextNode = startTextNodes.length ? startTextNodes[0] : startNode;
              const endTextNode = endTextNodes.length ? endTextNodes[endTextNodes.length - 1] : endNode;

              range.setStartBefore(startTextNode);

              if (endTextNode.nodeType === 3) {
                range.setEnd(endTextNode, endTextNode.length);
              } else {
                range.setEndAfter(endTextNode);
              }

              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);

              const container = document.createElement('div');
              container.appendChild(range.cloneContents());

              let extractedData = '';
              if (cType === 'html') {
                extractedData = container.innerHTML;
              } else {
                // markdown
                function nodeToMarkdown(node) {
                  if (node.nodeType === Node.TEXT_NODE) {
                    return node.textContent;
                  } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName.toLowerCase() === 'A') {
                      const href = node.getAttribute('href') || '';
                      const text = Array.from(node.childNodes).map(child => nodeToMarkdown(child)).join('');
                      return `[${text}](${href})`;
                    } else if (node.tagName.toLowerCase() === 'IMG') {
                      const alt = node.getAttribute('alt') || 'image';
                      const src = node.getAttribute('src') || '';
                      return `![${alt}](${src})`;
                    } else {
                      return Array.from(node.childNodes).map(child => nodeToMarkdown(child)).join('');
                    }
                  }
                  return '';
                }

                let markdown = nodeToMarkdown(container);
                const lines = markdown.split('\n');
                const processedLines = [];
                let lastLineEmpty = false;
                for (let line of lines) {
                  const trimmedLine = line.trim();
                  const isEmpty = trimmedLine === '' || /^[ \t]+$/.test(trimmedLine);
                  if (isEmpty) {
                    if (!lastLineEmpty) {
                      processedLines.push('');
                      lastLineEmpty = true;
                    }
                  } else {
                    processedLines.push(trimmedLine);
                    lastLineEmpty = false;
                  }
                }
                extractedData = processedLines.join('\n');
              }

              selection.removeAllRanges();
              return { success: true, data: extractedData };
            } catch (error) {
              return { success: false, error: error.message };
            }
          }, [startSelector, endSelector, contentType]);

          if (result.success && outputVariable) {
            context.variables[outputVariable] = result.data;
            result.outputVariable = outputVariable;
            result.data = { [outputVariable]: result.data };
          }
          if (result.success) {
            result.type = 'extractWebContent';
            result.message = `已根據範圍擷取內容`;
          }
        } catch (error) {
          result = { success: false, error: error.message };
        }
        break;
      }

      case 'checkExists': {
        const selector = replaceVariables(params.selector, variables);
        const outputVariable = params.outputVariable;

        if (!selector) {
          result = { success: false, error: 'checkExists 節點缺少 selector 參數' };
          break;
        }
        if (!context.tabId) {
          result = { success: false, error: '沒有可用的 tab，請先執行 goto 動作' };
          break;
        }

        try {
          // 在網頁上檢查特定 Selector 是否存在
          result = await executeInTab(context.tabId, (sel) => {
            const el = document.querySelector(sel);
            return {
              success: true,
              data: el !== null
            };
          }, [selector]);

          if (result.success && outputVariable) {
            context.variables[outputVariable] = result.data;
            result.outputVariable = outputVariable;
            result.data = { [outputVariable]: result.data };
          }
          if (result.success) {
            result.type = 'checkExists';
            result.message = `元素 ${selector} 存在檢查結果: ${(result.data && outputVariable ? result.data[outputVariable] : result.data) ? '存在' : '不存在'}`;
          }
        } catch (error) {
          result = { success: false, error: error.message };
        }
        break;
      }

      case 'script': {
        // 執行 JavaScript 腳本節點
        // 腳本會接收兩個參數：
        // - result: 前一個節點的執行結果
        // - inputData: 工作流程的輸入資料
        // return 的值會被放到 result.data 上
        const script = params.script;
        const outputVariable = params.outputVariable;

        if (!script) {
          result = { success: false, error: 'script 節點缺少 script 參數' };
          break;
        }

        try {
          // 取得前一個節點的結果
          // 從 context.nodeResults 中找到最近執行的節點結果
          let previousResult = null;
          const nodeIds = Object.keys(context.nodeResults);
          if (nodeIds.length > 0) {
            const lastNodeId = nodeIds[nodeIds.length - 1];
            previousResult = context.nodeResults[lastNodeId];
          }

          // 取得 inputData（從 start 節點的參數或 context 中取得）
          const inputData = context.inputData || {};

          // 檢查是否有可用的 tab
          if (!context.tabId) {
            result = { success: false, error: 'script 節點需要先執行 goto 動作來開啟頁面' };
            break;
          }

          // 在頁面的 MAIN world 中執行腳本，繞過 CSP 限制
          // 將腳本包裝成一個立即執行函數
          result = await executeInTab(context.tabId, (scriptCode, prevResult, inputDataArg, variablesArg) => {
            try {
              // 使用 Function 建構子在頁面 context 中執行腳本
              const scriptFunction = new Function('result', 'inputData', 'variables', `
                "use strict";
                ${scriptCode}
              `);

              const scriptResult = scriptFunction(prevResult, inputDataArg, variablesArg);

              return {
                success: true,
                data: scriptResult,
                inputData: inputDataArg, // 把可能被修改的 inputData 傳回來
                variables: variablesArg, // 把可能被修改的 variables 傳回來
                message: '腳本執行成功'
              };
            } catch (error) {
              return {
                success: false,
                error: `腳本執行錯誤: ${error.message}`
              };
            }
          }, [script, previousResult, inputData, context.variables], 'MAIN');

          // 如果腳本修改了 inputData 或 variables，更新回 context
          if (result.success && result.inputData) {
            context.inputData = result.inputData;
          }
          if (result.success && result.variables) {
            Object.assign(context.variables, result.variables);
          }

          // 處理 Promise 結果（如果腳本返回 Promise）
          if (result.success && result.data instanceof Promise) {
            try {
              result.data = await result.data;
            } catch (error) {
              result = {
                success: false,
                error: `腳本 Promise 執行錯誤: ${error.message}`
              };
            }
          }

          if (result.success) {
            result.type = 'script';

            // 如果有指定輸出變數名稱，將資料存入變數
            if (outputVariable && result.data !== undefined) {
              context.variables[outputVariable] = result.data;
              result.outputVariable = outputVariable;
            }
          }
        } catch (error) {
          result = {
            success: false,
            type: 'script',
            error: `腳本執行錯誤: ${error.message}`
          };
        }
        break;
      }

      case 'sandboxScript': {
        // 執行 Extension Sandbox JavaScript 腳本節點
        const script = params.script;
        const outputVariable = params.outputVariable;

        if (!script) {
          result = { success: false, error: 'sandboxScript 節點缺少 script 參數' };
          break;
        }

        try {
          // 取得前一個節點的結果
          let previousResult = null;
          const nodeIds = Object.keys(context.nodeResults);
          if (nodeIds.length > 0) {
            const lastNodeId = nodeIds[nodeIds.length - 1];
            previousResult = context.nodeResults[lastNodeId];
          }

          // 取得 inputData
          const inputData = context.inputData || {};

          // 在 Sandbox 中執行
          const sandboxResult = await executeSandboxScript(script, previousResult, inputData, context.variables, params.timeout || DEFAULT_TIMEOUT_MS);

          if (sandboxResult.success) {
            result = sandboxResult;

            // 如果腳本修改了 inputData 或 variables，更新回 context
            if (result.inputData) {
              context.inputData = result.inputData;
            }
            if (result.variables) {
              Object.assign(context.variables, result.variables);
            }

            result.type = 'sandboxScript';

            // 如果有指定輸出變數名稱，將資料存入變數
            if (outputVariable && result.data !== undefined) {
              context.variables[outputVariable] = result.data;
              result.outputVariable = outputVariable;
              result.data = { [outputVariable]: result.data };
            }
          } else {
            result = {
              success: false,
              type: 'sandboxScript',
              error: sandboxResult.error
            };
          }
        } catch (error) {
          result = {
            success: false,
            type: 'sandboxScript',
            error: `Sandbox 腳本執行異常: ${error.message}`
          };
        }
        break;
      }

      default:
        console.warn(`未知的節點類型: ${type}`);
        result = {
          success: true,
          type: 'unknown',
          originalType: type,
          message: `未知的節點類型: ${type}`
        };
    }
  } catch (error) {
    // 捕獲任何未預期的錯誤
    result = {
      success: false,
      error: error.message || '未知錯誤'
    };
  }

  // 確保結果包含基本資訊
  result.nodeId = node.id;
  result.nodeName = node.name;
  result.nodeType = type;
  result.timestamp = Date.now();
  result.originalParameters = node.parameters; // 將節點的原始設定屬性保留在執行結果中

  // 儲存結果到上下文
  context.nodeResults[node.id] = result;

  return result;
}

/**
 * 評估邊的條件
 * @param {Object} edge - 邊
 * @param {Object} nodeResult - 來源節點的執行結果
 * @param {ExecutionContext} context - 執行上下文
 * @returns {boolean} - 是否滿足條件
 */
function evaluateEdgeCondition(edge, nodeResult, context) {
  // 如果邊沒有條件，預設只有在節點成功時才通過
  if (!edge.condition) {
    return nodeResult.success !== false;
  }

  console.log(`評估邊的條件:`, edge.condition, `節點結果:`, nodeResult, `上下文變數:`, context.variables);

  const condition = edge.condition;

  // 支援多種條件格式
  // 1. 簡單的 success/failure 條件
  if (condition.type === 'success') {
    return nodeResult.success === true;
  }
  if (condition.type === 'failure') {
    return nodeResult.success === false;
  }
  if (condition.type === 'else') {
    // 'else' 的評估邏輯延遲到 executeBranch 內統一處理，這裡標示為 null 或特殊物件方便識別。
    // 或是在這裡直接返回 false（如果在單獨評估時），並在 executeBranch 對 else 做特殊處理。
    // 因為單獨看 evaluateEdgeCondition 是不知道其他條件結不成立的，
    // 但為了介面相容，我們在這裡預設丟出 false，讓上層知道這是一個 else 條件並特別處理
    return 'is_else_condition';
  }

  // 2. 比較條件
  if (condition.type === 'compare') {
    const leftValue = getConditionValue(condition.left, nodeResult, context);
    const rightValue = getConditionValue(condition.right, nodeResult, context);
    const operator = condition.operator;

    switch (operator) {
      case '==':
      case 'eq':
        return leftValue == rightValue;
      case '===':
      case 'strictEq':
        return leftValue === rightValue;
      case '!=':
      case 'ne':
        return leftValue != rightValue;
      case '!==':
      case 'strictNe':
        return leftValue !== rightValue;
      case '>':
      case 'gt':
        return leftValue > rightValue;
      case '>=':
      case 'gte':
        return leftValue >= rightValue;
      case '<':
      case 'lt':
        return leftValue < rightValue;
      case '<=':
      case 'lte':
        return leftValue <= rightValue;
      case 'contains':
        return String(leftValue).includes(String(rightValue));
      case 'startsWith':
        return String(leftValue).startsWith(String(rightValue));
      case 'endsWith':
        return String(leftValue).endsWith(String(rightValue));
      case 'matches':
        return new RegExp(rightValue).test(String(leftValue));
      default:
        console.warn(`未知的比較運算子: ${operator}`);
        return true;
    }
  }

  // 3. 表達式條件（使用 Function 評估）
  if (condition.type === 'expression' && condition.expression) {
    try {
      const evalFunc = new Function('result', 'context', 'variables',
        `return ${condition.expression}`);
      return !!evalFunc(nodeResult, context, context.variables);
    } catch (error) {
      console.error(`條件表達式評估失敗: ${error.message}`);
      return false;
    }
  }

  // 預設通過
  return true;
}

/**
 * 取得條件值
 * @param {*} valueSpec - 值規格
 * @param {Object} nodeResult - 節點結果
 * @param {ExecutionContext} context - 執行上下文
 * @returns {*} - 實際值
 */
function getConditionValue(valueSpec, nodeResult, context) {
  if (valueSpec === null || valueSpec === undefined) {
    return valueSpec;
  }

  // 如果是物件，解析來源
  if (typeof valueSpec === 'object') {
    if (valueSpec.source === 'result') {
      return getNestedValue(nodeResult, valueSpec.path);
    }
    if (valueSpec.source === 'variable') {
      return context.variables[valueSpec.name];
    }
    if (valueSpec.source === 'nodeResult') {
      const targetResult = context.nodeResults[valueSpec.nodeId];
      return targetResult ? getNestedValue(targetResult, valueSpec.path) : undefined;
    }
    if (valueSpec.source === 'literal') {
      const val = valueSpec.value;
      if (val === 'true') return true;
      if (val === 'false') return false;
      if (val === 'null') return null;
      if (!isNaN(val) && val !== '') return Number(val);
      return val;
    }
  }

  // 直接返回字面值
  return valueSpec;
}

/**
 * 取得巢狀物件的值
 * @param {Object} obj - 物件
 * @param {string} path - 路徑（如 "data.items[0].name"）
 * @returns {*} - 值
 */
function getNestedValue(obj, path) {
  if (!path) return obj;

  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

/**
 * 取得節點的所有出邊
 * @param {string} nodeId - 節點 ID
 * @param {Array} edges - 所有邊
 * @returns {Array} - 出邊列表
 */
function getOutgoingEdges(nodeId, edges) {
  return edges.filter(edge => edge.sourceNodeId === nodeId);
}

/**
 * 取得節點的所有入邊
 * @param {string} nodeId - 節點 ID
 * @param {Array} edges - 所有邊
 * @returns {Array} - 入邊列表
 */
function getIncomingEdges(nodeId, edges) {
  return edges.filter(edge => edge.targetNodeId === nodeId);
}

/**
 * 計算每個節點的入邊數量
 * @param {Array} edges - 所有邊
 * @returns {Map<string, number>} - 節點 ID 到入邊數量的映射
 */
function calculateIncomingEdgeCounts(edges) {
  const counts = new Map();
  for (const edge of edges) {
    const targetId = edge.targetNodeId;
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }
  return counts;
}

/**
 * 匯聚點追蹤器 - 用於追蹤多個分支匯聚到同一節點的情況
 *
 * 重要：這個追蹤器只在有多個分支實際執行時才會啟用等待機制。
 * 它追蹤的是「實際執行的分支數量」而不是「邊的數量」。
 */
class ConvergenceTracker {
  constructor(edges) {
    this.edges = edges;
    this.incomingCounts = calculateIncomingEdgeCounts(edges);
    this.arrivedBranches = new Map(); // nodeId -> Set of branchIds
    this.waitingResolvers = new Map(); // nodeId -> Array of resolve functions
    this.expectedBranches = new Map(); // nodeId -> 預期的分支數量（動態計算）
  }

  /**
   * 檢查節點是否需要等待其他分支
   * 只有當預期有多個分支會到達時才需要等待
   * @param {string} nodeId - 節點 ID
   * @returns {boolean}
   */
  needsToWait(nodeId) {
    // 優先使用動態設定的預期分支數量
    if (this.expectedBranches.has(nodeId)) {
      return this.expectedBranches.get(nodeId) > 1;
    }
    // 如果沒有設定預期分支數量，則不需要等待
    // 這樣可以避免單一分支執行時被卡住
    return false;
  }

  /**
   * 設定節點預期的分支數量
   * 這應該在分支開始時呼叫，以設定實際會到達的分支數量
   * @param {string} nodeId - 節點 ID
   * @param {number} count - 預期的分支數量
   */
  setExpectedBranches(nodeId, count) {
    this.expectedBranches.set(nodeId, count);
    console.log(`[匯聚追蹤] 設定節點 ${nodeId} 預期分支數量: ${count}`);
  }

  /**
   * 取得節點的預期分支數量
   * 優先使用動態設定的數量，否則使用入邊數量
   * @param {string} nodeId - 節點 ID
   * @returns {number}
   */
  getExpectedCount(nodeId) {
    if (this.expectedBranches.has(nodeId)) {
      return this.expectedBranches.get(nodeId);
    }
    return this.incomingCounts.get(nodeId) || 1;
  }

  /**
   * 取得已到達的分支數量
   * @param {string} nodeId - 節點 ID
   * @returns {number}
   */
  getArrivedCount(nodeId) {
    return this.arrivedBranches.has(nodeId) ? this.arrivedBranches.get(nodeId).size : 0;
  }

  /**
   * 等待所有分支到達節點
   * @param {string} nodeId - 節點 ID
   * @param {string} branchId - 當前分支 ID
   * @returns {Promise<boolean>} - 是否是最後一個到達的分支（負責執行節點）
   */
  async waitForAllBranches(nodeId, branchId) {
    // 記錄分支到達
    if (!this.arrivedBranches.has(nodeId)) {
      this.arrivedBranches.set(nodeId, new Set());
    }
    this.arrivedBranches.get(nodeId).add(branchId);

    const expectedCount = this.getExpectedCount(nodeId);
    const arrivedCount = this.getArrivedCount(nodeId);

    console.log(`[匯聚追蹤] 節點 ${nodeId}: ${arrivedCount}/${expectedCount} 分支已到達 (分支: ${branchId})`);

    if (arrivedCount >= expectedCount) {
      // 所有分支都已到達，通知所有等待中的分支
      console.log(`[匯聚追蹤] 所有分支已到達節點 ${nodeId}，通知等待中的分支`);

      if (this.waitingResolvers.has(nodeId)) {
        const resolvers = this.waitingResolvers.get(nodeId);
        for (const resolve of resolvers) {
          resolve();
        }
        this.waitingResolvers.delete(nodeId);
      }

      // 這個分支負責執行節點
      return true;
    } else {
      // 還有其他分支未到達，需要等待
      console.log(`[匯聚追蹤] 分支 ${branchId} 等待其他分支到達節點 ${nodeId}`);

      return new Promise(resolve => {
        if (!this.waitingResolvers.has(nodeId)) {
          this.waitingResolvers.set(nodeId, []);
        }
        this.waitingResolvers.get(nodeId).push(() => {
          // 這個分支不負責執行節點
          resolve(false);
        });
      });
    }
  }

  /**
   * 重置節點的追蹤狀態（用於迴圈等情況）
   * @param {string} nodeId - 節點 ID
   */
  reset(nodeId) {
    this.arrivedBranches.delete(nodeId);
    this.waitingResolvers.delete(nodeId);
    this.expectedBranches.delete(nodeId);
  }

  /**
   * 通知匯聚追蹤器，某個分支已經終止，更新預期到達匯聚點的分支數量
   * @param {string} startNodeId - 分支終止的節點 ID
   */
  notifyBranchDied(startNodeId) {
    // 找出從 startNodeId 可以到達的所有匯聚點
    const queue = [startNodeId];
    const visited = new Set();

    while (queue.length > 0) {
      const curr = queue.shift();
      if (visited.has(curr)) continue;
      visited.add(curr);

      const outgoing = this.edges.filter(e => e.sourceNodeId === curr);
      for (const edge of outgoing) {
        const next = edge.targetNodeId;

        // 如果這個節點是潛在匯聚點，而且我們有設定它的預期數量
        if (this.incomingCounts.get(next) > 1 && this.expectedBranches.has(next)) {
          // 減少預期分支數量
          const currentExpected = this.expectedBranches.get(next);
          if (currentExpected > 1) {
            const newExpected = currentExpected - 1;
            this.expectedBranches.set(next, newExpected);
            console.log(`[匯聚追蹤] 分支死亡，節點 ${next} 的預期分支數量降為 ${newExpected}`);

            // 檢查是否因為預期數量減少，現在已經滿足啟動條件
            const arrivedCount = this.getArrivedCount(next);
            if (arrivedCount >= newExpected) {
              console.log(`[匯聚追蹤] 節點 ${next} 的預期數量降低後，已達到啟動條件`);
              if (this.waitingResolvers.has(next)) {
                const resolvers = this.waitingResolvers.get(next);
                if (resolvers.length > 0) {
                  // 解鎖第一個等待的分支讓它負責執行節點
                  const firstResolve = resolvers.shift();
                  for (const resolve of resolvers) {
                    resolve(false);
                  }
                  firstResolve(true);
                }
                this.waitingResolvers.delete(next);
              }
            }
          }
        }

        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }
  }
}

// 儲存外部網頁的 port 連接，用於發送進度更新
let externalPort = null;

/**
 * 通知 popup 和外部網頁進度更新
 */
async function notifyProgress(currentNodeId, status, branchId = 'main') {
  const message = {
    action: 'updateProgress',
    currentNodeId,
    status,
    branchId
  };

  // 發送給 popup
  try {
    await chrome.runtime.sendMessage(message);
  } catch (e) {
    // popup 可能已關閉，忽略錯誤
  }

  // 發送給外部網頁（透過 port）
  if (externalPort) {
    try {
      externalPort.postMessage(message);
    } catch (e) {
      // 連接可能已斷開，忽略錯誤
      externalPort = null;
    }
  }
}

/**
 * 通知 popup 和外部網頁節點完成
 */
async function notifyNodeCompleted(nodeId, result, branchId = 'main') {
  const message = {
    action: 'nodeCompleted',
    nodeId,
    result,
    branchId
  };

  // 發送給 popup
  try {
    await chrome.runtime.sendMessage(message);
  } catch (e) {
    // popup 可能已關閉，忽略錯誤
  }

  // 發送給外部網頁（透過 port）
  if (externalPort) {
    try {
      externalPort.postMessage(message);
    } catch (e) {
      // 連接可能已斷開，忽略錯誤
      externalPort = null;
    }
  }
}

/**
 * 通知 Edge 評估結果
 * @param {string} edgeId - Edge ID
 * @param {boolean} executed - 是否執行
 * @param {Object} nodeResult - 來源節點的執行結果
 * @param {string} branchId - 分支 ID
 */
async function notifyEdgeEvaluated(edgeId, executed, nodeResult, branchId = 'main') {
  const message = {
    action: 'edgeEvaluated',
    edgeId,
    executed,
    nodeResult,
    branchId
  };

  // 發送給 popup
  try {
    await chrome.runtime.sendMessage(message);
  } catch (e) {
    // popup 可能已關閉，忽略錯誤
  }

  // 發送給外部網頁（透過 port）
  if (externalPort) {
    try {
      externalPort.postMessage(message);
    } catch (e) {
      // 連接可能已斷開，忽略錯誤
      externalPort = null;
    }
  }
}

/**
 * 執行單一分支
 * @param {string} startNodeId - 起始節點 ID
 * @param {Map} nodeMap - 節點映射
 * @param {Array} edges - 所有邊
 * @param {ExecutionContext} context - 執行上下文
 * @param {Set} visitedNodes - 已訪問的節點（防止無限迴圈）
 * @param {ConvergenceTracker} convergenceTracker - 匯聚點追蹤器
 * @returns {Promise<Object>} - 分支執行結果
 */
async function executeBranch(startNodeId, nodeMap, edges, context, visitedNodes = new Set(), convergenceTracker = null) {
  let currentNodeId = startNodeId;
  const branchResults = [];

  while (currentNodeId) {
    if (context.isCancelled) {
      console.log(`[${context.branchId}] 工作流程已被取消，終止分支`);
      branchResults.push({ success: false, error: 'User Cancelled', cancelled: true });
      if (convergenceTracker) {
        convergenceTracker.notifyBranchDied(currentNodeId);
      }
      break;
    }

    // 移除 防止無限迴圈 的限制，以支援工作流程中的迴圈邏輯
    const visitKey = `${context.branchId}:${currentNodeId}`;
    let loopCountContext = context.loopCounts || {};
    context.loopCounts = loopCountContext;
    loopCountContext[visitKey] = (loopCountContext[visitKey] || 0) + 1;

    // 為了安全，給予一個極大的迴圈上限，避免由於錯誤導致的死循環卡死系統
    if (loopCountContext[visitKey] > 1000) {
      console.warn(`節點執行超過上限次數，強制終止: ${currentNodeId}`);
      if (convergenceTracker) {
        convergenceTracker.notifyBranchDied(currentNodeId);
      }
      break;
    }

    // 如果是迴圈，要重置匯聚追蹤器的狀態，否則第二次經過時會以為已經到達
    if (convergenceTracker && loopCountContext[visitKey] > 1) {
      convergenceTracker.reset(currentNodeId);
    }

    const node = nodeMap.get(currentNodeId);
    if (!node) {
      console.warn(`找不到節點: ${currentNodeId}`);
      if (convergenceTracker) {
        convergenceTracker.notifyBranchDied(currentNodeId);
      }
      break;
    }

    // 檢查是否需要等待其他分支（匯聚點）
    if (convergenceTracker && convergenceTracker.needsToWait(currentNodeId)) {
      console.log(`[${context.branchId}] 節點 ${node.name} 是匯聚點，檢查是否需要等待其他分支`);

      const shouldExecute = await convergenceTracker.waitForAllBranches(currentNodeId, context.branchId);

      if (!shouldExecute) {
        // 這個分支不負責執行節點，結束分支
        console.log(`[${context.branchId}] 其他分支將執行節點 ${node.name}，本分支結束`);
        break;
      }

      console.log(`[${context.branchId}] 所有分支已到達，執行節點 ${node.name}`);
    }

    await notifyProgress(node.id, `正在執行: ${node.name}`, context.branchId);

    console.log(`[${context.branchId}] 執行節點: ${node.name} (${node.type})`);
    const result = await executeNode(node, context);

    branchResults.push(result);
    await notifyNodeCompleted(node.id, result, context.branchId);

    if (context.isCancelled || result.cancelled) {
      console.log(`[${context.branchId}] 節點執行被取消，結束分支`);
      if (convergenceTracker) {
        convergenceTracker.notifyBranchDied(currentNodeId);
      }
      break;
    }

    // 如果是結束節點，停止執行
    if (node.type === 'end') {
      break;
    }

    // 取得所有出邊
    const outgoingEdges = getOutgoingEdges(currentNodeId, edges);

    if (outgoingEdges.length === 0) {
      // 沒有出邊，結束分支
      console.log(`[${context.branchId}] 節點 ${node.name} 沒有出邊，結束分支`);
      break;
    }

    // 評估每條邊的條件，找出要執行的邊
    // 注意：現在 result 可能是 success: false，edge 條件會根據 result.success 來判斷
    const validEdges = [];
    const elseEdges = [];

    for (const edge of outgoingEdges) {
      const conditionResult = evaluateEdgeCondition(edge, result, context);

      if (conditionResult === 'is_else_condition') {
        elseEdges.push(edge);
      } else {
        const isValid = !!conditionResult;
        // 發送 edge 評估結果通知
        await notifyEdgeEvaluated(edge.id, isValid, result, context.branchId);
        if (isValid) {
          validEdges.push(edge);
        }
      }
    }

    // 如果沒有其他邊符合，才執行 else 的邊
    if (validEdges.length === 0 && elseEdges.length > 0) {
      for (const edge of elseEdges) {
        await notifyEdgeEvaluated(edge.id, true, result, context.branchId);
        validEdges.push(edge);
      }
    } else {
      // 否則所有 else 邊都不符合
      for (const edge of elseEdges) {
        await notifyEdgeEvaluated(edge.id, false, result, context.branchId);
      }
    }

    if (validEdges.length === 0) {
      // 沒有滿足條件的邊，結束分支
      console.log(`[${context.branchId}] 沒有滿足條件的出邊，結束分支 (節點結果: success=${result.success})`);
      if (convergenceTracker) {
        convergenceTracker.notifyBranchDied(currentNodeId);
      }
      break;
    }

    if (validEdges.length === 1) {
      // 只有一條有效邊，繼續執行
      currentNodeId = validEdges[0].targetNodeId;
    } else {
      // 多條有效邊，需要分支執行
      console.log(`[${context.branchId}] 發現 ${validEdges.length} 條分支`);

      // 找出所有分支最終會匯聚的節點，並設定預期的分支數量
      if (convergenceTracker) {
        for (const [nodeId, count] of convergenceTracker.incomingCounts) {
          if (count > 1) {
            let reachableCount = 0;
            for (const edge of validEdges) {
              // 檢查這條分支是否能到達 nodeId
              const queue = [edge.targetNodeId];
              const localVisited = new Set();
              let canReach = false;

              while (queue.length > 0) {
                const curr = queue.shift();
                if (curr === nodeId) {
                  canReach = true;
                  break;
                }
                if (localVisited.has(curr)) continue;
                localVisited.add(curr);

                const outgoing = getOutgoingEdges(curr, edges);
                for (const oEdge of outgoing) {
                  queue.push(oEdge.targetNodeId);
                }
              }

              if (canReach) {
                reachableCount++;
              }
            }

            if (reachableCount > 1) {
              const currentExpected = convergenceTracker.expectedBranches.has(nodeId) ? convergenceTracker.expectedBranches.get(nodeId) : 1;
              // 父分支原本貢獻了 1 票，現在分裂成 reachableCount 條實際可到達的分支，所以要新增 (reachableCount - 1)
              convergenceTracker.setExpectedBranches(nodeId, currentExpected + (reachableCount - 1));
            }
          }
        }
      }

      // 並行執行所有分支
      const branchPromises = validEdges.map((edge, index) => {
        const newBranchId = `${context.branchId}-${index}`;
        const newContext = cloneExecutionContext(context, newBranchId);

        return executeBranch(
          edge.targetNodeId,
          nodeMap,
          edges,
          newContext,
          new Set(visitedNodes),
          convergenceTracker  // 傳遞匯聚點追蹤器
        );
      });

      const subBranchResults = await Promise.all(branchPromises);

      // 合併所有分支結果
      for (const subResult of subBranchResults) {
        branchResults.push(...subResult.results);
      }

      // 分支執行完成，結束當前分支
      break;
    }

    // 節點間稍微延遲，確保動作完成
    await delay(300);
  }

  return {
    success: !context.isCancelled,
    cancelled: context.isCancelled,
    branchId: context.branchId,
    results: branchResults,
    context
  };
}

let globalExecutionContext = null;

/**
 * 執行整個工作流程
 * @param {Object} workflow - 工作流程定義
 * @param {Object} variables - 變數
 * @returns {Promise<Object>} - 執行結果
 */
async function executeWorkflow(workflow, variables) {
  const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
  const edges = workflow.edges || [];

  // 建立主執行上下文
  const context = createExecutionContext(variables, 'main');
  globalExecutionContext = context;

  // 建立匯聚點追蹤器，用於處理多分支匯聚到同一節點的情況
  const convergenceTracker = new ConvergenceTracker(edges);

  // 從 start 節點開始執行
  const result = await executeBranch('start', nodeMap, edges, context, new Set(), convergenceTracker);

  return {
    success: !context.isCancelled,
    cancelled: context.isCancelled,
    error: context.isCancelled ? '工作流程已被取消' : undefined,
    results: result.results,
    nodeResults: context.nodeResults,
    variables: context.variables
  };
}

// 監聽來自 popup 的訊息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'executeWorkflow') {
    const { workflow, variables } = message;

    executeWorkflow(workflow, variables)
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });

    // 返回 true 表示會異步發送回應
    return true;
  }
});

// 處理 action 點擊事件 (因為移除 default_popup)
chrome.action.onClicked.addListener(async (tab) => {
  // 建立一個獨立的 popup 視窗，這種類型的視窗點擊其他地方也不會立刻消失
  await chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 480,
    height: 500
  });
});

// 監聽來自外部網頁的 port 連接 (透過 externally_connectable)
chrome.runtime.onConnectExternal.addListener((port) => {
  console.log('外部網頁連接:', port.name, '來自:', port.sender?.url);

  // 處理連接測試
  if (port.name === 'connection-test') {
    console.log('收到連接測試請求');

    port.onMessage.addListener(async (message) => {
      console.log('收到連接測試訊息:', message);

      if (message.action === 'ping') {
        // 取得 JWT 設定
        const settings = await chrome.storage.local.get(['jwtEnabled', 'jwtSecretKey', 'revokedTokenIds', 'allowedIssuers']);
        const jwtEnabled = settings.jwtEnabled !== false; // 預設啟用

        // 如果有傳入 token
        if (message.token) {
          // 如果 JWT 驗證未啟用，但有傳入 token，回覆錯誤
          if (!jwtEnabled) {
            console.log('[JWT] JWT 驗證已停用，但收到 token，回覆錯誤');
            port.postMessage({
              action: 'authError',
              error: 'JWT 驗證未啟用，不需要提供 Token',
              authError: true
            });
            return;
          }

          // JWT 驗證已啟用，驗證 token
          const authResult = await authorizeExternalRequest(message, port.sender?.url);
          if (!authResult.authorized) {
            console.warn('[JWT] 連接測試 Token 驗證失敗:', authResult.error);
            port.postMessage({
              action: 'authError',
              error: authResult.error,
              authError: true
            });
            return;
          }

          // Token 驗證成功
          console.log('[JWT] 連接測試 Token 驗證成功');
          port.postMessage({ action: 'pong' });
          return;
        }

        // 沒有傳入 token
        if (jwtEnabled && settings.jwtSecretKey) {
          // JWT 驗證已啟用且有設定密鑰，需要 token
          console.warn('[JWT] JWT 驗證已啟用，但未提供 token');
          port.postMessage({
            action: 'authError',
            error: '需要提供 JWT Token 進行驗證',
            authError: true
          });
          return;
        }

        // JWT 驗證未啟用或未設定密鑰，直接回應 pong
        port.postMessage({ action: 'pong' });
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('連接測試斷開');
    });

    return;
  }

  if (port.name === 'workflow-executor') {
    externalPort = port;

    port.onDisconnect.addListener(() => {
      console.log('外部網頁斷開連接');
      if (externalPort === port) {
        externalPort = null;
      }
    });

    port.onMessage.addListener(async (message) => {
      console.log('收到 port 訊息:', message);

      // 支援 ping 訊息（不需要驗證）
      if (message.action === 'ping') {
        port.postMessage({ action: 'pong' });
        return;
      }

      if (message.action === 'cancelWorkflow') {
        if (globalExecutionContext) {
          globalExecutionContext.isCancelled = true;
          if (globalExecutionContext.cancelResolve) {
            globalExecutionContext.cancelResolve(new Error('CANCELLED'));
          }
        }
        return;
      }

      if (message.action === 'executeWorkflow') {
        // JWT 驗證
        const authResult = await authorizeExternalRequest(message, port.sender?.url);
        if (!authResult.authorized) {
          port.postMessage({
            action: 'workflowComplete',
            result: { success: false, error: authResult.error, authError: true }
          });
          return;
        }

        const { workflow, variables } = message;

        executeWorkflow(workflow, variables)
          .then(result => {
            port.postMessage({ action: 'workflowComplete', result });
          })
          .catch(error => {
            port.postMessage({ action: 'workflowComplete', result: { success: false, error: error.message } });
          });
      }
    });
  }
});

// 監聯來自外部網頁的訊息 (透過 externally_connectable)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('收到外部訊息:', message, '來自:', sender.url);

  // 處理 getExtensionInfo 請求（不需要驗證）
  if (message.action === 'getExtensionInfo') {
    chrome.storage.local.get(['jwtEnabled']).then(settings => {
      sendResponse({
        success: true,
        extensionId: chrome.runtime.id,
        jwtEnabled: settings.jwtEnabled !== false,
        version: chrome.runtime.getManifest().version
      });
    });
    return true;
  }

  if (message.action === 'executeWorkflow') {
    // JWT 驗證
    authorizeExternalRequest(message, sender.url)
      .then(authResult => {
        if (!authResult.authorized) {
          sendResponse({ success: false, error: authResult.error, authError: true });
          return;
        }

        const { workflow, variables } = message;

        return executeWorkflow(workflow, variables)
          .then(result => {
            sendResponse(result);
          })
          .catch(error => {
            sendResponse({ success: false, error: error.message });
          });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });

    // 返回 true 表示會異步發送回應
    return true;
  }

  // 未知的 action
  sendResponse({ success: false, error: '未知的動作' });
  return false;
});

console.log('Web Click Wizard background service worker 已啟動');
