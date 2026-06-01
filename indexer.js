(function() {
  if (window.__opObserverRunning) {
     return window.__opObserverRunning();
  }
  
  console.log("Operator OS Continuous Observer initialized.");

  let overlayContainer = document.getElementById('op-mapper-container');
  if (!overlayContainer) {
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'op-mapper-container';
    overlayContainer.className = 'op-mapper-container-class';
    overlayContainer.style.position = 'absolute';
    overlayContainer.style.top = '0';
    overlayContainer.style.left = '0';
    overlayContainer.style.width = '100%';
    overlayContainer.style.height = '100%';
    overlayContainer.style.pointerEvents = 'none';
    overlayContainer.style.zIndex = '2147483647';
    document.documentElement.appendChild(overlayContainer);
  }

  function isVisible(node, rect) {
    if (rect.width < 5 || rect.height < 5) return false;
    
    // Completely out of bounds (offscreen elements like Skip Navigation)
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    
    const style = window.getComputedStyle(node);
    const isMediaForVis = ['img', 'video', 'svg', 'canvas', 'picture', 'iframe', 'object', 'embed'].includes(node.tagName.toLowerCase()) || (style.backgroundImage && style.backgroundImage.includes('url('));
    if (rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.95 && !isMediaForVis) return false;
    
    if (style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1 || style.display === 'none') return false;
    
    let visibleRect = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    let parent = node;
    while (parent && parent !== document.body && parent !== document.documentElement) {
       const parentStyle = window.getComputedStyle(parent);
       if (parseFloat(parentStyle.opacity) < 0.1 || parentStyle.display === 'none') return false;
       
       if (parentStyle.overflow === 'hidden' || parentStyle.overflowY === 'hidden' || parentStyle.overflowX === 'hidden') {
          const parentRect = parent.getBoundingClientRect();
          visibleRect.top = Math.max(visibleRect.top, parentRect.top);
          visibleRect.bottom = Math.min(visibleRect.bottom, parentRect.bottom);
          visibleRect.left = Math.max(visibleRect.left, parentRect.left);
          visibleRect.right = Math.min(visibleRect.right, parentRect.right);
          if (visibleRect.bottom - visibleRect.top < 5 || visibleRect.right - visibleRect.left < 5) return false;
       }
       parent = parent.parentElement;
    }
    return true;
  }

  function triggerMap() {
    if (document.readyState === 'loading') return null;
    
    const allNodes = document.querySelectorAll('body *');
    let candidates = [];
    
    allNodes.forEach(node => {
      if (node.classList && (node.classList.contains('op-bounding-box') || node.classList.contains('op-text-label'))) return;
      if (node.id === 'op-mapper-container') return;

      const rect = node.getBoundingClientRect();
      if (!isVisible(node, rect)) return;
      
      const style = window.getComputedStyle(node);
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') || '';
      
      const isClickableTag = ['button', 'a', 'input', 'select', 'textarea'].includes(tag);
      const hasClickableRole = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch'].includes(role);
      const hasClickAttr = node.hasAttribute('onclick') || node.hasAttribute('jsaction') || node.hasAttribute('data-action');
      
      let isPointer = false;
      if (style.cursor === 'pointer') {
         const parentStyle = node.parentElement ? window.getComputedStyle(node.parentElement) : null;
         if (!parentStyle || parentStyle.cursor !== 'pointer') isPointer = true;
      }
      
      const isMedia = ['img', 'video', 'svg', 'canvas', 'picture', 'iframe', 'object', 'embed'].includes(tag) || (style.backgroundImage && style.backgroundImage.includes('url('));
      const isTextTag = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'span', 'strong', 'em', 'label'].includes(tag);
      
      let hasDirectText = false;
      for (let child of node.childNodes) {
         if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
            hasDirectText = true; break;
         }
      }
      
      let isTextLeaf = false;
      if (!isClickableTag && !isMedia && !hasClickableRole && !hasClickAttr && !isPointer) {
        if (hasDirectText && tag !== 'body' && tag !== 'html') {
           if (rect.height < window.innerHeight * 0.5) isTextLeaf = true;
        }
      }
      
      if (!(isClickableTag || hasClickableRole || hasClickAttr || isPointer || isMedia || isTextTag || isTextLeaf)) return;
      
      let prefix = 'ELM';
      let priority = 0;
      
      if (isClickableTag || hasClickableRole) {
        // <input type="submit|button|reset"> are BUTTONS — use BTN_ prefix
        // Only true form inputs (text, search, email, password, number...) get INP_
        const inputT = node.getAttribute('type') || '';
        const isButtonInput = ['submit','button','reset','image'].includes(inputT.toLowerCase());
        if (tag === 'a' || role === 'link') {
          prefix = 'LNK';
        } else if (isButtonInput || tag === 'button') {
          prefix = 'BTN';
        } else if (['input','select','textarea'].includes(tag)) {
          prefix = 'INP';
        } else {
          prefix = 'BTN';
        }
        priority = 4;
      } else if (hasClickAttr) {
        prefix = (isTextTag || hasDirectText) ? 'LNK' : 'BTN';
        priority = 3;
      } else if (isPointer) {
        prefix = (isTextTag || hasDirectText) ? 'LNK' : 'BTN';
        priority = 2;
      } else if (isMedia) {
        prefix = tag === 'iframe' ? 'FRM' : (['video', 'canvas', 'object', 'embed'].includes(tag) ? 'VID' : 'IMG');
        priority = 1;
      } else if (isTextTag || isTextLeaf) {
        prefix = 'TXT';
        priority = 0;
      } else {
        return;
      }
      // --- Spatial DOM Grouping ---
      let zone = 'Main Content';
      const container = node.closest('nav, header, footer, aside, main, form');
      if (container) {
         const t = container.tagName;
         if (t === 'NAV') zone = 'Navigation';
         else if (t === 'HEADER') zone = 'Header';
         else if (t === 'FOOTER') zone = 'Footer';
         else if (t === 'ASIDE') zone = 'Sidebar';
         else if (t === 'FORM') zone = 'Form Area';
         else if (t === 'MAIN') zone = 'Main Content';
      } else {
         // Fallbacks based on position
         if (rect.top < window.innerHeight * 0.15) zone = 'Header Area';
         else if (rect.bottom > window.innerHeight * 0.9) zone = 'Footer Area';
      }

      candidates.push({ node, rect, prefix, priority, area: rect.width * rect.height, zone, shouldDiscard: false });
    });

    // PASS 1: DOM Hierarchy Deduplication
    // Discard text nodes if they are fully contained inside an interactive element (BTN/LNK)
    // to reduce noise, since the interactive element's label already captures the text.
    let filtered = [];
    for (let i = 0; i < candidates.length; i++) {
      let child = candidates[i];
      let shouldDiscard = false;
      
      let ancestor = child.node.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        let parentCandidate = candidates.find(c => c.node === ancestor);
        if (parentCandidate && (parentCandidate.prefix === 'BTN' || parentCandidate.prefix === 'LNK')) {
          if (child.prefix === 'TXT') {
             shouldDiscard = true;
             break;
          }
        }
        ancestor = ancestor.parentElement;
      }
      
      if (!shouldDiscard) {
        filtered.push(child);
      }
    }
    
    const elements = [];
    let counters = { BTN: 0, INP: 0, LNK: 0, IMG: 0, VID: 0, TXT: 0, ELM: 0 };
    
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    
    const fragment = document.createDocumentFragment();
    
    filtered.forEach(c => {
      counters[c.prefix]++;
      const id = `${c.prefix}_${String(counters[c.prefix]).padStart(3, '0')}`;
      const node = c.node;
      const rect = c.rect;
      
      // Inject data-op-id so the executor can reliably find this exact element later
      try { node.setAttribute('data-op-id', id); } catch(_) {}
      
      // Clean non-intrusive box overlay
      const box = document.createElement('div');
      box.className = 'op-bounding-box';
      box.style.position = 'absolute';
      box.style.top = `${rect.top + scrollTop}px`;
      box.style.left = `${rect.left + scrollLeft}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      box.style.border = '2px dashed rgba(59, 130, 246, 0.8)';
      box.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
      box.style.boxSizing = 'border-box';
      box.style.pointerEvents = 'none';
      box.style.zIndex = '2147483646';
      fragment.appendChild(box);
      
      // Smart label extraction — prioritises accessible label over raw innerText
      // so icon-only buttons and SVG-icon buttons get proper names
      const ariaLbl = node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || '';
      const titleLbl = node.getAttribute('title') || node.getAttribute('data-tooltip') || node.getAttribute('data-title') || '';
      const svgTitle = (() => { try { return node.querySelector('title')?.textContent || ''; } catch(_){return '';} })();
      const childAlt = (() => { try { return node.querySelector('img, svg')?.getAttribute('alt') || node.querySelector('svg')?.getAttribute('aria-label') || ''; } catch(_){return '';} })();
      const classHint = typeof node.className === 'string' && node.className.match(/(search|close|menu|settings|profile|cart|user)/i) ? node.className.match(/(search|close|menu|settings|profile|cart|user)/i)[0] : '';
      const innerTxt = (node.innerText || '').trim().replace(/\n/g,' ').replace(/\s+/g,' ').substring(0, 80);
      const altTxt   = node.alt || '';
      
      // Prefer: aria-label > title > innerText > placeholder > child image alt > class hint > alt
      const text = (ariaLbl || titleLbl || innerTxt || svgTitle || childAlt || classHint || node.placeholder || node.getAttribute('placeholder') || altTxt || '').trim();

      const label = document.createElement('div');
      label.className = 'op-text-label';
      const _emojiInputT = (node.getAttribute('type') || '').toLowerCase();
      const _isTypeableInput = (node.tagName === 'INPUT' && !['submit','button','reset','image','checkbox','radio'].includes(_emojiInputT)) || node.tagName === 'TEXTAREA';
      
      // Improve the visual label to show the actual text so the user isn't blind
      const displayTxt = text ? text.substring(0, 20) + (text.length > 20 ? '...' : '') : '';
      label.innerText = `${id} ${node.tagName === 'IMG' ? '🖼️' : (_isTypeableInput ? '✍️' : '🖱️')} ${displayTxt}`;
      label.style.position = 'absolute';
      label.style.background = 'rgba(59, 130, 246, 0.9)';
      label.style.color = 'white';
      label.style.fontSize = '10px';
      label.style.fontWeight = '500';
      label.style.fontFamily = 'Inter, sans-serif';
      label.style.padding = '1px 3px';
      label.style.borderRadius = '3px';
      label.style.boxShadow = '0 1px 2px rgba(0,0,0,0.2)';
      label.style.zIndex = '2147483647';
      label.style.pointerEvents = 'none';
      label.style.whiteSpace = 'nowrap';
      label.style.top = `${Math.max(0, rect.top + scrollTop - 16)}px`;
      label.style.left = `${Math.max(0, rect.left + scrollLeft - 2)}px`;
      fragment.appendChild(label);
      
      let parent = node.parentElement;
      let parentContext = '';
      let depth = 0;
      while(parent && parent.tagName !== 'BODY' && depth < 3) {
        if (parent.id) parentContext += `#${parent.id} `;
        if (parent.className && typeof parent.className === 'string') parentContext += `.${parent.className.split(' ')[0]} `;
        parent = parent.parentElement;
        depth++;
      }
  
      // — Detect if this element is inside an overlay/modal/popup (z-index > 100, position fixed/sticky)
      let zIndexVal = 0;
      let isOverlay = false;
      let scanNode = node;
      for (let d = 0; d < 6 && scanNode && scanNode !== document.body; d++) {
        const s = window.getComputedStyle(scanNode);
        const z = parseInt(s.zIndex, 10);
        const pos = s.position;
        if (!isNaN(z) && z > zIndexVal) zIndexVal = z;
        if (!isNaN(z) && z > 100 && (pos === 'fixed' || pos === 'absolute' || pos === 'sticky')) {
          isOverlay = true;
        }
        scanNode = scanNode.parentElement;
      }

      // ── Semantic Intent Generation ───────────────────────────────────────────
      let semanticIntent = '';
      const tLower = text.toLowerCase();
      const pContextLower = parentContext.toLowerCase();
      
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
        const type = (node.getAttribute('type') || '').toLowerCase();
        if (type === 'search' || tLower.includes('search') || pContextLower.includes('search')) {
          semanticIntent = `Input field to search or query the site for '${text || 'keywords'}'`;
        } else if (type === 'email' || tLower.includes('email')) {
          semanticIntent = `Email input field for authentication or contact`;
        } else if (type === 'password') {
          semanticIntent = `Password input field for authentication`;
        } else {
          semanticIntent = `Text input field for entering '${text || 'data'}'`;
        }
      } else if (node.tagName === 'BUTTON' || c.prefix === 'BTN') {
        if (tLower.includes('search') || tLower.includes('find')) {
          semanticIntent = `Button to submit search query`;
        } else if (tLower.includes('sign in') || tLower.includes('log in') || tLower.includes('login')) {
          semanticIntent = `Button to authenticate and log into user account`;
        } else if (tLower.includes('add to cart') || tLower.includes('buy')) {
          semanticIntent = `Button to add item to shopping cart or purchase`;
        } else if (tLower.includes('close') || tLower.includes('dismiss') || tLower.includes('cancel')) {
          semanticIntent = `Button to close modal or dismiss dialog`;
        } else {
          semanticIntent = `Button to trigger action: ${text || 'submit'}`;
        }
      } else if (c.prefix === 'LNK') {
        if (tLower.includes('sign in') || tLower.includes('log in')) {
          semanticIntent = `Navigation link to authentication/login page`;
        } else {
          semanticIntent = `Navigation link leading to ${text || 'another page'}`;
        }
      } else if (c.prefix === 'IMG') {
        semanticIntent = `Visual image depicting ${text || 'content'}`;
      } else {
        semanticIntent = `Content element displaying ${text || 'information'}`;
      }

      elements.push({
        id:          id,
        tag:         node.tagName.toLowerCase(),
        type:        node.tagName.toLowerCase(),
        inputType:   node.getAttribute('type') || '',
        text:        text.substring(0, 500).replace(/\n/g, ' '),
        href:        node.href || node.getAttribute('href') || '',
        hrefRaw:     node.getAttribute('href') || '',
        placeholder: node.placeholder || node.getAttribute('placeholder') || '',
        name:        node.getAttribute('name') || '',
        value:       (node.tagName === 'INPUT' || node.tagName === 'BUTTON' || node.tagName === 'TEXTAREA') ? (node.value || node.getAttribute('value') || '') : '',
        ariaLabel:   node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || '',
        role:        node.getAttribute('role') || node.tagName.toLowerCase(),
        src:         node.src || node.currentSrc || '',
        alt:         node.alt || node.getAttribute('alt') || '',
        checked:     node.checked || node.getAttribute('aria-checked') === 'true' || false,
        disabled:    node.disabled || node.getAttribute('aria-disabled') === 'true' || false,
        expanded:    node.getAttribute('aria-expanded') || '',
        valuenow:    node.getAttribute('aria-valuenow') || '',
        parentContext: parentContext.trim(),
        semanticIntent: semanticIntent,
        zone:        c.zone,
        hasChildren: node.querySelector('input,button,select,textarea') !== null,
        position:    { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        zIndex:      zIndexVal,
        isOverlay:   isOverlay,
        layer:       isOverlay ? 'overlay' : 'page',
      });
    });
  
    // Atomic update to prevent flashing (using replaceChildren to bypass TrustedHTML CSP)
    overlayContainer.replaceChildren();
    overlayContainer.appendChild(fragment);
      
      // Sort: overlay elements first (they must be dismissed first),
      // then descending z-index (higher layers visible on top),
      // then ascending y position (top-to-bottom reading order)
      elements.sort((a, b) => {
        if (a.isOverlay !== b.isOverlay) return a.isOverlay ? -1 : 1;
        if (a.zIndex !== b.zIndex) return b.zIndex - a.zIndex;
        return a.position.y - b.position.y;
      });

      const graph = {
        url: window.location.href,
        title: document.title,
        elementCount: elements.length,
        elements: elements
      };
    
    window.postMessage({ type: 'ui-update', payload: JSON.stringify(graph) }, '*');
    
    return JSON.stringify(graph);
  }
  
  window.__opObserverRunning = triggerMap;

  // Delta Updates (MutationObserver)
  let mapDebounce = null;
  function scheduleMap() {
    if (mapDebounce) return;
    mapDebounce = setTimeout(() => {
       mapDebounce = null;
       triggerMap();
    }, 200); // 5 FPS delta streaming for smooth performance
  }

  const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;
    for (let m of mutations) {
       if (m.target.id === 'op-mapper-container' || (m.target.className && typeof m.target.className === 'string' && m.target.className.includes('op-'))) continue;
       shouldUpdate = true;
       break;
    }
    if (shouldUpdate) scheduleMap();
  });
  
  // Wait for document body to exist
  const initObserver = setInterval(() => {
     if (document.body) {
        clearInterval(initObserver);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        // Initial trigger
        triggerMap();
     }
  }, 100);

  window.addEventListener('scroll', scheduleMap, { passive: true });
  window.addEventListener('resize', scheduleMap, { passive: true });

  window.addEventListener('semantic-predictions', (e) => {
     const predictions = e.detail;
     const labels = document.querySelectorAll('.op-text-label');
     labels.forEach(label => {
        const id = label.innerText.split(' ')[0];
        if (predictions[id]) {
           if (!label.innerText.includes('⚡')) {
              label.innerText += ' ⚡';
              label.title = predictions[id];
              label.style.background = '#8b5cf6'; // Make it purple to indicate semantic intelligence
           }
        }
     });
  });

  return triggerMap();
})();
