// Opencode sidepanel — minimal UI bridge to background + opencode
const $ = (s) => document.querySelector(s);
const statusEl = $("#status");
const opStatus = $("#opencode-status");
const frame = $("#opencode-frame");

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (ok === true ? " ok" : ok === false ? " err" : "");
  console.log("[Opencode sidepanel]", msg);
}

async function pingOpencode() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "OPENCODE_PING_OPENCODE" });
    if (r?.success) {
      opStatus.textContent = "raggiungibile ✓";
      opStatus.style.color = "#34D399";
      // Try to embed opencode iframe (may be blocked by CSP/X-Frame-Options -> fallback)
      frame.src = "http://localhost:4096";
      setTimeout(() => {
        try {
          // If iframe still about:blank due to XFO, keep status
          if (frame.contentDocument?.body?.innerHTML === "") {
            // likely blocked, keep as is
          }
        } catch {}
      }, 1500);
    } else {
      opStatus.textContent = "non raggiungibile (avvia opencode)";
      opStatus.style.color = "#F87171";
    }
  } catch (e) {
    opStatus.textContent = "bridge non disponibile";
    opStatus.style.color = "#F87171";
  }
}

// Buttons
$("#btn-group")?.addEventListener("click", async () => {
  setStatus("Creo gruppo Opencode…");
  try {
    const r = await chrome.runtime.sendMessage({ type: "OPENCODE_CREATE_GROUP" });
    setStatus(r?.success ? `Gruppo Opencode creato (id ${r.groupId})` : "Gruppo non creato", !!r?.success);
  } catch (e) {
    setStatus("Errore gruppo: " + e.message, false);
  }
});

$("#btn-dissolve")?.addEventListener("click", async () => {
  setStatus("Sciolgo gruppo…");
  try {
    await chrome.runtime.sendMessage({ type: "OPENCODE_DISSOLVE_GROUP" });
    setStatus("Gruppo sciolto", true);
  } catch (e) {
    setStatus(e.message, false);
  }
});

$("#btn-glow")?.addEventListener("click", async () => {
  setStatus("Attivo glow su tab corrente…");
  try {
    // Use background helper (creates group + injects indicator)
    const r = await chrome.runtime.sendMessage({ type: "OPENCODE_ACTIVATE_GLOW" });
    if (r?.success) {
      setStatus("Glow attivo ✓ — vedi bordo blu jeans + cursor su pagina", true);
    } else {
      // Fallback: direct scripting injection
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Trigger indicator via runtime message (content-script listener)
          chrome.runtime.sendMessage({ type: "SHOW_AGENT_INDICATORS", ownerTabId: -1 });
        },
      }).catch(() => {});
      // Also try tabs.sendMessage directly
      await chrome.tabs.sendMessage(tab.id, { type: "SHOW_AGENT_INDICATORS", ownerTabId: tab.id }).catch(() => {});
      setStatus("Glow iniettato via scripting", true);
    }
  } catch (e) {
    setStatus("Errore glow: " + e.message, false);
    console.error(e);
  }
});

$("#btn-working")?.addEventListener("click", async () => {
  setStatus("Stato → Opencode ⏳ — agente al lavoro…");
  try {
    await chrome.runtime.sendMessage({ type: "OPENCODE_SET_WORKING" });
    setStatus("Gruppo → Opencode ⏳ — al lavoro + glow", true);
  } catch (e) { setStatus(e.message, false); }
});

$("#btn-done")?.addEventListener("click", async () => {
  setStatus("Stato → Opencode ✓ — finito…");
  try {
    await chrome.runtime.sendMessage({ type: "OPENCODE_SET_DONE" });
    setStatus("Gruppo → Opencode ✓ — fatto (torna Opencode in 4s)", true);
  } catch (e) { setStatus(e.message, false); }
});

$("#btn-stop")?.addEventListener("click", async () => {
  setStatus("Stop agent…");
  try {
    await chrome.runtime.sendMessage({ type: "OPENCODE_DEACTIVATE_GLOW" });
    setStatus("Glow spento", true);
  } catch (e) {
    setStatus(e.message, false);
  }
});

$("#btn-cursor-demo")?.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no tab");
    // Ensure glow is active first
    await chrome.tabs.sendMessage(tab.id, { type: "SHOW_AGENT_INDICATORS", ownerTabId: tab.id }).catch(() => {});
    const w = 800, h = 450;
    let x = 100, y = 100;
    setStatus("Demo cursore — guarda phantom blu jeans muoversi…", true);
    const int = setInterval(async () => {
      x = (x + 120) % w;
      y = y + 60 > h ? 100 : y + 40;
      await chrome.tabs.sendMessage(tab.id, { type: "UPDATE_PHANTOM_CURSOR", x, y }).catch(() => {});
    }, 400);
    setTimeout(() => clearInterval(int), 4000);
  } catch (e) {
    setStatus(e.message, false);
  }
});

$("#btn-open-opencode")?.addEventListener("click", async () => {
  await chrome.tabs.create({ url: "http://localhost:4096" });
});

$("#btn-ping")?.addEventListener("click", pingOpencode);

// Live session: read-only WS viewer on the sidecar. Every working/done broadcast
// lands here + persisted history (max 50) in storage.local — like Claude's
// session history, but local.
const liveEl = $("#live-state");
const histEl = $("#history");
async function pushHistory(entry) {
  try {
    const store = await chrome.storage?.local?.get?.(["opHistory"]).catch(() => ({})) || {};
    const hist = Array.isArray(store.opHistory) ? store.opHistory : [];
    hist.push({ ts: Date.now(), ...entry });
    await chrome.storage?.local?.set?.({ opHistory: hist.slice(-50) }).catch(() => {});
    renderHistory(hist.slice(-50));
  } catch {}
}
function renderHistory(hist) {
  if (!histEl) return;
  histEl.innerHTML = "";
  for (const h of hist.slice().reverse()) {
    const d = document.createElement("div");
    const t = new Date(h.ts).toLocaleTimeString();
    d.textContent = `${t} ${h.kind === "working" ? "⏳" : "✓"} ${h.tool || ""} ${h.result ? String(h.result).slice(0, 80) : ""}`;
    histEl.appendChild(d);
  }
}
function setLive(state, tool) {
  if (!liveEl) return;
  liveEl.textContent = state === "working" ? `⏳ ${tool || "working"}` : state === "done" ? "✓ idle" : state;
  liveEl.style.color = state === "working" ? "#7EB0D6" : "#34D399";
}
function connectLive() {
  let ws;
  try { ws = new WebSocket("ws://127.0.0.1:7421"); } catch { setTimeout(connectLive, 5000); return; }
  ws.onopen = () => { setLive("connected — waiting for agent", ""); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.event === "working") { setLive("working", m.tool); pushHistory({ kind: "working", tool: m.tool }); }
    else if (m.event === "done") { setLive("done"); pushHistory({ kind: "done", tool: m.tool, result: m.result, error: m.error }); }
    else if (m.event === "sync") { setLive(m.state || "idle"); }
  };
  ws.onclose = () => { setLive("sidecar off — avvia mcp-server"); setTimeout(connectLive, 5000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// Init
pingOpencode();
connectLive();
chrome.storage?.local?.get?.(["opHistory"]).then?.((v) => renderHistory(v?.opHistory || [])).catch(() => {});
console.log("[Opencode sidepanel] ready");
