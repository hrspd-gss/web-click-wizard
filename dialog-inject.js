(function(){
  // dialog-inject.js: 注入到 page MAIN world，用以覆寫原生 alert/confirm/prompt
  // 會讀取 window.__rpaDialogDesiredMode 或 window.__rpaDialogMode 作為行為模式
  const mode = (window.__rpaDialogDesiredMode || window.__rpaDialogMode || 'autoAccept');
  try {
    if (window.__rpaDialogInstrumented && window.__rpaDialogMode === mode) return;
    window.__rpaDialogInstrumented = true;
    window.__rpaDialogMode = mode;
    window.__rpaLastDialog = null;

    const origAlert = window.alert && window.alert.bind(window);
    const origConfirm = window.confirm && window.confirm.bind(window);
    const origPrompt = window.prompt && window.prompt.bind(window);

    window.alert = function(msg){
      try { window.__rpaLastDialog = { type: 'alert', message: String(msg), timestamp: Date.now() }; } catch(e) {}
      if (mode === 'reportOnly' && typeof origAlert === 'function') return origAlert(msg);
      return undefined;
    };

    window.confirm = function(msg){
      try { window.__rpaLastDialog = { type: 'confirm', message: String(msg), timestamp: Date.now() }; } catch(e) {}
      if (mode === 'reportOnly' && typeof origConfirm === 'function') return origConfirm(msg);
      if (mode === 'autoAccept') return true;
      if (mode === 'autoDismiss') return false;
      return false;
    };

    window.prompt = function(msg, def){
      try { window.__rpaLastDialog = { type: 'prompt', message: String(msg), defaultValue: def, timestamp: Date.now() }; } catch(e) {}
      if (mode === 'reportOnly' && typeof origPrompt === 'function') return origPrompt(msg, def);
      if (mode === 'autoAccept') return def || '';
      if (mode === 'autoDismiss') return null;
      return null;
    };
  } catch(e) {
    // ignore
  }
})();
