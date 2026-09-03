console.log("[Opencode bg] service worker start");

const OPENCODE_GROUP_TITLE = "Opencode";
const OPENCODE_GROUP_COLOR = "blue";
const OPENCODE_HTTP = "http://localhost:4096";
const OPENCODE_WS = "ws://localhost:4096";
const HEARTBEAT_INTERVAL_MS = 5000;

let opencodeSocket = null;
let heartbeatTimer = null;
let currentGroupId = null;

async function getOrCreateOpencodeGroup(tabIds) {
  const groups = await chrome.tabGroups.query({ title: OPENCODE_GROUP_TITLE }).catch(() => []);
  if (groups && groups.length > 0) {
    const g = groups[0];
    currentGroupId = g.id;
    if (tabIds && tabIds.length) {
      await chrome.tabs.group({ tabIds, groupId: g.id }).catch((e) => console.warn("[Opencode bg] group add failed", e));
    }
    await chrome.tabGroups.update(g.id, { color: OPENCODE_GROUP_COLOR, title: OPENCODE_GROUP_TITLE }).catch(() => {});
    console.log("[Opencode bg] reused group", g.id);
    return g.id;
  }
  if (!tabIds || !tabIds.length) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) {
      console.warn("[Opencode bg] no active tab to seed group");
      return null;
    }
    tabIds = [active.id];
  }
  const groupId = await chrome.tabs.group({ tabIds }).catch((e) => {
    console.error("[Opencode bg] chrome.tabs.group failed", e);
    return null;
  });
  if (groupId == null || groupId === -1) return null;
  await chrome.tabGroups.update(groupId, { title: OPENCODE_GROUP_TITLE, color: OPENCODE_GROUP_COLOR });
  currentGroupId = groupId;
  console.log("[Opencode bg] created group", groupId, "title=Opencode color=blue");
  return groupId;
}

async function setOpencodeGroupState(state) {
  const titleMap = { working: "Opencode ⏳", done: "Opencode ✓", idle: "Opencode" };
  const title = titleMap[state] || OPENCODE_GROUP_TITLE;
  const colorMap = { working: "blue", done: "grey", idle: "blue" };
  const color = colorMap[state] || OPENCODE_GROUP_COLOR;
  const groups = await chrome.tabGroups.query({ title: OPENCODE_GROUP_TITLE }).catch(() => []);
  const allTitles = ["Opencode", "Opencode ⏳", "Opencode ✓"];
  let allGroups = [];
  for (const t of allTitles) {
    const gs = await chrome.tabGroups.query({ title: t }).catch(() => []);
    allGroups.push(...gs);
  }
  const seen = new Set();
  allGroups = allGroups.filter((g) => { if (seen.has(g.id)) return false; seen.add(g.id); return true; });
  if (allGroups.length === 0 && currentGroupId == null) return null;
  const target = allGroups[0] || (currentGroupId != null ? { id: currentGroupId } : null);
  if (!target) return null;
  await chrome.tabGroups.update(target.id, { title, color }).catch(() => {});
  currentGroupId = target.id;
  console.log(`[Opencode bg] group state -> ${state} (${title}, ${color})`);
  return target.id;
}

async function removeOpencodeGroup() {
  if (currentGroupId != null) {
    const tabs = await chrome.tabs.query({ groupId: currentGroupId }).catch(() => []);
    if (tabs.length) {
      await chrome.tabs.ungroup(tabs.map((t) => t.id)).catch(() => {});
    }
    currentGroupId = null;
    console.log("[Opencode bg] group dissolved (ungrouped)");
  } else {
        for (const t of ["Opencode", "Opencode ⏳", "Opencode ✓"]) {
      const groups = await chrome.tabGroups.query({ title: t }).catch(() => []);
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
        if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id)).catch(() => {});
      }
    }
  }
}

async function broadcastToAllTabs(msg) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const results = [];
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, msg).catch(() => null);
      results.push({ tabId: t.id, ok: !!r });
    } catch {}
  }
  return results;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/opencode-visual-indicator.js"] }).catch(()=>{});
  } catch {}
}
async function sendToTab(tabId, msg) {
  if (!tabId) return broadcastToAllTabs(msg);
  try {
    const r = await chrome.tabs.sendMessage(tabId, msg).catch(()=>null);
    if (r) return r;
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, msg).catch(()=>null);
  } catch (e) {
    return null;
  }
}

// ---- opencode bridge (http poll + ws) ----
function connectOpencodeWs() {
  if (opencodeSocket && opencodeSocket.readyState === WebSocket.OPEN) return opencodeSocket;
  try {
    const ws = new WebSocket(OPENCODE_WS);
    ws.onopen = () => console.log("[Opencode bg] opencode WS connected", OPENCODE_WS);
    ws.onclose = () => console.log("[Opencode bg] opencode WS closed");
    ws.onerror = (e) => console.warn("[Opencode bg] opencode WS error", e);
    ws.onmessage = async (ev) => {
      console.log("[Opencode bg] opencode WS msg", ev.data?.slice?.(0, 500));
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "agent_start" || data.type === "START_AGENT") {
          const tabId = data.targetTabId || null;
          if (tabId) await getOrCreateOpencodeGroup([tabId]);
          await sendToTab(tabId, { type: "SHOW_AGENT_INDICATORS", ownerTabId: tabId });
        } else if (data.type === "agent_stop" || data.type === "STOP_AGENT") {
          await sendToTab(data.targetTabId, { type: "HIDE_AGENT_INDICATORS" });
        } else if (data.type === "cursor" || data.type === "UPDATE_PHANTOM_CURSOR") {
          await sendToTab(data.targetTabId, { type: "UPDATE_PHANTOM_CURSOR", x: data.x, y: data.y });
        }
      } catch {}
    };
    opencodeSocket = ws;
    return ws;
  } catch (e) {
    console.warn("[Opencode bg] WS connect failed, will use HTTP", e);
    return null;
  }
}

async function pingOpencodeHttp() {
  try {
    const r = await fetch(`${OPENCODE_HTTP}/`, { method: "GET" }).catch(() => null);
    if (r) console.log("[Opencode bg] opencode HTTP ping", r.status);
    return !!r?.ok;
  } catch (e) {
    console.log("[Opencode bg] opencode HTTP unreachable (expected if not running)", e?.message);
    return false;
  }
}

// ---- message handling (mirrors Claude indicator.js protocol) ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[Opencode bg] onMessage", msg, "from", sender.tab?.id);
  (async () => {
    const t = msg?.type;

     if (t === "START_AGENT" || t === "SHOW_AGENT_INDICATORS") {
      const targetTabId = msg.targetTabId ?? sender.tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }).then((a) => a[0]?.id));
      if (targetTabId) await getOrCreateOpencodeGroup([targetTabId]);
      else await getOrCreateOpencodeGroup(null);
      await setOpencodeGroupState("working");
      await sendToTab(targetTabId, { type: "SHOW_AGENT_INDICATORS", ownerTabId: targetTabId });
      connectOpencodeWs();
      pingOpencodeHttp();
      sendResponse({ success: true, groupId: currentGroupId });
      return;
    }

    if (t === "STOP_AGENT" || t === "HIDE_AGENT_INDICATORS") {
      await sendToTab(msg.targetTabId ?? sender.tab?.id, { type: "HIDE_AGENT_INDICATORS" });
      await setOpencodeGroupState("idle");
      sendResponse({ success: true });
      return;
    }

    if (t === "OPENCODE_SET_WORKING") {
      await setOpencodeGroupState("working");
      await sendToTab(msg.targetTabId ?? sender.tab?.id, { type: "SHOW_AGENT_INDICATORS", ownerTabId: msg.targetTabId });
      sendResponse({ success: true });
      return;
    }

    if (t === "OPENCODE_SET_DONE") {
      await setOpencodeGroupState("done");
      await sendToTab(msg.targetTabId ?? sender.tab?.id, { type: "SHOW_STATIC_INDICATOR", dismissed: false });
      setTimeout(() => setOpencodeGroupState("idle"), 4000);
      sendResponse({ success: true });
      return;
    }

    if (t === "STOP_AGENT_DROPPED") {
      console.warn("[Opencode bg] STOP_AGENT_DROPPED — bridge may be down, falling back to HIDE", msg);
      await sendToTab(msg.targetTabId ?? sender.tab?.id, { type: "HIDE_AGENT_INDICATORS" });
      sendResponse({ success: true });
      return;
    }

    if (t === "STATIC_INDICATOR_HEARTBEAT") {
      console.log("[Opencode bg] HEARTBEAT from", sender.tab?.id);
      sendResponse({ success: true });
      return;
    }

    if (t === "SHOW_STATIC_INDICATOR") {
      await sendToTab(msg.targetTabId ?? sender.tab?.id, { type: "SHOW_STATIC_INDICATOR", dismissed: !!msg.dismissed });
      sendResponse({ success: true });
      return;
    }

    if (t === "HIDE_STATIC_INDICATOR" || t === "HIDE_STATIC_PILL" || t === "DISMISS_STATIC_INDICATOR_FOR_GROUP") {
      await sendToTab(msg.targetTabId ?? sender.tab?.id, { type: msg.type });
      // Also broadcast hide to all grouped tabs
      if (currentGroupId != null) {
        const grouped = await chrome.tabs.query({ groupId: currentGroupId }).catch(() => []);
        for (const tab of grouped) await chrome.tabs.sendMessage(tab.id, { type: msg.type }).catch(() => {});
      }
      sendResponse({ success: true });
      return;
    }

    if (t === "UPDATE_PHANTOM_CURSOR") {
      await sendToTab(msg.targetTabId ?? sender.tab?.id, { type: "UPDATE_PHANTOM_CURSOR", x: msg.x, y: msg.y });
      sendResponse({ success: true });
      return;
    }

    if (t === "SWITCH_TO_MAIN_TAB") {
      if (currentGroupId != null) {
        const grouped = await chrome.tabs.query({ groupId: currentGroupId }).catch(() => []);
        if (grouped[0]) await chrome.tabs.update(grouped[0].id, { active: true }).catch(() => {});
      }
      sendResponse({ success: true });
      return;
    }

    if (t === "HIDE_FOR_TOOL_USE") {
      await broadcastToAllTabs({ type: "HIDE_FOR_TOOL_USE" });
      sendResponse({ success: true });
      return;
    }

    if (t === "SHOW_AFTER_TOOL_USE") {
      await broadcastToAllTabs({ type: "SHOW_AFTER_TOOL_USE" });
      sendResponse({ success: true });
      return;
    }

    // Sidepanel triggers
    if (t === "OPENCODE_CREATE_GROUP") {
      const tabIds = msg.tabIds || null;
      const gid = await getOrCreateOpencodeGroup(tabIds);
      sendResponse({ success: !!gid, groupId: gid });
      return;
    }

    if (t === "OPENCODE_ACTIVATE_GLOW") {
      const targetTabId = msg.targetTabId || (await chrome.tabs.query({ active: true, currentWindow: true }).then((a) => a[0]?.id));
      if (targetTabId) {
        await getOrCreateOpencodeGroup([targetTabId]);
        await sendToTab(targetTabId, { type: "SHOW_AGENT_INDICATORS", ownerTabId: targetTabId });
      }
      sendResponse({ success: true, groupId: currentGroupId });
      return;
    }

    if (t === "OPENCODE_DEACTIVATE_GLOW") {
      await broadcastToAllTabs({ type: "HIDE_AGENT_INDICATORS" });
      sendResponse({ success: true });
      return;
    }

    if (t === "OPENCODE_DISSOLVE_GROUP") {
      await broadcastToAllTabs({ type: "HIDE_AGENT_INDICATORS" });
      await broadcastToAllTabs({ type: "HIDE_STATIC_INDICATOR" });
      await removeOpencodeGroup();
      sendResponse({ success: true });
      return;
    }

    if (t === "OPENCODE_CLICK_VIDEO") {
      const targetTabId = msg.targetTabId || (await chrome.tabs.query({ active: true, currentWindow: true }).then(a=>a[0]?.id));
      if (targetTabId) {
        const x = msg.x ?? 640, y = msg.y ?? 360;
        await sendToTab(targetTabId, { type: "UPDATE_PHANTOM_CURSOR", x, y }).catch(()=>{});
        await new Promise(r=>setTimeout(r, 500));
        await chrome.scripting.executeScript({ target:{tabId:targetTabId}, func:(xx,yy)=>{
          const el=document.elementFromPoint(xx,yy);
          const v=el?.closest?.('video') || document.querySelector('video');
          if(v){ v.pause(); v.click(); return 'video paused '+v.paused; }
          el?.click(); return 'clicked '+el?.tagName;
        }, args:[x,y]}).catch(()=>null);
      }
      sendResponse({ success: true });
      return;
    }

    if (t === "OPENCODE_PING_OPENCODE") {
      const ok = await pingOpencodeHttp();
      sendResponse({ success: ok, url: OPENCODE_HTTP });
      return;
    }

    if (t === "SW_KEEPALIVE") {
      // from offscreen.js keepalive
      sendResponse({ success: true });
      return;
    }

    // Unknown -> still ack to avoid chrome error
    sendResponse({ success: false, error: "unknown type " + t });
  })();
  return true; // keep channel open for async sendResponse
});

// Claude-faithful trigger — no autoGroup invented: group creates only when sidepanel opens
// Claude does: Oi(tabId) -> setOptions + open + Ci(tabId) -> findGroupByTab or createGroup
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

async function ensureGroupForTab(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.groupId !== -1 && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (g && (g.title === "Opencode" || g.title === "Opencode ⏳" || g.title === "Opencode ✓")) {
        return tab.groupId;
      }
    }
  } catch {}
  return await getOrCreateOpencodeGroup([tabId]);
}

chrome.action?.onClicked?.addListener(async (tab) => {
  const tabId = tab?.id;
  if (!tabId) return;
  try { await chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${encodeURIComponent(tabId)}`, enabled: true }); } catch {}
  try { await chrome.sidePanel.open({ tabId }); } catch {}
  await ensureGroupForTab(tabId);
});

chrome.commands?.onCommand?.addListener(async (cmd) => {
  if (cmd !== "toggle-side-panel") return;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) return;
  try { await chrome.sidePanel.setOptions({ tabId: active.id, path: `sidepanel.html?tabId=${encodeURIComponent(active.id)}`, enabled: true }); } catch {}
  try { await chrome.sidePanel.open({ tabId: active.id }); } catch {}
  await ensureGroupForTab(active.id);
});

// Alarms: periodic heartbeat to keep SW alive + poll opencode
const OPENCODE_BRIDGE = "http://127.0.0.1:6421/status";
let _opBridgeState = "idle";
let _opPolling = false;
async function pollOpencodeBridge() {
  if (_opPolling) return; _opPolling = true;
  try {
    const r = await fetch(OPENCODE_BRIDGE, { cache: "no-store" }).catch(()=>null);
    if (!r || !r.ok) return;
    const j = await r.json().catch(()=>null);
    if (!j) return;
    const st = j.status;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(()=>[]);
    const tabId = active?.id;
    if (!tabId) return;
    if (st === "working") {
      await ensureGroupForTab(tabId);
      await sendToTab(tabId, { type: "SHOW_AGENT_INDICATORS", ownerTabId: tabId }).catch(()=>{});
      const gid = await getCurrentGroupIdForTab(tabId).catch(()=>null);
      if (gid) await chrome.tabGroups.update(gid, { title: "Opencode \u23F3", color: OPENCODE_GROUP_COLOR }).catch(()=>{});
      if (j.click && j.click.x != null) {
        const cx=j.click.x, cy=j.click.y;
        await sendToTab(tabId, { type: "UPDATE_PHANTOM_CURSOR", x: cx, y: cy }).catch(()=>{});
        await new Promise(r=>setTimeout(r, 500));
        await chrome.scripting.executeScript({ target:{tabId}, func:(xx,yy)=>{
          const el=document.elementFromPoint(xx,yy);
          const v=el?.closest?.('video') || document.querySelector('video');
          if(v){ v.pause(); if(!v.paused) v.click(); return 'paused '+v.paused; }
          el?.click(); return el?.tagName;
        }, args:[cx,cy]}).catch(()=>null);
      }
      _opBridgeState = st;
      return;
    }
    if (st === _opBridgeState) return;
    _opBridgeState = st;
    if (st === "idle" || st === "done") {
      const gid = await getCurrentGroupIdForTab(tabId).catch(()=>null);
      if (gid) await chrome.tabGroups.update(gid, { title: "Opencode \u2713", color: "grey" }).catch(()=>{});
      await broadcastToAllTabs({ type: "HIDE_AGENT_INDICATORS" }).catch(()=>{});
      setTimeout(async ()=>{
        const cur = await getCurrentGroupIdForTab(tabId).catch(()=>null);
        if (cur) await chrome.tabGroups.update(cur, { title: "Opencode", color: OPENCODE_GROUP_COLOR }).catch(()=>{});
      }, 4000);
    }
  } finally { _opPolling = false; }
}
async function getCurrentGroupIdForTab(tabId){
  const tab = await chrome.tabs.get(tabId).catch(()=>null);
  if(!tab) return null;
  if(tab.groupId !== -1 && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return tab.groupId;
  return currentGroupId;
}
chrome.alarms.create("opencode-heartbeat", { periodInMinutes: 0.05 }); // 3s poll
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "opencode-heartbeat") {
    await pollOpencodeBridge();
  }
});

// Keepalive via offscreen document (like Claude)
async function ensureOffscreen() {
  // Only if offscreen.html exists
  const has = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Keep Opencode service worker alive + play notification sounds",
    });
    console.log("[Opencode bg] offscreen document created");
  } catch (e) {
    console.log("[Opencode bg] offscreen create skipped", e?.message);
  }
}
ensureOffscreen();

// Startup
chrome.runtime.onInstalled.addListener(() => console.log("[Opencode bg] installed 0.1.0"));
chrome.runtime.onStartup.addListener(() => console.log("[Opencode bg] startup"));

console.log("[Opencode bg] ready — group=Opencode blue, bridge=", OPENCODE_HTTP, OPENCODE_WS);
