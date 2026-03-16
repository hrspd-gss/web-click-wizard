// popup.js - 處理 popup UI 邏輯

let workflowData = null;
let variables = {};

// DOM 元素
const workflowFileInput = document.getElementById('workflowFile');
const fileNameDiv = document.getElementById('fileName');
const workflowInfoDiv = document.getElementById('workflowInfo');
const nodeCountSpan = document.getElementById('nodeCount');
const edgeCountSpan = document.getElementById('edgeCount');
const nodeListDiv = document.getElementById('nodeList');
const variablesSectionDiv = document.getElementById('variablesSection');
const variablesListDiv = document.getElementById('variablesList');
const runBtn = document.getElementById('runBtn');
const statusDiv = document.getElementById('status');

// Tabs DOM
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

// Picker DOM
const startSelectBtn = document.getElementById('startSelectBtn');
const selectorStatus = document.getElementById('selectorStatus');
const selectorList = document.getElementById('selectorList');
let isPicking = false;
let pickingTabId = null;
let pickerPort = null;

// 當彈出視窗被關閉時，如果在選取模式中，自動停止選取
window.addEventListener('unload', () => {
  if (pickerPort) {
    pickerPort.disconnect();
  }
  if (isPicking && pickingTabId) {
    chrome.tabs.sendMessage(pickingTabId, { type: 'STOP_PICKER' });
  }
});

// 頁籤切換
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).classList.add('active');
  });
});

// Selector Picker 邏輯
startSelectBtn.addEventListener('click', async () => {
  try {
    let activeTab = null;
    const lastWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (lastWindow) {
      const tabs = await chrome.tabs.query({ active: true, windowId: lastWindow.id });
      if (tabs.length) activeTab = tabs[0];
    }

    if (!activeTab || activeTab.url.startsWith('chrome-extension://') || activeTab.url.startsWith('chrome://')) {
      updateSelectorStatus('請先將瀏覽器切換至欲選取的網頁', 'error');
      return;
    }
    const tabId = activeTab.id;
    pickingTabId = tabId;

    if (isPicking) {
      if (pickerPort) {
        pickerPort.disconnect();
        pickerPort = null;
      }
      // 停止選取
      chrome.tabs.sendMessage(tabId, { type: 'STOP_PICKER' });
      isPicking = false;
      document.body.classList.remove('is-picking');
      chrome.windows.getCurrent((win) => {
        chrome.windows.update(win.id, { width: 480, height: 500 });
      });
      startSelectBtn.innerHTML = '🎯 啟動選取模式';
      startSelectBtn.classList.remove('btn-warning');
      startSelectBtn.classList.add('btn-primary');
      return;
    }

    updateSelectorStatus('請在網頁上移動滑鼠...', 'info');

    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['picker.js']
    });

    pickerPort = chrome.tabs.connect(tabId, { name: 'picker-port' });

    isPicking = true;
    document.body.classList.add('is-picking');
    chrome.windows.getCurrent((win) => {
      chrome.windows.update(win.id, { width: 440, height: 280 });
    });
    startSelectBtn.innerHTML = '🛑 停止選取模式';
    startSelectBtn.classList.remove('btn-primary');
    // .btn-warning isn't defined in CSS, but we can override background or just keep primary text change
  } catch (error) {
    updateSelectorStatus(`錯誤: ${error.message}`, 'error');
  }
});

function updateSelectorStatus(message, type = 'info') {
  selectorStatus.innerHTML = message;
  selectorStatus.style.display = 'block';
  // reuse existing status classes but ensure background colors
  if (type === 'success') {
    selectorStatus.style.background = '#e8f5e9';
    selectorStatus.style.color = '#2e7d32';
  } else if (type === 'error') {
    selectorStatus.style.background = '#ffebee';
    selectorStatus.style.color = '#c62828';
  } else {
    selectorStatus.style.background = '#e3f2fd';
    selectorStatus.style.color = '#1565c0';
  }
}

function renderSelectors(selectors, tagName) {
  if (!selectors || !selectors.length) {
    selectorList.innerHTML = '<p class="instruction-text">無法產生 Selector，請嘗試其他元素</p>';
    return;
  }

  selectorList.innerHTML = selectors.map((sel) => `
    <div class="selector-item">
      <div class="selector-text">${sel}</div>
      <button class="copy-btn" data-selector="${sel.replace(/"/g, '&quot;')}">複製</button>
    </div>
  `).join('');

  // 綁定複製事件
  selectorList.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const textToCopy = e.target.dataset.selector;
      navigator.clipboard.writeText(textToCopy).then(() => {
        const originalText = e.target.textContent;
        e.target.textContent = '已複製!';
        e.target.style.background = '#d4edda';
        setTimeout(() => {
          e.target.textContent = originalText;
          e.target.style.background = '#eee';
        }, 1500);
      });
    });
  });
}

// 從工作流程中提取變數
function extractVariables(workflow) {
  const vars = new Set();
  const varPattern = /\{\{(\w+)\}\}/g;

  workflow.nodes.forEach(node => {
    if (node.parameters) {
      Object.values(node.parameters).forEach(value => {
        if (typeof value === 'string') {
          let match;
          while ((match = varPattern.exec(value)) !== null) {
            vars.add(match[1]);
          }
        }
      });
    }
  });

  return Array.from(vars);
}

// 顯示工作流程資訊
function displayWorkflowInfo(workflow) {
  nodeCountSpan.textContent = workflow.nodes.length;
  edgeCountSpan.textContent = workflow.edges.length;

  // 建立節點執行順序
  const orderedNodes = getOrderedNodes(workflow);

  nodeListDiv.innerHTML = orderedNodes.map(node => `
    <div class="node-item" data-node-id="${node.id}">
      <span class="node-type ${node.type}">${node.type}</span>
      <span class="node-name">${node.name}</span>
    </div>
  `).join('');

  workflowInfoDiv.style.display = 'block';
}

// 取得節點執行順序
function getOrderedNodes(workflow) {
  const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
  const edgeMap = new Map();

  workflow.edges.forEach(edge => {
    edgeMap.set(edge.sourceNodeId, edge.targetNodeId);
  });

  const ordered = [];
  let currentId = 'start';

  while (currentId) {
    const node = nodeMap.get(currentId);
    if (node) {
      ordered.push(node);
    }
    currentId = edgeMap.get(currentId);
  }

  return ordered;
}

// 顯示變數輸入欄位
function displayVariables(vars) {
  if (vars.length === 0) {
    variablesSectionDiv.style.display = 'none';
    return;
  }

  variablesListDiv.innerHTML = vars.map(varName => `
    <div class="variable-item">
      <label for="var_${varName}">{{${varName}}}</label>
      <input type="text" id="var_${varName}" data-var="${varName}" placeholder="輸入值...">
    </div>
  `).join('');

  variablesSectionDiv.style.display = 'block';

  // 綁定輸入事件
  variablesListDiv.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', (e) => {
      variables[e.target.dataset.var] = e.target.value;
    });
  });
}

// 更新狀態顯示
function updateStatus(message, type = 'info') {
  statusDiv.textContent = message;
  statusDiv.className = `status show ${type}`;
}

// 處理檔案選擇
workflowFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  fileNameDiv.textContent = file.name;

  try {
    const text = await file.text();
    workflowData = JSON.parse(text);

    // 驗證工作流程結構
    if (!workflowData.nodes || !workflowData.edges) {
      throw new Error('無效的工作流程格式');
    }

    // 顯示工作流程資訊
    displayWorkflowInfo(workflowData);

    // 提取並顯示變數
    const vars = extractVariables(workflowData);
    displayVariables(vars);

    // 啟用執行按鈕
    runBtn.disabled = false;
    updateStatus('工作流程載入成功！', 'success');

  } catch (error) {
    updateStatus(`載入失敗: ${error.message}`, 'error');
    runBtn.disabled = true;
  }
});

// 執行工作流程
runBtn.addEventListener('click', async () => {
  if (!workflowData) {
    updateStatus('請先載入工作流程', 'error');
    return;
  }

  // 收集變數值
  const varInputs = variablesListDiv.querySelectorAll('input');
  varInputs.forEach(input => {
    variables[input.dataset.var] = input.value;
  });

  runBtn.disabled = true;
  updateStatus('正在執行工作流程...', 'running');

  try {
    // 發送訊息給 background script 執行工作流程
    const response = await chrome.runtime.sendMessage({
      action: 'executeWorkflow',
      workflow: workflowData,
      variables: variables
    });

    if (response.success) {
      updateStatus('工作流程執行完成！', 'success');
    } else {
      updateStatus(`執行失敗: ${response.error}`, 'error');
    }
  } catch (error) {
    updateStatus(`執行錯誤: ${error.message}`, 'error');
  } finally {
    runBtn.disabled = false;
  }
});

// 監聽來自 background 的進度更新
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXT_PICKER_HOVER') {
    updateSelectorStatus(`目前元素: &lt;${message.tagName}&gt;`, 'info');
    renderSelectors(message.selectors, message.tagName);
    return;
  } else if (message.type === 'EXT_PICKER_CLICK') {
    updateSelectorStatus(`已選取元素: &lt;${message.tagName}&gt;。請複製下方的 Selector。`, 'success');
    renderSelectors(message.selectors, message.tagName);

    if (pickerPort) {
      pickerPort.disconnect();
      pickerPort = null;
    }
    // 關閉網頁上的選取模式
    if (sender && sender.tab && sender.tab.id) {
      chrome.tabs.sendMessage(sender.tab.id, { type: 'STOP_PICKER' });
    }

    isPicking = false;
    document.body.classList.remove('is-picking');
    chrome.windows.getCurrent((win) => {
      chrome.windows.update(win.id, { width: 480, height: 500, focused: true });
    });

    startSelectBtn.innerHTML = '🎯 重新啟動選取模式';
    startSelectBtn.classList.remove('btn-warning');
    startSelectBtn.classList.add('btn-primary');

    return;
  } else if (message.type === 'EXT_PICKER_CANCEL') {
    if (pickerPort) {
      pickerPort.disconnect();
      pickerPort = null;
    }
    isPicking = false;
    document.body.classList.remove('is-picking');
    chrome.windows.getCurrent((win) => {
      chrome.windows.update(win.id, { width: 480, height: 500 });
    });
    startSelectBtn.innerHTML = '🎯 啟動選取模式';
    startSelectBtn.classList.remove('btn-warning');
    startSelectBtn.classList.add('btn-primary');
    updateSelectorStatus('已停止選取', 'info');
    return;
  }

  if (message.action === 'updateProgress') {
    const { currentNodeId, status } = message;

    // 更新節點狀態顯示
    const nodeItems = nodeListDiv.querySelectorAll('.node-item');
    nodeItems.forEach(item => {
      item.classList.remove('current');
      if (item.dataset.nodeId === currentNodeId) {
        item.classList.add('current');
      }
    });

    updateStatus(status, 'running');
  } else if (message.action === 'nodeCompleted') {
    const { nodeId } = message;
    const nodeItem = nodeListDiv.querySelector(`[data-node-id="${nodeId}"]`);
    if (nodeItem) {
      nodeItem.classList.remove('current');
      nodeItem.classList.add('completed');
    }
  }
});
