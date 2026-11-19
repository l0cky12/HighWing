if (!window.__hooked2) {
  window.__hooked2 = true;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (type === "scroll" && this.classList?.contains("settings-main") && !fn.__mine) window.__react = fn;
    return add.call(this, type, fn, opts);
  };
  return "hooked";
}
let st = document.getElementById("x127");
if (!st) { st = document.createElement("style"); st.id = "x127"; document.head.append(st); }
st.textContent = window.__css ?? "";
const m = document.querySelector(".settings-main");
const mode = window.__mode;
if (window.__react) m.removeEventListener("scroll", window.__react);
if (window.__mine) m.removeEventListener("scroll", window.__mine);
window.__mine = undefined;
if (mode === "original" && window.__react) m.addEventListener("scroll", window.__react, { passive: true });
if (mode === "deferred" && window.__react) {
  let t;
  const fn = () => { clearTimeout(t); t = setTimeout(window.__react, 120); };
  fn.__mine = true;
  window.__mine = fn;
  m.addEventListener("scroll", fn, { passive: true });
}
if (["reads", "reads+class", "class-only", "aria-only", "data-only"].includes(mode) || mode.startsWith("cls:")) {
  const root = m.querySelector("[role=tabpanel]") ?? m;
  const secs = () => [...root.querySelectorAll("section.set-section")].filter((s) => {
    const outer = s.parentElement?.closest("section");
    return (!outer || !root.contains(outer)) && !s.closest(".page-head") && !!s.querySelector(":scope > .set-head h2");
  });
  let shown;
  const fn = () => {
    const list = secs();
    if (!list.length) return;
    const top = m.getBoundingClientRect().top + 24;
    let cur = 0;
    list.forEach((s, i) => { if (s.getBoundingClientRect().top <= top + 4) cur = i; });
    if (mode === "reads" || cur === shown) return;
    shown = cur; window.__changes = (window.__changes ?? 0) + 1;
    document.querySelectorAll(".settings-sub").forEach((b, i) => {
      if (mode === "reads+class" || mode === "class-only") b.classList.toggle("on", i === cur);
      if (mode === "reads+class" || mode === "aria-only") i === cur ? b.setAttribute("aria-current", "location") : b.removeAttribute("aria-current");
      if (mode === "data-only") b.dataset.cur = String(i === cur);
      if (mode.startsWith("cls:")) b.classList.toggle(mode.slice(4), i === cur);
    });
  };
  fn.__mine = true;
  window.__mine = fn;
  m.addEventListener("scroll", fn, { passive: true });
}
return mode + (window.__react ? " react-captured" : " no-react");
