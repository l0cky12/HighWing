// Armed on the open New bot form; run.sh puts the bot's name in place of __NAME__. Times, from the Create bot click,
// when the new row shows, when the form closes, when the bot becomes the one in use, and when it is ready: no switch
// in progress, connected, and its models loaded.
const name = "__NAME__";
const bp = (window.__bp = { name, t0: null });
const create = [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Create bot");
create.addEventListener("click", () => bp.t0 === null && (bp.t0 = performance.now()), { capture: true, once: true });
const mark = (key, now) => bp[key] === undefined && now && (bp[key] = Math.round(performance.now() - bp.t0));
const tick = setInterval(() => {
  if (bp.t0 === null) return;
  const row = document.querySelector(`.bots-row[data-profile="${name}"]`);
  mark("row", !!row);
  mark("closed", !document.querySelector(".profile-dialog"));
  mark("current", !!row?.classList.contains("is-current"));
  if (bp.current === undefined) return;
  mark("connected", !document.querySelector(".switch-progress") && !!document.querySelector(".status-conn.connected"));
  mark("models", !document.body.innerText.includes("Loading models"));
  if (bp.connected !== undefined && bp.models !== undefined) {
    bp.ready = Math.max(bp.connected, bp.models);
    clearInterval(tick);
  }
}, 20);
return "armed";
