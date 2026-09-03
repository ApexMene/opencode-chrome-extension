(function(){
  function findSearchInput(){
    return document.querySelector('input[name="search_query"]')
        || document.querySelector('ytd-searchbox input')
        || document.querySelector('input#search')
        || document.querySelector('input[type="search"]')
        || document.querySelector('input[type="text"]');
  }
  function dispatchInput(el, text){
    el.focus();
    el.select?.();
    // try execCommand first (works for synthetic)
    try{ document.execCommand('selectAll', false, null); }catch{}
    try{ document.execCommand('insertText', false, text); }catch{}

    if(el.value !== text){
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc?.set?.call(el, text);
    }
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  function pressEnter(el){
    for(const t of ['keydown','keypress','keyup']){
      el.dispatchEvent(new KeyboardEvent(t, {key:'Enter', code:'Enter', keyCode:13, bubbles:true, cancelable:true}));
    }
    el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    if(msg.type === 'OPENCODE_TYPE_TEXT'){
      (async()=>{
        let el = document.activeElement;
        if(!el || el.tagName==='BODY' || el.tagName==='HTML') el = findSearchInput();
        if(!el) { sendResponse({success:false, error:'no input'}); return; }
        // move phantom cursor visual to element center before typing
        const rect = el.getBoundingClientRect();
        const cx = Math.round(rect.left + rect.width/2);
        const cy = Math.round(rect.top + rect.height/2);
        // reuse existing phantom cursor via sending UPDATE to self? we trigger directly via DOM
        try{ await chrome.runtime.sendMessage({type:'UPDATE_PHANTOM_CURSOR', x: cx, y: cy}).catch(()=>{}); }catch{}
        // also dispatch locally for immediate visual (fallback)
        dispatchInput(el, msg.text||'');
        if(msg.submit){
          setTimeout(()=>{ 
            // submit search: for YT, navigate to results page as reliable fallback
            if(msg.text && location.hostname.includes('youtube.com')){
              const q = encodeURIComponent(msg.text);
              window.location.href = `https://www.youtube.com/results?search_query=${q}`;
            } else {
              pressEnter(el);
              const form = el.closest('form');
              form?.requestSubmit?.();
            }
          }, 250);
        }
        sendResponse({success:true});
      })();
      return true;
    }
    if(msg.type === 'OPENCODE_NAVIGATE'){
      location.href = msg.url;
      sendResponse({success:true});
    }
    if(msg.type === 'OPENCODE_PRESS_KEY'){
      document.dispatchEvent(new KeyboardEvent('keydown', {key: msg.key, bubbles:true}));
      sendResponse({success:true});
    }
  });
})();
