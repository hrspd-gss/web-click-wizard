// picker.js - Injected into webpage to act as element selector
(function () {
  if (window.__rpaPickerActive) return;
  window.__rpaPickerActive = true;

  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '9999999';
  overlay.style.border = '2px solid #ea4335';
  overlay.style.backgroundColor = 'rgba(234, 67, 53, 0.2)';
  overlay.style.transition = 'all 0.1s ease';
  overlay.style.display = 'none';
  document.body.appendChild(overlay);

  let currentElement = null;
  let isLocked = false;

  function isJunkId(id) {
    if (!id) return true;
    return false;
    // 保留
    // // Looks like random string, e.g. UUID, long numbers, etc.
    // if (id.length > 20) return true;
    // if (/^[0-9]+$/.test(id)) return true; // only numbers
    // if (/_.*_/.test(id)) return true; // too many underscores? maybe not
    // if (/[a-zA-Z0-9]{8,}(-[a-zA-Z0-9]{4,}){3,}/.test(id)) return true; // UUID-like
    // if (/^[a-z0-9]{10,}$/i.test(id) && /\d/.test(id) && /[a-zA-Z]/.test(id)) return true; // alphanumeric hash
    // return false;
  }

  function getSelectors(el) {
    const selectors = [];
    const tagName = el.tagName.toLowerCase();

    // Function to safely check if a selector is valid and uniquely identifies the element
    function isUniqueAndValid(selector) {
      if (!selector) return false;
      try {
        const matches = document.querySelectorAll(selector);
        return matches.length === 1 && matches[0] === el;
      } catch (e) {
        return false;
      }
    }

    // Attempt individual selectors
    let candidates = [];

    // 1. ID
    if (el.id && !isJunkId(el.id)) {
      candidates.push(`#${el.id}`);
      candidates.push(`${tagName}#${el.id}`);
    }

    // 2. Classes
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(/\s+/).filter(c => c && !isJunkId(c));
      if (classes.length > 0) {
        candidates.push(`.${classes.join('.')}`);
        candidates.push(`${tagName}.${classes.join('.')}`);
      }
    }

    // 3. Name attribute
    if (el.name) {
      candidates.push(`${tagName}[name="${el.name}"]`);
    }

    // 4. Data attributes
    const dataAttrs = ['data-id', 'data-testid', 'data-test', 'data-name'];
    for (const attr of dataAttrs) {
      if (el.hasAttribute(attr)) {
        candidates.push(`${tagName}[${attr}="${el.getAttribute(attr)}"]`);
      }
    }

    // Evaluate uniqueness for short candidates
    for (const c of candidates) {
      if (isUniqueAndValid(c)) {
        selectors.push(c);
      }
    }

    // 5. Build full unique path as a fallback or addition
    let path = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur.tagName.toLowerCase() !== 'html' && cur.tagName.toLowerCase() !== 'body') {
      let stepTag = cur.tagName.toLowerCase();

      // Attempt to optimize the step with ID or Class if it uniquely identifies the path element locally
      if (cur.id && !isJunkId(cur.id)) {
        stepTag += `#${cur.id}`;
        path.unshift(stepTag);
        break; // Assume IDs bubble up uniqueness well enough to stop deep traversal
      } else {
        let nth = 1;
        let sibling = cur;
        while ((sibling = sibling.previousElementSibling) != null) {
          if (sibling.tagName === cur.tagName) nth++;
        }

        // Always add nth-of-type if there are siblings of the same tag, to ensure exact path uniqueness
        if (nth > 1 || (cur.nextElementSibling && Array.from(cur.parentElement.children).some(c => c !== cur && c.tagName === cur.tagName))) {
          stepTag += `:nth-of-type(${nth})`;
        }
      }

      path.unshift(stepTag);
      cur = cur.parentElement;
    }

    if (path.length > 0) {
      const pathStr = path.join(' > ');
      if (isUniqueAndValid(pathStr)) {
        selectors.push(pathStr);
      }
    }

    // Clean up to remove possible duplicates and ensure they are valid
    const uniqueSelectors = [...new Set(selectors)];
    return uniqueSelectors;
  }

  function highlight(el) {
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  function handleMouseMove(e) {
    if (isLocked) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === currentElement) return;

    currentElement = el;
    highlight(el);

    const selectors = getSelectors(el);
    chrome.runtime.sendMessage({
      type: 'EXT_PICKER_HOVER',
      selectors: selectors,
      tagName: el.tagName.toLowerCase()
    });
  }

  function handleClick(e) {
    if (isLocked) {
      // If already locked, unlock it to start picking again, or do nothing?
      // Let's unlock
      isLocked = false;
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    isLocked = true;
    overlay.style.border = '2px solid #34a853'; // Change color to green to indicate lock
    overlay.style.backgroundColor = 'rgba(52, 168, 83, 0.2)';

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const selectors = el ? getSelectors(el) : [];

    chrome.runtime.sendMessage({
      type: 'EXT_PICKER_CLICK',
      selectors: selectors,
      tagName: el ? el.tagName.toLowerCase() : ''
    });
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      cleanup();
    }
  }

  function cleanup() {
    window.__rpaPickerActive = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeydown, true);
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    chrome.runtime.sendMessage({ type: 'EXT_PICKER_CANCEL' });
  }

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeydown, true);

  // Listen for stop message from background
  chrome.runtime.onMessage.addListener(function listener(msg) {
    if (msg.type === 'STOP_PICKER') {
      cleanup();
      chrome.runtime.onMessage.removeListener(listener);
    }
  });

  // Listen for popup being closed via port connection
  chrome.runtime.onConnect.addListener(function connectListener(port) {
    if (port.name === 'picker-port') {
      port.onDisconnect.addListener(() => {
        if (window.__rpaPickerActive) {
          cleanup();
        }
        chrome.runtime.onConnect.removeListener(connectListener);
      });
    }
  });

})();
