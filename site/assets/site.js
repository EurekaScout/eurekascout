"use strict";
// phone menu
(() => {
  const btn = document.querySelector(".menu-btn"), menu = document.getElementById("mnav");
  if (!btn || !menu) return;
  btn.addEventListener("click", () => { const open = btn.getAttribute("aria-expanded") !== "true"; btn.setAttribute("aria-expanded", String(open)); menu.hidden = !open; });
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) { btn.setAttribute("aria-expanded", "false"); menu.hidden = true; } });
})();
// scroll reveals
(() => {
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach((n, i) => { n.style.transitionDelay = `${(i % 4) * 90}ms`; io.observe(n); });
})();
// install as an app on phones, and an offline page instead of a browser error (real site only)
if ("serviceWorker" in navigator && location.protocol === "https:") addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
// dark / light mode: follows the device unless the visitor picks one (remembered on this device only)
(() => {
  const root = document.documentElement, meta = document.querySelector('meta[name="theme-color"]');
  const mq = matchMedia("(prefers-color-scheme: dark)");
  let saved = null; try { saved = localStorage.getItem("es-theme"); } catch { /* storage blocked: follow the device */ }
  const label = () => {
    const dark = root.dataset.theme === "dark";
    document.querySelectorAll(".theme-btn").forEach((b) => b.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode"));
    document.querySelectorAll(".theme-row span").forEach((s) => { s.textContent = dark ? "Light mode" : "Dark mode"; });
    if (meta) meta.content = dark ? "#0D0E12" : "#FFFFFF";
  };
  const set = (t) => { root.dataset.theme = t; label(); };
  if (saved !== "dark" && saved !== "light") set(mq.matches ? "dark" : "light"); else label();
  mq.addEventListener?.("change", (e) => { if (saved !== "dark" && saved !== "light") set(e.matches ? "dark" : "light"); });
  document.querySelectorAll(".theme-btn,.theme-row").forEach((b) => b.addEventListener("click", () => {
    const t = root.dataset.theme === "dark" ? "light" : "dark"; saved = t;
    try { localStorage.setItem("es-theme", t); } catch { /* remembered for this visit only */ }
    set(t);
  }));
})();
