// jwt-utils.js - JWT 工具函式庫
// 使用 Web Crypto API 實作 JWT (HS256)

/**
 * Base64URL 編碼
 * @param {ArrayBuffer|Uint8Array|string} data 
 * @returns {string}
 */
function base64UrlEncode(data) {
  let bytes;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
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
  // 補齊 padding
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
 * 產生隨機密鑰
 * @param {number} length - 密鑰長度（位元組）
 * @returns {string} - Base64URL 編碼的密鑰
 */
function generateSecretKey(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * 使用 HMAC-SHA256 簽名
 * @param {string} data - 要簽名的資料
 * @param {string} secret - Base64URL 編碼的密鑰
 * @returns {Promise<string>} - Base64URL 編碼的簽名
 */
async function hmacSign(data, secret) {
  const encoder = new TextEncoder();
  const keyData = base64UrlDecode(secret);
  
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(data)
  );
  
  return base64UrlEncode(signature);
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
 * 產生 JWT Token
 * @param {Object} payload - Token 內容
 * @param {string} secret - Base64URL 編碼的密鑰
 * @param {Object} options - 選項
 * @param {number} options.expiresIn - 過期時間（秒），預設 3600（1小時）
 * @returns {Promise<string>} - JWT Token
 */
async function generateJWT(payload, secret, options = {}) {
  const { expiresIn = 3600 } = options;
  
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };
  
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    ...payload,
    iat: now,
    exp: now + expiresIn,
    iss: 'https://www.gss.com.tw'
  };
  
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(tokenPayload));
  
  const dataToSign = `${headerEncoded}.${payloadEncoded}`;
  const signature = await hmacSign(dataToSign, secret);
  
  return `${dataToSign}.${signature}`;
}

/**
 * 驗證 JWT Token
 * @param {string} token - JWT Token
 * @param {string} secret - Base64URL 編碼的密鑰
 * @param {string[]} allowedIssuers - 允許的發行者列表（可選，預設為 ['https://www.gss.com.tw']）
 * @returns {Promise<Object>} - 驗證結果 { valid: boolean, payload?: Object, error?: string }
 */
async function verifyJWT(token, secret, allowedIssuers = ['https://www.gss.com.tw']) {
  try {
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
    
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * 解析 JWT Token（不驗證簽名）
 * @param {string} token - JWT Token
 * @returns {Object|null} - payload 或 null
 */
function parseJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    
    const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));
    return JSON.parse(payloadJson);
  } catch (error) {
    return null;
  }
}

// ============================================
// 密鑰加密儲存相關函式
// 使用 AES-GCM 加密 JWT 密鑰
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
 * 加密 JWT 密鑰
 * @param {string} secretKey - 要加密的 JWT 密鑰（Base64URL 編碼）
 * @param {string} extensionId - Chrome Extension ID
 * @returns {Promise<string>} - 加密後的資料（Base64URL 編碼，包含 IV）
 */
async function encryptSecretKey(secretKey, extensionId) {
  const encoder = new TextEncoder();
  const encryptionKey = await deriveEncryptionKey(extensionId);
  
  // 產生隨機 IV（12 bytes for AES-GCM）
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  // 加密
  const encryptedData = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    encryptionKey,
    encoder.encode(secretKey)
  );
  
  // 將 IV 和加密資料合併
  const combined = new Uint8Array(iv.length + encryptedData.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encryptedData), iv.length);
  
  return base64UrlEncode(combined);
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

// 匯出函式（供其他腳本使用）
if (typeof globalThis !== 'undefined') {
  globalThis.JWTUtils = {
    generateSecretKey,
    generateJWT,
    verifyJWT,
    parseJWT,
    base64UrlEncode,
    base64UrlDecode,
    // 密鑰加密相關
    encryptSecretKey,
    decryptSecretKey,
    isEncryptedSecretKey
  };
}
