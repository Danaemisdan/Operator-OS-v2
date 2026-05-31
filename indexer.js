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
      
      candidates.push({ node, rect, prefix, priority, area: rect.width * rect.height, shouldDiscard: false });
    });

    let filtered = [];
    for (let i = 0; i < candidates.length; i++) {
      let c1 = candidates[i];
      let isSubset = false;
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        let c2 = candidates[j];
        
        let overlapArea = 0;
        let overlapX = Math.max(0, Math.min(c1.rect.right, c2.rect.right) - Math.max(c1.rect.left, c2.rect.left));
        let overlapY = Math.max(0, Math.min(c1.rect.bottom, c2.rect.bottom) - Math.max(c1.rect.top, c2.rect.top));
        if (overlapX > 0 && overlapY > 0) overlapArea = overlapX * overlapY;
        
        let c1SubsetOfC2 = overlapArea > 0.8 * c1.area;
        let c2SubsetOfC1 = overlapArea > 0.8 * c2.area;
        
        if (c1SubsetOfC2 && c2SubsetOfC1) {
           if (c2.priority > c1.priority) {
              isSubset = true; break;
           } else if (c2.priority === c1.priority && c2.area > c1.area) {
              isSubset = true; break;
           } else if (c2.priority === c1.priority && c2.area === c1.area && j < i) {
              isSubset = true; break;
           }
        } else if (c1SubsetOfC2) {
           if (c2.priority >= 2 && c1.priority === 0) {
              isSubset = true; break;
           }
           if (c2.priority === 0 && c1.priority === 0) {
              isSubset = true; break;
           }
           if (c1.priority >= 2 && c2.priority >= 1 && c2.priority <= c1.priority) {
              c2.shouldDiscard = true;
           }
        }
      }
      if (!isSubset) filtered.push(c1);
    }
    
    filtered = filtered.filter(c => !c.shouldDiscard);
    
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
      
      const label = document.createElement('div');
      label.className = 'op-text-label';
      const _emojiInputT = (node.getAttribute('type') || '').toLowerCase();
      const _isTypeableInput = (node.tagName === 'INPUT' && !['submit','button','reset','image','checkbox','radio'].includes(_emojiInputT)) || node.tagName === 'TEXTAREA';
      label.innerText = `${id} ${node.tagName === 'IMG' ? '🖼️' : (_isTypeableInput ? '✍️' : '🖱️')}`;
      label.style.position = 'absolute';
      label.style.background = '#3b82f6';
      label.style.color = 'white';
      label.style.fontSize = '11px';
      label.style.fontWeight = 'bold';
      label.style.fontFamily = 'Inter, sans-serif';
      label.style.padding = '2px 4px';
      label.style.borderRadius = '4px';
      label.style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';
      label.style.zIndex = '2147483647';
      label.style.pointerEvents = 'none';
      label.style.whiteSpace = 'nowrap';
      label.style.top = `${Math.max(0, rect.top + scrollTop - 20)}px`;
      label.style.left = `${Math.max(0, rect.left + scrollLeft - 4)}px`;
      fragment.appendChild(label);
      
      // Smart label extraction — prioritises accessible label over raw innerText
      // so icon-only buttons and SVG-icon buttons get proper names
      const ariaLbl = node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || '';
      const titleLbl = node.getAttribute('title') || node.getAttribute('data-tooltip') || node.getAttribute('data-title') || '';
      const svgTitle = (() => { try { return node.querySelector('title')?.textContent || ''; } catch(_){return '';} })();
      const innerTxt = (node.innerText || '').trim().replace(/\n/g,' ').replace(/\s+/g,' ').substring(0, 80);
      const altTxt   = node.alt || '';
      // Prefer: aria-label > innerText (if short enough) > title > SVG title > placeholder > alt
      const text = (ariaLbl || (innerTxt.length < 80 && innerTxt) || titleLbl || svgTitle || node.placeholder || node.getAttribute('placeholder') || altTxt || '').trim();
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
        value:       (node.tagName === 'INPUT' || node.tagName === 'BUTTON') ? (node.value || node.getAttribute('value') || '') : '',
        ariaLabel:   node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || '',
        role:        node.getAttribute('role') || node.tagName.toLowerCase(),
        src:         node.src || node.currentSrc || '',
        parentContext: parentContext.trim(),
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
