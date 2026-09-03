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
    try{ el.setSelectionRange(0, el.value.length); }catch{ try{ el.select?.(); }catch{} }
    try{ document.execCommand('insertText', false, text); }catch{}

    if(el.value !== text){
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc?.set?.call(el, text);
    }
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  function sendToTabCursor(x,y){
    try{ return chrome.runtime.sendMessage({type:'UPDATE_PHANTOM_CURSOR', x, y}).catch(()=>{}); }catch{ return Promise.resolve(); }
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
    if(msg.type === 'OPENCODE_CLICK_TOP_VIDEO'){
      (async()=>{
        const waitFeed = ()=>new Promise(res=>{
          const done=()=>document.querySelectorAll('ytd-rich-item-renderer').length>=5;
          if(done()) return res(true);
          let n=0;
          const iv=setInterval(()=>{ if(done()||++n>40){clearInterval(iv);res(done());} },250);
        });
        await waitFeed();
        const parseViews=(s)=>{
          if(!s) return -1;
          const m=s.match(/([\d.,]+)\s*(Mln|M|K|mila)?/i);
          if(!m) return -1;
          let num=parseFloat(m[1].replace(/\./g,'').replace(',','.'));
          if(isNaN(num)) return -1;
          const mult=(m[2]||'').toLowerCase();
          if(mult==='m'||mult.startsWith('mln')) num*=1e6;
          else if(mult==='k'||mult.startsWith('mila')) num*=1e3;
          return num;
        };
        let best=null,bestViews=-1,bestTitle='';
        document.querySelectorAll('ytd-rich-item-renderer').forEach(card=>{
          const lines=(card.innerText||'').split('\n');
          for(const ln of lines){
            if(/visualizzazioni|views/i.test(ln)){
              const v=parseViews(ln);
              if(v>bestViews){
                const link=card.querySelector('a#video-title');
                if(link){bestViews=v;best=link;bestTitle=link.title||'';}
              }
              break;
            }
          }
        });
        if(!best){ sendResponse({success:false,error:'no videos'}); return; }
        const rect=best.getBoundingClientRect();
        const cx=Math.round(rect.left+rect.width/2), cy=Math.round(rect.top+rect.height/2);
        await sendToTabCursor(cx,cy);
        setTimeout(()=>best.click(),600);
        sendResponse({success:true,views:bestViews,title:bestTitle});
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
