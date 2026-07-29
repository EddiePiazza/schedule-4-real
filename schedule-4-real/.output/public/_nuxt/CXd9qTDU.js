import{r as ve}from"./D0oxgzyL.js";import{r as be}from"./CtTH93wl.js";import{r as we}from"./Bve63nmb.js";import{o as i,c as n,a as e,e as le,h as o,b as I,t as g,n as z,f as S,m as f,x as de,y as te,g as _e,z as xe,F as B,r as G,A as Z,i as L,v as Y,s as ke,d as Oe,j as De,k as Ce,D as ae,B as Se,p as R}from"./CDl6N6H7.js";import{s as Ie}from"./C5Ahm2HN.js";import{r as oe}from"./Bf072VMO.js";import{r as Ae}from"./uVJ3wpxs.js";import{r as re}from"./lI7Oze3j.js";function Pe(d,m){return i(),n("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 24 24",fill:"currentColor","aria-hidden":"true","data-slot":"icon"},[e("path",{d:"M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z"})])}const Ne={key:0,class:"flex items-start gap-2 px-3 py-1.5"},Ee={class:"flex-1 min-w-0"},Te={class:"text-base font-medium truncate"},$e={key:0,class:"mt-1.5 bg-gray-900/80 rounded-lg p-2.5 border border-gray-700/50 overflow-x-auto"},je={class:"text-base text-gray-400 whitespace-pre-wrap break-all leading-relaxed"},Fe={key:1,class:"flex justify-end px-3 py-1"},Ve={class:"max-w-[85%] bg-spider-green-600/20 border border-spider-green-500/30 rounded-2xl rounded-tr-md px-3.5 py-2"},Le={class:"text-base text-gray-200 whitespace-pre-wrap break-words leading-relaxed"},Re={key:2,class:"flex justify-start px-3 py-1"},Ue={class:"max-w-[85%] bg-violet-600/10 border border-violet-500/20 rounded-2xl rounded-tl-md px-3.5 py-2"},Me={class:"text-base text-gray-200 whitespace-pre-wrap break-words leading-relaxed"},He={key:3,class:"flex justify-start px-3 py-1"},We={class:"max-w-[85%] bg-amber-600/10 border border-amber-500/20 rounded-2xl rounded-tl-md px-3.5 py-2"},Be={class:"flex items-center gap-1.5 mb-1"},Ge={class:"text-base text-gray-200 whitespace-pre-wrap break-words leading-relaxed"},Ye=le({__name:"AIChatMessage",props:{msg:{}},setup(d){const m=f(!1);function v(c){return c?c.replace(/_/g," "):"tool"}function O(c){try{return JSON.stringify(JSON.parse(c),null,2)}catch{return c}}return(c,u)=>d.msg.role==="tool"?(i(),n("div",Ne,[e("div",Ee,[e("button",{onClick:u[0]||(u[0]=D=>m.value=!o(m)),class:"flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors"},[I(o(ve),{class:"w-3.5 h-3.5 shrink-0"}),e("span",Te,g(v(d.msg.toolName)),1),I(o(be),{class:z(["w-3 h-3 transition-transform shrink-0",o(m)?"rotate-90":""])},null,8,["class"])]),o(m)?(i(),n("div",$e,[e("pre",je,g(O(d.msg.content)),1)])):S("",!0)])])):d.msg.role==="user"?(i(),n("div",Fe,[e("div",Ve,[e("p",Le,g(d.msg.content),1)])])):d.msg.role==="assistant"?(i(),n("div",Re,[e("div",Ue,[e("p",Me,g(d.msg.content),1)])])):d.msg.role==="autonomous"?(i(),n("div",He,[e("div",We,[e("div",Be,[I(o(we),{class:"w-3.5 h-3.5 text-amber-400"}),u[1]||(u[1]=e("span",{class:"text-base text-amber-400/80 font-medium"},"Autonomous",-1))]),e("p",Ge,g(d.msg.content),1)])])):S("",!0)}}),Ke=Object.assign(Ye,{__name:"AIChatMessage"}),s=f([]),$=f(!1),N=f("default");let se=!1;function Je(){const{getAuthHeaders:d}=de();async function m(h,b={}){if(!(!h.trim()||$.value)){s.value=[...s.value,{timestamp:new Date().toISOString(),role:"user",content:h.trim()}],$.value=!0;try{const _=await $fetch("/api/ai/chat",{method:"POST",headers:d(),body:{message:h.trim(),sessionId:N.value,temperature:b.temperature,presetId:b.presetId}});N.value=_.sessionId;for(const p of _.toolCalls)s.value=[...s.value,{timestamp:new Date().toISOString(),role:"tool",content:JSON.stringify(p.result),toolName:p.name,toolArgs:p.args}],u(p.name,p.result);s.value=[...s.value,{timestamp:new Date().toISOString(),role:"assistant",content:_.response}]}catch(_){s.value=[...s.value,{timestamp:new Date().toISOString(),role:"assistant",content:`Error: ${_.data?.message||_.message||"Failed to reach AI assistant"}`}]}finally{$.value=!1}}}async function v(){try{const h=await $fetch("/api/ai/chat-history",{params:{sessionId:N.value,limit:50}});s.value=h.messages,h.sessionId&&(N.value=h.sessionId)}catch{}}async function O(h,b={}){if(!h.trim()||$.value)return;const _=h.trim();s.value=[...s.value,{timestamp:new Date().toISOString(),role:"user",content:_}],$.value=!0;const p=s.value.length;s.value=[...s.value,{timestamp:new Date().toISOString(),role:"assistant",content:""}];try{const A=d(),w=await fetch("/api/ai/chat-stream",{method:"POST",headers:{"Content-Type":"application/json",...A},body:JSON.stringify({message:_,sessionId:N.value,temperature:b.temperature,presetId:b.presetId})});if(!w.ok||!w.body)throw new Error(`HTTP ${w.status}`);const j=w.body.getReader(),X=new TextDecoder;let U="";for(;;){const{done:P,value:F}=await j.read();if(P)break;U+=X.decode(F,{stream:!0});const K=U.split(`

`);U=K.pop()||"";for(const E of K){if(!E.startsWith("data: "))continue;let y=null;try{y=JSON.parse(E.slice(6))}catch{continue}if(y.type==="token"){const C=s.value[p];if(C){const x=[...s.value];x[p]={...C,content:(C.content||"")+y.token},s.value=x}}else if(y.type==="tool")s.value=[...s.value,{timestamp:new Date().toISOString(),role:"tool",content:JSON.stringify(y.result),toolName:y.name,toolArgs:y.args}],u(y.name,y.result);else if(y.type==="done")y.sessionId&&(N.value=y.sessionId);else if(y.type==="error"){const C=s.value[p];if(C){const x=[...s.value];x[p]={...C,content:`Error: ${y.message||"stream error"}`},s.value=x}}}}}catch(A){const w=s.value[p];if(w){const j=[...s.value];j[p]={...w,content:`Error: ${A?.message||"stream failed"}`},s.value=j}}finally{$.value=!1}}async function c(){try{await $fetch("/api/ai/chat-history",{method:"DELETE",headers:d(),body:{sessionId:N.value}}),s.value=[]}catch{}}function u(h,b){typeof window>"u"||h==="propose_trigger_scheme"&&b?.success&&window.dispatchEvent(new CustomEvent("ai-proposal-created",{detail:{proposalId:b.proposalId}}))}function D(){se||typeof window>"u"||(se=!0,window.addEventListener("ai-autonomous",(h=>{const b=h.detail;b?.response&&(s.value=[...s.value,{timestamp:b.timestamp||new Date().toISOString(),role:"autonomous",content:b.response}])})))}return D(),{messages:s,loading:$,sessionId:N,sendMessage:m,sendMessageStreaming:O,loadHistory:v,clearHistory:c}}const ie=[{key:"environment",label:"Environment",icon:"🌡️",color:"emerald"},{key:"cultivation",label:"Cultivation",icon:"🌱",color:"lime"},{key:"devices",label:"Devices",icon:"⚡",color:"amber"},{key:"triggers",label:"Triggers",icon:"🔧",color:"violet"},{key:"reports",label:"Reports",icon:"📊",color:"sky"},{key:"safety",label:"Safety",icon:"🚨",color:"rose"}],ze=[{id:"env-diagnose",category:"environment",label:"Diagnose my VPD",description:"Full diagnosis of current VPD, temp and humidity vs targets.",prompt:`Diagnose my current environment.

Use the live snapshot in your system prompt if fresh (sensor age < 60s). Call get_vpd_config to read the target range for the current plant stage.

Answer in this structure:
1. First line: one-liner verdict (OK / attention needed / critical) with current Leaf VPD.
2. Temperature: current vs ideal range (day or night).
3. Humidity: current vs ideal range derived from VPD target.
4. Root cause if out of range (humidity / temperature / both).
5. Suggested action (only if an action is clearly needed).`,temperature:.1},{id:"env-trends-24h",category:"environment",label:"Last 24h trends",description:"Min/avg/max temp, humi, VPD over the last day with interpretation.",prompt:`Analyse the last 24h environmental trends.

Call get_sensor_trends with range="24h" and compare against get_vpd_config targets. Flag any of: temp spikes, humidity oscillations, VPD drifting outside the stage target.

Output:
• 1 line verdict
• min / avg / max for temp, humidity, leaf VPD
• key anomaly if any (or "stable")
• recommendation (only if a clear pattern justifies it)`},{id:"env-day-vs-night",category:"environment",label:"Day vs Night review",description:"Compare day and night cycle averages over the last week.",prompt:`Compare my day vs night climate for the last 7 days.

Use compare_periods with kind="day_vs_night". Focus on whether the night temperature drop is within the healthy 2-6°C range and whether humidity drift during dark hours increases mold risk.

Output: concise bullets + a recommendation if night temp/humidity are off.`},{id:"env-anomalies",category:"environment",label:"Detect anomalies",description:"Look for flatlined sensors, spikes, oscillations in the last 12h.",prompt:`Scan the last 12 hours for environmental anomalies.

Use detect_anomalies with range="12h". For every finding, briefly explain the impact on the plants and whether it's hardware (sensor disconnected) or environmental (stuck fan, humidifier overshoot...).

If there are no findings say so on one line and stop.`,temperature:.15},{id:"env-stage-check",category:"environment",label:"Right for my stage?",description:"Check if current Leaf VPD fits the plant stage from the Lab.",prompt:`Am I running the correct Leaf VPD for my current plant stage?

1. get_plant_stage for the active plant.
2. get_vpd_config to see the configured target.
3. Compare current Leaf VPD (use snapshot if fresh) against the ideal range for that stage.

Answer: "Stage X → ideal Y. Current Leaf VPD Z → OK / too low / too high" + one concrete remedy if off.`,temperature:.1},{id:"grow-overview",category:"cultivation",label:"Grow overview",description:"Active plants, strains, stages, days, latest observation.",prompt:`Give me a short overview of my active grow.

Use get_lab_summary. Output:
• Number of active plants + strain mix
• Current stage(s)
• Days since start
• Latest observation headline (if any)
• One suggestion for today based on stage`},{id:"grow-today",category:"cultivation",label:"What should I do today?",description:"Actionable tasks for the day based on plant stage and data.",prompt:`Suggest up to 3 cultivation tasks I should do TODAY.

Base them on:
• Plant stage (get_plant_stage)
• Last observation + days since last observation (get_lab_summary)
• Current environment health (use snapshot)

Output: numbered list, 3 items max, each 1 line. Skip items that are already covered.`},{id:"grow-harvest",category:"cultivation",label:"Harvest timing",description:"Rough harvest window based on stage and strain history.",prompt:`Estimate how many days until harvest.

Use get_lab_summary + get_plant_stage. For cannabis, typical flower length is 7-10 weeks depending on strain (indica 7-8, hybrid 8-9, sativa 9-11). If the strain is not recognised, say "unknown strain — default hybrid 8-9 weeks".

Output: "Strain X at stage Y, day N of flower → approx harvest in 7-10 days window." One line.`},{id:"grow-phenos",category:"cultivation",label:"Compare phenos",description:"Compare active hunt / phenotypes by observation history.",prompt:`Summarise and compare my active phenotypes.

Use get_lab_summary. Group observations per plant_code. Mention: plants with vigour notes, plants flagged with issues, keepers vs cull candidates. Keep under 6 lines.`},{id:"grow-journal",category:"cultivation",label:"Generate journal entry",description:"One-paragraph Discord-style journal entry for today.",prompt:`Write a one-paragraph grow journal entry for today (ready to post on Discord).

Pull data from get_lab_summary + the live snapshot. Include:
• Date, stage, day #
• Climate summary (temp, humidity, Leaf VPD) in one sentence
• One cultivation observation worth sharing
• End with a hashtag-free one-liner

Keep it under 400 characters.`,temperature:.5},{id:"dev-overview",category:"devices",label:"Device status",description:"All outlets, blower, fan, climate modules at a glance.",prompt:`Give me the status of every device.

Use the live snapshot (outlets + blower + fan). Format as a compact list. Flag any outlet that is ON but its socket name implies "should be OFF at this time" (like a humidifier in a daytime cycle where humidity is already fine).`},{id:"dev-stuck",category:"devices",label:"Detect stuck devices",description:"Find outlets ON longer than expected / events missing.",prompt:`Look for devices that may be stuck in the wrong state.

1. get_outlet_states + get_recent_ai_actions + get_event_log (limit=30).
2. Cross-check: if an outlet has been ON > 2 hours without any OFF event recorded, flag it.
3. If the AI recently set something OFF but it's still ON in live state, flag it (command not acknowledged).

Output: list of flags or "All devices look consistent."`},{id:"dev-energy",category:"devices",label:"Energy last 24h",description:"kWh + cost breakdown for the last day.",prompt:`What did my grow consume in the last 24 hours?

Use get_power_summary range="24h". Show total kWh + cost, then top 3 consumers. One extra line with a tip if one device is clearly dominant.`},{id:"dev-extractor",category:"devices",label:"Is my extractor OK?",description:"Check blower curve + calibration quality.",prompt:`Analyse my extractor (blower) performance.

1. get_blower_state to see if it's running.
2. get_calibration_data — is there calibration for current period?
3. get_automation_flow — does the blower curve have sane points?
4. Interpret: does the blower effectively move temp/humidity?

Output: "Extractor: healthy / marginal / poor" + reasoning in 2-3 lines.`,temperature:.15},{id:"dev-calibrate",category:"devices",label:"Calibrate blower",description:"Start a smart blower calibration for the current period.",prompt:`Start a blower calibration for the current light period.

1. get_day_night_schedule to detect day/night.
2. Confirm Blower AI mode is ON (get_ai_modes). If not, tell the user to enable it and stop.
3. Run start_calibration with period="day" or "night".
4. Tell the user this will take up to 15 min and that climate sockets will be briefly disabled.`},{id:"trg-audit",category:"triggers",label:"Audit my triggers",description:"Find orphan actions, impossible AND gates, conflicts.",prompt:`Audit my trigger flow for issues.

Use get_flow_analysis. For each finding (orphanActions / suspiciousANDs / contradictions), explain in plain English what the user should fix.

If clean, respond "Flow is consistent." and stop.`,temperature:.1},{id:"trg-why",category:"triggers",label:"Why did X turn ON/OFF?",description:"Explain the cause of the last outlet state change.",prompt:`Explain why devices changed state recently.

1. get_event_log limit=10.
2. get_execution_log range="1h".
3. get_recent_ai_actions limit=5.
4. Correlate: which state change came from a trigger, from the VPD supervisor, from the user, or from an AI action.

Output: up to 5 bullets, each "[time] socket → action — cause".`},{id:"trg-suggest",category:"triggers",label:"Suggest automations",description:"Propose new trigger rules based on history.",prompt:`Suggest up to 3 new automation rules that would help me.

Base the suggestions on:
• get_sensor_trends range="7d" — recurring out-of-range conditions
• get_event_log — devices toggled manually frequently
• get_vpd_config — missing roles (e.g. no humidifier role assigned but humidity consistently low)

Output: numbered list. Each item = trigger condition + action + why it helps.`,temperature:.35},{id:"trg-vpd-strategy",category:"triggers",label:"Explain VPD strategy",description:"Human-friendly summary of active VPD control.",prompt:`Summarise the VPD automation I currently have configured.

Use get_vpd_config + get_automation_flow. Say:
• Mode (manual / fixed_stage / plant_stage)
• Target VPD range
• Which device plays which role (extractor, heater, humidifier, dehumidifier, circulator)
• Day / night ideal temperature ranges
• One recommendation if any role is missing or suboptimal.`},{id:"trg-curve",category:"triggers",label:"Review blower curve",description:"Is the current blower curve efficient?",prompt:`Review my blower curve vs my calibration data.

Call get_automation_flow + get_calibration_data. For each of the current period's curves (temp, humi):
• Check that the speed points roughly match the calibration measurements.
• Flag if any point is below 25% (device minimum) or at 100% with no measured improvement.
• Propose concrete replacement points if needed.`},{id:"trg-improve",category:"triggers",label:"Improve my triggers",description:"Concrete upgrades — proposed as a scheme the user can Save or edit.",prompt:`TASK: Produce an improved automation scheme. This task is completed ONLY by calling the \`propose_trigger_scheme\` tool. A textual answer is not acceptable.

Steps:
1. Call get_automation_flow (to see current rules).
2. Call get_flow_analysis (find inconsistencies).
3. Call get_sensor_trends range="7d" AND get_event_log AND get_vpd_config (find recurring problems).
4. Build an IMPROVED, COMPLETE replacement rule set (keep what works, fix what's broken, add missing safety coverage).
5. Call \`propose_trigger_scheme\` with:
   - title: "Improved automation"
   - description: one short paragraph — list the concrete changes and cite the data that justifies each (e.g. "humidifier cycled 15× in 2h → added 4% hysteresis", "no safety rule for temp > 32 → added heater+humidifier kill switch").
   - rules: array of { name, condition: { sensor, operator, value, hysteresis? }, action: { socket: "O1|O2|…|blower|fan|heater|humidifier|dehumidifier", action: "on|off", mandatoryOn?, mandatoryOff? } } — 4 to 10 rules total.
6. ONLY AFTER the tool returns success, reply with exactly this single line: "✅ Proposed <N> improved rules — review in the modal."

DO NOT diagnose current conditions. DO NOT recommend in prose. DO NOT ask for confirmation. Your output is a tool call, not a text answer.`,temperature:.25},{id:"trg-scheme-fire",category:"triggers",label:"Design: fire safety",description:"Full fire-safety scheme (cuts heaters, vents, alarms).",prompt:`Design a complete FIRE-SAFETY automation scheme and call propose_trigger_scheme.

Target scenario: abnormal temperature spike (>35°C) or sustained very high temps that could indicate electrical / lamp failure.

Rules to include (adapt to what my devices can do — check get_outlet_states + get_vpd_config first):
• temp > 35 → turn OFF every heater outlet (mandatoryOff=true, so nothing else can re-enable it)
• temp > 35 → turn OFF humidifier (steam near fire = bad)
• temp > 33 → force blower / extractor to 100% (via a dedicated socket action)
• temp > 38 → kill all non-critical outlets (lights / pump) with mandatoryOff

Pass a clear title ("Fire safety") and a one-paragraph description explaining why each rule is there.

After proposing, STOP and confirm the proposal ID. The user will Save or Cancel from the UI.`,temperature:.2},{id:"trg-scheme-water",category:"triggers",label:"Design: auto watering",description:"Scheduled pump cycles with safety cutoffs.",prompt:`Design an automated WATERING scheme and call propose_trigger_scheme.

Assumptions (confirm via get_outlet_states):
• There is a pump outlet (often O3 or O4).
• There is a humidity sensor we can use as a proxy for high-moisture cutoff.

Rules to include:
• Short daily pump cycle: humi < 55 → pump ON (for a brief window — if no scheduling, use hysteresis)
• Safety cutoff: humi > 80 → pump OFF mandatoryOff
• Overheat safety: temp > 34 → pump OFF mandatoryOff

Title "Auto watering v1". Description must explain the cycle + the two safety cuts.

After calling propose_trigger_scheme, stop and tell the user to review in the modal.`,temperature:.2},{id:"trg-scheme-vpd",category:"triggers",label:"Design: VPD optimiser",description:"Full coordinated VPD control (heater/dehumi/humi/fan).",prompt:`Design a full VPD-optimising scheme and call propose_trigger_scheme.

Steps:
1. get_vpd_config to read the stage target.
2. get_outlet_states to see what devices are available (fan, heater, humidifier, dehumidifier).
3. Build a set of coordinated rules (one per role) that converge the room on the VPD target:
   • humi below (target - hysteresis) AND temp in range → humidifier ON
   • humi above (target + hysteresis) → dehumidifier ON
   • temp below ideal min → heater ON
   • temp above ideal max → fan 100% ON
   • safety caps: any sensor way out of range → mandatoryOff on opposite role (no humidifier fighting a dehumidifier)

Title "VPD optimiser v1", description explains the convergence strategy.

Propose it, then tell the user to review.`,temperature:.25},{id:"trg-scheme-custom",category:"triggers",label:"Design: custom scheme…",description:"Describe your goal and let the AI design the rules.",prompt:'I want you to design a custom trigger scheme for me. First, ask me to describe my goal in one sentence (what the rules should achieve and any specific constraints like "must keep humidifier off at night"). When I reply, call propose_trigger_scheme with a complete rule set that covers safety + happy-path. Limit to at most 8 rules. Title it after my goal. Description must explain each rule in plain English.',temperature:.35},{id:"rep-daily",category:"reports",label:"Daily report",description:"Morning briefing with climate, devices and cultivation.",prompt:`Produce my daily report.

Structure:
1. Climate 24h (min/avg/max temp, humi, leaf VPD) — use get_sensor_trends.
2. Cultivation (stage + days + any recent observation) — use get_lab_summary.
3. Automation (VPD actions taken in last 24h) — use get_execution_log range="24h".
4. Energy last 24h — use get_power_summary.
5. One headline: "Today I'll pay attention to: ..."`},{id:"rep-critical-hour",category:"reports",label:"Most critical hour",description:"Which hour of the day is hardest on the climate.",prompt:`Which hour of the day is the hardest to keep VPD in range?

Use get_sensor_trends multiple ranges if needed. Identify the worst hour in the last 7 days based on deviation from the ideal Leaf VPD for the current plant stage.

Output: "Hour XX:00 — Leaf VPD avg Y (deviation Z). Likely cause: ..."`},{id:"rep-week-cost",category:"reports",label:"Cost this week",description:"Energy cost for the last 7 days by device.",prompt:`Report my grow room cost for the last 7 days.

Use get_power_summary range="7d". Output total cost, daily average, top 3 consumers. One sentence comparing with the previous week if feasible.`},{id:"rep-discord",category:"reports",label:"Shareable summary",description:"Discord/Telegram-style update of today.",prompt:`Write a 400-char status update for sharing on Discord.

Include: stage, day #, current VPD, top achievement of the day (stability, low cost, etc.), one amusing plant fact you can mention as flavour.

No hashtags, no markdown, no emoji spam. Up to 2 short emojis allowed.`,temperature:.55},{id:"rep-compare-yesterday",category:"reports",label:"Today vs yesterday",description:"Quick side-by-side climate delta.",prompt:`Compare today vs yesterday for temp, humidity, VPD.

Use compare_periods with kind="today_vs_yesterday". Output a compact 4-line table-like summary and one sentence explaining the dominant delta.`},{id:"saf-check",category:"safety",label:"Safety check",description:"Full safety subsystem overview.",prompt:`Run a full safety check on the grow room.

Use: get_safety_status + get_alarms + get_system_health + detect_anomalies range="4h".

Output:
1. Verdict on first line (GREEN / YELLOW / RED).
2. One bullet per concern.
3. If GREEN, stop at one line — don't pad.`,temperature:.1},{id:"saf-timeouts",category:"safety",label:"Safety timeouts",description:"Check max-on durations for heater/humidifier/blower.",prompt:`Verify my device safety timeouts are appropriate.

Typical safe maximums:
• Heater: 60 min continuous
• Humidifier: 30 min continuous
• Dehumidifier: 60 min continuous
• Blower: 120 min continuous
• Fan: no limit

Check against current configuration (get_vpd_config + get_outlet_states) and point out any role whose timeout is disabled or too high.`},{id:"saf-runaway",category:"safety",label:"Runaway devices",description:"Any device ON for abnormally long?",prompt:`Are any devices ON for an abnormally long time?

Use get_event_log limit=50 + get_recent_ai_actions.
• For each AI-controlled outlet (check get_ai_modes), compute approximate ON duration.
• Flag anything > 90 min continuous.

If nothing runaway, respond "No runaway devices detected."`},{id:"saf-risk",category:"safety",label:"Current risk score",description:"0-10 health score with top risks.",prompt:`Give the grow room a current risk score 0-10 (0 = perfect, 10 = disaster).

Consider: sensor staleness, safety flags (get_safety_status), alarms (get_alarms), anomalies (detect_anomalies), flow issues (get_flow_analysis).

Output: "Risk: N/10. Top risks: ..." in 3 lines max.`,temperature:.1},{id:"saf-simulate",category:"safety",label:"Emergency drill",description:"What would happen if temp spikes to 33°C right now?",prompt:`Simulate the system's response to a sudden temperature emergency (temp spiking to 33°C at current humidity).

Use get_vpd_config + get_automation_flow + get_ai_modes. Describe step by step: which safety rules activate, which devices switch, whether the blower would reach 100%, whether the user-trigger mandatoryOff flags would block anything.

Output 5 concise steps.`}],ce="s4r:ai-custom-presets",k=f([]);let ne=!1;function Xe(){if(!(typeof localStorage>"u"))try{const d=localStorage.getItem(ce);if(!d)return;const m=JSON.parse(d);Array.isArray(m)&&(k.value=m.slice(0,100))}catch{}}function q(){if(!(typeof localStorage>"u"))try{localStorage.setItem(ce,JSON.stringify(k.value))}catch{}}function Ze(){ne||(Xe(),ne=!0);function d(c){const u={...c,id:`u_${Date.now()}_${Math.random().toString(36).slice(2,6)}`};return k.value=[...k.value,u],q(),u}function m(c){k.value=k.value.filter(u=>u.id!==c),q()}function v(c,u){k.value=k.value.map(D=>D.id===c?{...D,...u,id:D.id}:D),q()}function O(c){return k.value.filter(u=>u.category===c)}return{customPresets:k,add:d,remove:m,update:v,byCategory:O}}const qe={class:"flex flex-col h-full relative"},Qe={class:"flex items-center justify-between px-4 py-2.5 border-b border-gray-700/50 shrink-0"},et={class:"flex items-center gap-2"},tt={class:"w-6 h-6 rounded-lg bg-gradient-to-br from-violet-500/30 to-purple-600/20 flex items-center justify-center"},at={class:"flex items-center gap-1"},ot={class:"relative"},rt={key:0,class:"absolute right-0 top-full mt-1 w-40 bg-gray-900 border border-gray-700/60 rounded-xl shadow-2xl z-20 py-1 max-h-80 overflow-y-auto scrollbar-thin"},st=["onClick"],it={key:0,class:"flex flex-col h-full px-3"},nt={class:"flex flex-col items-center text-center gap-2 py-4"},lt={class:"w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-600/10 flex items-center justify-center"},dt={class:"flex gap-1 overflow-x-auto scrollbar-thin pb-2 mx-0"},ct=["onClick"],ut={class:"text-base"},mt={class:"flex flex-col gap-1.5 overflow-y-auto scrollbar-thin pb-2 pr-1"},pt=["onClick","title"],gt={class:"text-base text-gray-200 font-medium flex items-center gap-1.5"},ht={key:0,class:"text-base"},yt={class:"text-base text-gray-500 leading-snug mt-0.5"},ft=["onClick"],vt={class:"w-full max-w-sm bg-gray-800 border border-gray-700/50 rounded-2xl p-4 space-y-2"},bt={class:"flex items-center justify-between gap-2"},wt=["value"],_t={class:"flex items-center justify-end gap-2 pt-1"},xt=["disabled"],kt={key:2,class:"flex justify-start px-3 py-1"},Ot={class:"bg-violet-600/10 border border-violet-500/20 rounded-2xl rounded-tl-md px-3.5 py-2 flex flex-col gap-1"},Dt={class:"flex items-center gap-2"},Ct={class:"text-base text-violet-400/80"},St={class:"text-violet-400/50"},It={key:0,class:"text-base text-violet-300/60 font-mono"},At={class:"px-3 py-2.5 border-t border-gray-700/50 shrink-0"},Pt={class:"flex gap-2"},Nt=["disabled"],Et=["disabled"],Tt=le({__name:"AIChatPanel",emits:["close"],setup(d){const{messages:m,loading:v,sendMessage:O,loadHistory:c,clearHistory:u}=Je(),{customPresets:D,add:h,remove:b}=Ze(),{getAuthHeaders:_}=de(),p=[{code:"auto",label:"Auto",emoji:"🌐"},{code:"en",label:"English",emoji:"🇬🇧"},{code:"es",label:"Español",emoji:"🇪🇸"},{code:"pt",label:"Português",emoji:"🇵🇹"},{code:"fr",label:"Français",emoji:"🇫🇷"},{code:"de",label:"Deutsch",emoji:"🇩🇪"},{code:"it",label:"Italiano",emoji:"🇮🇹"},{code:"ca",label:"Català",emoji:"🟡"},{code:"nl",label:"Nederlands",emoji:"🇳🇱"},{code:"pl",label:"Polski",emoji:"🇵🇱"},{code:"ja",label:"日本語",emoji:"🇯🇵"},{code:"zh",label:"中文",emoji:"🇨🇳"},{code:"ru",label:"Русский",emoji:"🇷🇺"},{code:"tr",label:"Türkçe",emoji:"🇹🇷"},{code:"ar",label:"العربية",emoji:"🇸🇦"}],A=f("auto"),w=f(!1),j=R(()=>(p.find(r=>r.code===A.value)||p[0]).emoji);async function X(r){A.value=r,w.value=!1;try{await $fetch("/api/settings/preferences",{method:"POST",headers:_(),body:{aiLanguage:r}})}catch{}}async function U(){try{const r=await $fetch("/api/settings/preferences");r?.aiLanguage&&p.some(a=>a.code===r.aiLanguage)&&(A.value=r.aiLanguage)}catch{}}const P=f(""),F=f(null),K=f(null),E=f("environment"),y=R(()=>[...ze.filter(r=>r.category===E.value),...D.value.filter(r=>r.category===E.value)]),C=f(0),x=f(0);let V=null;const ue=R(()=>{const r=Math.max(0,Math.floor(x.value/1e3));return r<60?`${r}s`:`${Math.floor(r/60)}m${r%60}s`}),me=R(()=>x.value<2e3?"Reading context…":J.value.length===0?"Thinking…":J.value.length<3?"Gathering data…":"Synthesising answer…"),J=R(()=>{const r=m.value.slice(-8).filter(t=>t.role==="tool"&&t.toolName).map(t=>t.toolName),a=new Set,T=[];for(const t of r)a.has(t)||(a.add(t),T.push(t));return T.slice(-4)});te(v,r=>{r?(C.value=Date.now(),x.value=0,V&&clearInterval(V),V=Ie(()=>{x.value=Date.now()-C.value},500)):(V&&(clearInterval(V),V=null),x.value=0)});const M=f(!1),l=f({label:"",description:"",prompt:"",category:"environment",temperature:void 0});function pe(){!l.value.label.trim()||!l.value.prompt.trim()||(h({label:l.value.label.trim(),description:l.value.description.trim()||l.value.prompt.trim().slice(0,80),prompt:l.value.prompt.trim(),category:l.value.category,temperature:l.value.temperature}),l.value={label:"",description:"",prompt:"",category:"environment",temperature:void 0},M.value=!1)}function ge(r){b(r)}const he=R(()=>m.value.filter(r=>r.role!=="system"));function H(){ae(()=>{F.value&&(F.value.scrollTop=F.value.scrollHeight)})}async function Q(r){const a=P.value;a.trim()&&(P.value="",await O(a),H())}async function ye(r){v.value||(await O(r.prompt,{temperature:r.temperature,presetId:r.id}),H())}async function fe(){await u()}function ee(r){const a=r.detail||{},T=String(a.prompt||"").trim();!T||v.value||(O(T,{temperature:a.temperature,presetId:a.presetId}),ae(H))}return _e(async()=>{await Promise.all([c(),U()]),H(),typeof window<"u"&&window.addEventListener("ai-send",ee)}),xe(()=>{typeof window<"u"&&window.removeEventListener("ai-send",ee)}),te(()=>m.value.length,()=>{H()}),(r,a)=>{const T=Ke;return i(),n("div",qe,[e("div",Qe,[e("div",et,[e("div",tt,[I(o(oe),{class:"w-3.5 h-3.5 text-violet-400"})]),a[13]||(a[13]=e("h3",{class:"text-base font-semibold text-white"},"AI Assistant",-1)),e("span",{class:z(["w-2 h-2 rounded-full",o(v)?"bg-yellow-400 animate-pulse":"bg-spider-green-400"])},null,2)]),e("div",at,[e("div",ot,[e("button",{onClick:a[0]||(a[0]=t=>w.value=!o(w)),class:"flex items-center justify-center gap-1 min-w-[44px] min-h-[44px] text-base font-medium text-gray-500 hover:text-gray-200 hover:bg-gray-700/50 rounded-lg transition-colors",title:"Response language"},g(o(j)),1),o(w)?(i(),n("div",rt,[(i(),n(B,null,G(p,t=>e("button",{key:t.code,onClick:W=>X(t.code),class:z(["w-full px-3 py-2.5 min-h-[44px] text-left text-base flex items-center gap-2",o(A)===t.code?"bg-violet-500/20 text-violet-200":"text-gray-300 hover:bg-gray-800/60"])},[e("span",null,g(t.emoji),1),e("span",null,g(t.label),1)],10,st)),64))])):S("",!0)]),e("button",{onClick:fe,class:"flex items-center justify-center min-w-[44px] min-h-[44px] text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 rounded-lg transition-colors",title:"Clear history"},[I(o(Ae),{class:"w-4 h-4"})]),e("button",{onClick:a[1]||(a[1]=t=>r.$emit("close")),class:"flex items-center justify-center min-w-[44px] min-h-[44px] text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 rounded-lg transition-colors"},[I(o(re),{class:"w-4 h-4"})])])]),e("div",{ref_key:"messagesContainer",ref:F,class:"flex-1 overflow-y-auto py-3 space-y-1 min-h-0"},[o(m).length===0&&!o(v)?(i(),n("div",it,[e("div",nt,[e("div",lt,[I(o(oe),{class:"w-5 h-5 text-violet-400/60"})]),a[14]||(a[14]=e("p",{class:"text-base text-gray-400"},"How can I help with your grow?",-1))]),e("div",dt,[(i(!0),n(B,null,G(o(ie),t=>(i(),n("button",{key:t.key,type:"button",onClick:W=>E.value=t.key,class:z(["shrink-0 px-2.5 py-1.5 rounded-lg text-base transition-colors flex items-center gap-1.5 whitespace-nowrap",o(E)===t.key?"bg-violet-500/20 text-violet-200 border border-violet-500/40":"bg-gray-800/40 text-gray-400 border border-gray-700/40 hover:text-gray-200 hover:border-gray-600/40"])},[e("span",null,g(t.icon),1),e("span",ut,g(t.label),1)],10,ct))),128))]),e("div",mt,[(i(!0),n(B,null,G(o(y),t=>(i(),n("button",{key:t.id,type:"button",onClick:W=>ye(t),title:t.description,class:"group relative px-3 py-2 bg-gray-800/50 hover:bg-gray-700/60 border border-gray-700/50 hover:border-violet-500/40 rounded-xl text-left transition-all"},[e("div",gt,[t.id.startsWith("u_")?(i(),n("span",ht,"⭐")):S("",!0),e("span",null,g(t.label),1)]),e("div",yt,g(t.description),1),t.id.startsWith("u_")?(i(),n("button",{key:0,type:"button",class:"absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 p-1 text-gray-500 hover:text-rose-400 rounded",title:"Delete custom preset",onClick:Z(W=>ge(t.id),["stop"])},[I(o(re),{class:"w-3.5 h-3.5"})],8,ft)):S("",!0)],8,pt))),128)),e("button",{type:"button",onClick:a[2]||(a[2]=t=>M.value=!0),class:"px-3 py-1.5 border border-dashed border-gray-700/60 hover:border-violet-500/40 rounded-xl text-base text-gray-500 hover:text-violet-300 transition-all"}," + save custom prompt ")])])):S("",!0),o(M)?(i(),n("div",{key:1,class:"absolute inset-0 bg-gray-900/85 backdrop-blur-sm flex items-center justify-center p-4 z-20",onClick:a[9]||(a[9]=Z(t=>M.value=!1,["self"]))},[e("div",vt,[a[15]||(a[15]=e("div",{class:"text-base font-medium text-white mb-1"},"Save your own preset",-1)),L(e("input",{"onUpdate:modelValue":a[3]||(a[3]=t=>o(l).label=t),placeholder:"Label",class:"w-full bg-gray-900/60 border border-gray-700/50 rounded-lg px-3 py-1.5 text-base text-gray-200 placeholder-gray-500 focus:border-violet-500/50 focus:outline-none"},null,512),[[Y,o(l).label]]),L(e("input",{"onUpdate:modelValue":a[4]||(a[4]=t=>o(l).description=t),placeholder:"Description",class:"w-full bg-gray-900/60 border border-gray-700/50 rounded-lg px-3 py-1.5 text-base text-gray-200 placeholder-gray-500 focus:border-violet-500/50 focus:outline-none"},null,512),[[Y,o(l).description]]),L(e("textarea",{"onUpdate:modelValue":a[5]||(a[5]=t=>o(l).prompt=t),placeholder:"Prompt sent to the AI",rows:"4",class:"w-full bg-gray-900/60 border border-gray-700/50 rounded-lg px-3 py-1.5 text-base text-gray-200 placeholder-gray-500 focus:border-violet-500/50 focus:outline-none resize-none"},null,512),[[Y,o(l).prompt]]),e("div",bt,[L(e("select",{"onUpdate:modelValue":a[6]||(a[6]=t=>o(l).category=t),class:"flex-1 bg-gray-900/60 border border-gray-700/50 rounded-lg px-2 py-1.5 text-base text-gray-200 focus:outline-none"},[(i(!0),n(B,null,G(o(ie),t=>(i(),n("option",{key:t.key,value:t.key},g(t.icon)+" "+g(t.label),9,wt))),128))],512),[[ke,o(l).category]]),L(e("input",{"onUpdate:modelValue":a[7]||(a[7]=t=>o(l).temperature=t),type:"number",step:"0.05",min:"0",max:"1",placeholder:"temp",class:"w-16 bg-gray-900/60 border border-gray-700/50 rounded-lg px-2 py-1.5 text-base text-gray-200 focus:outline-none"},null,512),[[Y,o(l).temperature,void 0,{number:!0}]])]),e("div",_t,[e("button",{type:"button",onClick:a[8]||(a[8]=t=>M.value=!1),class:"px-3 py-1.5 text-base text-gray-400 hover:text-gray-200"},"Cancel"),e("button",{type:"button",onClick:pe,disabled:!o(l).label.trim()||!o(l).prompt.trim(),class:"px-3 py-1.5 bg-violet-600/80 hover:bg-violet-500 disabled:opacity-40 text-white rounded-lg text-base"},"Save",8,xt)])])])):S("",!0),(i(!0),n(B,null,G(o(he),(t,W)=>(i(),Se(T,{key:W,msg:t},null,8,["msg"]))),128)),o(v)?(i(),n("div",kt,[e("div",Ot,[e("div",Dt,[a[16]||(a[16]=e("span",{class:"flex gap-1"},[e("span",{class:"w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce",style:{"animation-delay":"0ms"}}),e("span",{class:"w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce",style:{"animation-delay":"150ms"}}),e("span",{class:"w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce",style:{"animation-delay":"300ms"}})],-1)),e("span",Ct,[Oe(g(o(me)),1),e("span",St," · "+g(o(ue)),1)])]),o(J).length?(i(),n("div",It,g(o(J).join(" → ")),1)):S("",!0)])])):S("",!0)],512),e("div",At,[e("div",Pt,[L(e("input",{ref_key:"inputEl",ref:K,"onUpdate:modelValue":a[10]||(a[10]=t=>Ce(P)?P.value=t:null),onKeydown:a[11]||(a[11]=De(Z(t=>Q(),["exact"]),["enter"])),disabled:o(v),placeholder:"Ask about your grow...",class:"flex-1 bg-gray-800/60 border border-gray-600/50 rounded-xl px-3.5 py-2 text-base text-gray-200 placeholder-gray-500 focus:border-violet-500/50 focus:outline-none disabled:opacity-50"},null,40,Nt),[[Y,o(P)]]),e("button",{onClick:a[12]||(a[12]=t=>Q()),disabled:!o(P).trim()||o(v),class:"px-3 py-2 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 disabled:from-gray-600 disabled:to-gray-600 text-white rounded-xl transition-all flex items-center"},[I(o(Pe),{class:"w-4 h-4"})],8,Et)])])])}}}),Ht=Object.assign(Tt,{__name:"AIChatPanel"});export{Ht as _};
