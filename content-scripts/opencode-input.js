(function(){
  function findSearchInput(){
    return document.querySelector('input[name="search_query"]')
        || document.querySelector('ytd-searchbox input')
        || document.querySelector('input#search')
        || document.querySelector('input[type="search"]')
        || document.querySelector('input[type="text"]');
  }
  function dispatchInput(el, text){
    try{ el.focus(); }catch{}
    const isField = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    if(isField){
      try{ el.setSelectionRange(0, (el.value || '').length); }catch{ try{ el.select(); }catch{} }
      let done = false;
      try{ done = document.execCommand('insertText', false, text); }catch{}
      if(!done || el.value !== text){
        try{
          const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if(desc && typeof desc.set === 'function' && el instanceof (el.tagName === 'INPUT' ? HTMLInputElement : HTMLTextAreaElement)){
            desc.set.call(el, text);
          } else {
            el.value = text;
          }
        }catch{ try{ el.value = text; }catch{} }
      }
    } else {
      try{ el.textContent = text; }catch{}
    }
    try{ el.dispatchEvent(new Event('input', {bubbles:true})); }catch{}
    try{ el.dispatchEvent(new Event('change', {bubbles:true})); }catch{}
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
        const CARDS = ['ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-grid-video-renderer', 'ytd-compact-video-renderer'];
        const countFeed = ()=>CARDS.reduce((n,sel)=>n+document.querySelectorAll(sel).length, 0);
        const countLinks = ()=>document.querySelectorAll('a#video-title').length;
        const waitFeed = ()=>new Promise(res=>{
          // YT home lazy-renders on scroll: scroll progressively to force feed growth
          if(countLinks()>=5) return res(true);
          let n=0;
          const iv=setInterval(()=>{
            try{ window.scrollBy(0, 900); }catch{}
            if(countLinks()>=5||++n>60){clearInterval(iv);try{window.scrollTo(0,0);}catch{}res(countLinks()>=5);}
          },400);
        });
        const fedOk = await waitFeed();
        const feedCount = countFeed();
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
        let best=null,bestViews=-1,bestTitle='',bestMode='none';
        document.querySelectorAll(CARDS.join(',')).forEach(card=>{
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
        if(!best){
          // ultimate fallback: any video-title link page-wide (views may live in aria-labels the parser missed)
          const links = [...document.querySelectorAll('a#video-title')].filter(a=>a.href && a.href.includes('/watch'));
          if(links.length){
            let fb = links[0], fbViews = -2;
            for(const a of links){
              const label = a.getAttribute('aria-label') || '';
              const m2 = label.match(/([\d.,]+\s*(?:Mln|M|K|mila)?)\s*(?:di\s+)?visualizzazioni/i);
              if(m2){ let v = parseViews(m2[1]); if(v > fbViews){ fbViews = v; fb = a; } }
            }
            best = fb; bestViews = fbViews; bestTitle = fb.title||''; bestMode = 'link-fallback';
          }
          else {
            const sample = (document.querySelector('ytd-rich-grid-renderer')?.innerText || document.body.innerText || '').slice(0, 300);
            sendResponse({success:false,error:'no videos',feed:feedCount,links:countLinks(),fedOk,url:location.href,sample}); return;
          }
        }
        const rect=best.getBoundingClientRect();
        const cx=Math.round(rect.left+rect.width/2), cy=Math.round(rect.top+rect.height/2);
        await sendToTabCursor(cx,cy);
        setTimeout(()=>best.click(),600);
        sendResponse({success:true,views:bestViews,title:bestTitle,mode:bestMode||'most-viewed',feed:feedCount,url:location.href});
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
