# Web Click Wizard

一個簡單的 Chrome 擴充功能，可讀取 workflow.json 並自動執行工作流程。

## 功能特色

- 📁 載入 workflow.json 工作流程檔案
- 🔄 自動解析節點執行順序
- 🌐 `goto` 動作會開啟新分頁
- ⌨️ 支援 `typeText` 輸入文字動作
- 🖱️ 支援 `click` 點擊動作
- ⏱️ 支援 `wait` 等待動作
- 📝 支援變數替換 (使用 `{{變數名}}` 語法)
- 🔗 支援從外部網頁觸發執行 (透過 Chrome Extension API)
- 🌿 **支援多分支執行** - 一個節點可以有多條出邊，並行執行
- 📊 **節點執行結果** - 每個節點執行後產生 result 物件
- 🔀 **條件分支** - 邊可以設定條件，根據節點執行結果決定是否執行
- 🔐 **JWT 驗證** - 外部請求需要提供有效的 JWT Token 才能執行工作流程

## 安裝方式

1. 開啟 Chrome 瀏覽器
2. 前往 `chrome://extensions/`
3. 開啟右上角的「開發人員模式」
4. 點擊「載入未封裝項目」
5. 選擇 `web-click-wizard` 資料夾

## 使用方式

1. 點擊瀏覽器工具列上的擴充功能圖示
2. 點擊「選擇 workflow.json 檔案」載入工作流程
3. 如果工作流程中有變數，請在變數設定區填入值
4. 點擊「執行工作流程」開始自動化

## 支援的節點類型

| 類型 | 說明 | 參數 |
|------|------|------|
| `start` | 開始節點 | 無 |
| `end` | 結束節點 | 無 |
| `goto` | 開啟網頁 (新分頁) | `url`: 網址 |
| `click` | 點擊元素 | `selector`: CSS 選擇器 |
| `typeText` | 輸入文字 | `selector`: CSS 選擇器, `text`: 要輸入的文字 |
| `wait` | 等待指定時間 | `duration`: 秒數 或 `ms`: 毫秒數 |

## 節點執行結果 (Result)

每個節點執行完成後會產生一個 result 物件，包含以下基本欄位：

```javascript
{
  success: true,           // 是否成功
  nodeId: "node_1",        // 節點 ID
  nodeName: "打開 Google", // 節點名稱
  nodeType: "goto",        // 節點類型
  timestamp: 1234567890    // 執行時間戳
}
```

不同節點類型會有額外的結果欄位：

### goto 節點結果
```javascript
{
  success: true,
  tabId: 123,              // 開啟的分頁 ID
  url: "https://...",      // 實際載入的網址
  title: "Page Title"      // 頁面標題
}
```

### click 節點結果
```javascript
{
  success: true,
  tagName: "BUTTON",       // 點擊元素的標籤名
  text: "Submit"           // 元素的文字內容
}
```

### typeText 節點結果
```javascript
{
  success: true,
  inputText: "Hello",      // 輸入的文字
  tagName: "INPUT"         // 輸入元素的標籤名
}
```

### wait 節點結果
```javascript
{
  success: true,
  waitTime: 2000,          // 等待的毫秒數
  message: "已等待 2000 毫秒"
}
```

## 多分支執行

工作流程支援從一個節點分出多條邊，每條邊會建立獨立的執行分支：

```json
{
  "nodes": [
    { "id": "start", "type": "start", "name": "Start" },
    { "id": "goto_google", "type": "goto", "name": "開啟 Google", "parameters": { "url": "https://google.com" } },
    { "id": "goto_github", "type": "goto", "name": "開啟 GitHub", "parameters": { "url": "https://github.com" } },
    { "id": "end", "type": "end", "name": "End" }
  ],
  "edges": [
    { "id": "e1", "sourceNodeId": "start", "targetNodeId": "goto_google" },
    { "id": "e2", "sourceNodeId": "start", "targetNodeId": "goto_github" },
    { "id": "e3", "sourceNodeId": "goto_google", "targetNodeId": "end" },
    { "id": "e4", "sourceNodeId": "goto_github", "targetNodeId": "end" }
  ]
}
```

在上面的範例中，`start` 節點有兩條出邊，會同時開啟 Google 和 GitHub 兩個分頁。

### 分支上下文

每個分支維護自己的執行上下文，包括：
- `tabId`: 該分支目前操作的分頁 ID
- `variables`: 變數（從父分支繼承）
- `nodeResults`: 該分支執行過的節點結果

## 條件分支

邊可以設定條件，根據來源節點的執行結果決定是否執行該邊：

### 成功/失敗條件

```json
{
  "edges": [
    {
      "id": "e1",
      "sourceNodeId": "node_1",
      "targetNodeId": "node_success",
      "condition": { "type": "success" }
    },
    {
      "id": "e2",
      "sourceNodeId": "node_1",
      "targetNodeId": "node_failure",
      "condition": { "type": "failure" }
    }
  ]
}
```

### 比較條件

```json
{
  "edges": [
    {
      "id": "e1",
      "sourceNodeId": "node_1",
      "targetNodeId": "node_2",
      "condition": {
        "type": "compare",
        "left": { "source": "result", "path": "tabId" },
        "operator": "gt",
        "right": { "source": "literal", "value": 0 }
      }
    }
  ]
}
```

支援的比較運算子：
- `==`, `eq`: 相等
- `===`, `strictEq`: 嚴格相等
- `!=`, `ne`: 不相等
- `!==`, `strictNe`: 嚴格不相等
- `>`, `gt`: 大於
- `>=`, `gte`: 大於等於
- `<`, `lt`: 小於
- `<=`, `lte`: 小於等於
- `contains`: 包含字串
- `startsWith`: 以...開頭
- `endsWith`: 以...結尾
- `matches`: 正規表達式匹配

### 值來源

條件中的值可以來自：
- `{ "source": "result", "path": "success" }`: 來源節點的執行結果
- `{ "source": "variable", "name": "myVar" }`: 變數值
- `{ "source": "nodeResult", "nodeId": "node_1", "path": "tabId" }`: 指定節點的執行結果
- `{ "source": "literal", "value": 123 }`: 字面值

### 表達式條件

```json
{
  "edges": [
    {
      "id": "e1",
      "sourceNodeId": "node_1",
      "targetNodeId": "node_2",
      "condition": {
        "type": "expression",
        "expression": "result.success && variables.enableFeature"
      }
    }
  ]
}
```

## workflow.json 範例

### 基本範例

```json
{
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "name": "Start"
    },
    {
      "id": "node_1",
      "name": "打開 Google",
      "type": "goto",
      "parameters": {
        "url": "{{url}}"
      }
    },
    {
      "id": "node_2",
      "name": "等待頁面載入",
      "type": "wait",
      "parameters": {
        "duration": 2
      }
    },
    {
      "id": "node_3",
      "name": "輸入搜尋文字",
      "type": "typeText",
      "parameters": {
        "selector": "input[name='q']",
        "text": "{{searchText}}"
      }
    },
    {
      "id": "node_4",
      "name": "點擊搜尋按鈕",
      "type": "click",
      "parameters": {
        "selector": "input[type='submit']"
      }
    },
    {
      "id": "end",
      "type": "end",
      "name": "End"
    }
  ],
  "edges": [
    { "id": "e1", "sourceNodeId": "start", "targetNodeId": "node_1" },
    { "id": "e2", "sourceNodeId": "node_1", "targetNodeId": "node_2" },
    { "id": "e3", "sourceNodeId": "node_2", "targetNodeId": "node_3" },
    { "id": "e4", "sourceNodeId": "node_3", "targetNodeId": "node_4" },
    { "id": "e5", "sourceNodeId": "node_4", "targetNodeId": "end" }
  ]
}
```

### 多分支範例

```json
{
  "nodes": [
    { "id": "start", "type": "start", "name": "Start" },
    { "id": "goto_1", "type": "goto", "name": "開啟網站 A", "parameters": { "url": "https://example-a.com" } },
    { "id": "goto_2", "type": "goto", "name": "開啟網站 B", "parameters": { "url": "https://example-b.com" } },
    { "id": "click_1", "type": "click", "name": "點擊 A 按鈕", "parameters": { "selector": "#btn-a" } },
    { "id": "click_2", "type": "click", "name": "點擊 B 按鈕", "parameters": { "selector": "#btn-b" } },
    { "id": "end", "type": "end", "name": "End" }
  ],
  "edges": [
    { "id": "e1", "sourceNodeId": "start", "targetNodeId": "goto_1" },
    { "id": "e2", "sourceNodeId": "start", "targetNodeId": "goto_2" },
    { "id": "e3", "sourceNodeId": "goto_1", "targetNodeId": "click_1" },
    { "id": "e4", "sourceNodeId": "goto_2", "targetNodeId": "click_2" },
    { "id": "e5", "sourceNodeId": "click_1", "targetNodeId": "end" },
    { "id": "e6", "sourceNodeId": "click_2", "targetNodeId": "end" }
  ]
}
```

## 變數使用

在 workflow.json 中使用 `{{變數名}}` 語法定義變數，執行時會在 popup 中顯示輸入欄位讓使用者填入值。

例如：
- `{{url}}` - 網址變數
- `{{searchText}}` - 搜尋文字變數
- `{{waitTime}}` - 等待時間變數

## JWT 驗證

為了保護工作流程執行的安全性，此擴充功能支援 JWT (JSON Web Token) 驗證。啟用後，所有來自外部網頁的執行請求都需要提供有效的 JWT Token。

### 設定 JWT 驗證

1. 右鍵點擊擴充功能圖示，選擇「選項」或在 `chrome://extensions/` 頁面點擊擴充功能的「詳細資料」→「擴充功能選項」
2. 在設定頁面中：
   - 確認「啟用 JWT 驗證」已開啟（預設啟用）
   - 點擊「產生新密鑰」建立 JWT 簽署密鑰
   - 點擊「儲存密鑰」保存設定
3. 在「產生新 Token」區塊：
   - 輸入 Token 名稱（方便識別用途）
   - 選擇有效期限
   - 可選：設定允許的來源（限制 Token 只能從特定網域使用）
   - 點擊「產生 Token」
4. 複製產生的 Token，提供給需要呼叫此擴充功能的網頁使用

### Token 安全性

- **密鑰保護**：JWT 密鑰儲存在擴充功能的本地儲存空間，不會外洩
- **過期機制**：Token 可設定有效期限，過期後自動失效
- **來源限制**：可限制 Token 只能從特定網域使用
- **發行者驗證**：Token 必須由此擴充功能產生才有效

### 停用 JWT 驗證

如果不需要驗證（例如在開發環境），可以在設定頁面關閉「啟用 JWT 驗證」開關。

> ⚠️ **警告**：停用 JWT 驗證後，任何符合 `externally_connectable` 設定的網頁都可以執行工作流程，請謹慎使用。

## 從網頁觸發執行

此擴充功能支援從 localhost 網頁直接觸發工作流程執行。

### 設定步驟

1. 安裝擴充功能後，在 `chrome://extensions/` 頁面找到擴充功能的 ID（或在擴充功能設定頁面查看）
2. 在擴充功能設定頁面產生 JWT Token
3. 在你的網頁程式碼中，將 `EXTENSION_ID` 替換為實際的擴充功能 ID
4. 在請求中加入 `token` 欄位

### 網頁端程式碼範例

```javascript
// 替換為你的擴充功能 ID
const EXTENSION_ID = 'your-extension-id-here';

// 替換為你的 JWT Token
const JWT_TOKEN = 'your-jwt-token-here';

// 工作流程定義
const workflow = {
  nodes: [...],
  edges: [...]
};

// 變數值
const variables = {
  url: 'https://www.google.com',
  searchText: 'Hello World'
};

// 發送訊息給擴充功能（包含 JWT Token）
chrome.runtime.sendMessage(
  EXTENSION_ID,
  {
    action: 'executeWorkflow',
    workflow: workflow,
    variables: variables,
    token: JWT_TOKEN  // JWT Token 用於驗證
  },
  (response) => {
    if (chrome.runtime.lastError) {
      console.error('連接失敗:', chrome.runtime.lastError.message);
      return;
    }
    
    if (response.authError) {
      // JWT 驗證失敗
      console.error('驗證失敗:', response.error);
      return;
    }
    
    if (response.success) {
      console.log('工作流程執行完成！');
      console.log('執行結果:', response.results);
      console.log('各節點結果:', response.nodeResults);
    } else {
      console.error('執行失敗:', response.error);
    }
  }
);
```

### 查詢擴充功能資訊

可以使用 `getExtensionInfo` 動作查詢擴充功能的資訊（不需要 JWT Token）：

```javascript
chrome.runtime.sendMessage(
  EXTENSION_ID,
  { action: 'getExtensionInfo' },
  (response) => {
    console.log('Extension ID:', response.extensionId);
    console.log('JWT 驗證啟用:', response.jwtEnabled);
    console.log('版本:', response.version);
  }
);
```

### 支援的網頁來源

擴充功能預設允許以下來源的網頁連接：
- `http://localhost:*/*`
- `https://localhost:*/*`
- `http://127.0.0.1:*/*`
- `https://127.0.0.1:*/*`

如需支援其他網域，請修改 `manifest.json` 中的 `externally_connectable.matches` 設定。

## 注意事項

- `goto` 動作會開啟新分頁，每個分支會維護自己的分頁
- 多分支執行時，各分支會並行執行
- 請確保 CSS 選擇器正確，否則動作會失敗
- 某些網站可能有安全限制，導致自動化動作無法執行
- 從網頁觸發執行時，請確保網頁在 localhost 上運行
- 條件分支可以用於錯誤處理，當節點執行失敗時走不同的路徑

## 授權

MIT License
