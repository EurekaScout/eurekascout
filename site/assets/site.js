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
// Inside a wallet app's own browser (the Meteor app and others) Telegram links can't open: t.me hands off to tg://,
// which those browsers refuse ("net::ERR_UNKNOWN_URL_SCHEME"). Telegram's own browser opens them fine.
window.EsInApp = () => {
  const ua = navigator.userAgent || "";
  if (window.TelegramWebviewProxy || /Telegram/i.test(ua)) return false;
  if (globalThis.__is_running_in_meteor_wallet_app__) return true;
  if (/; wv\)|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|MetaMaskMobile|Trust ?Wallet|OKApp|BitKeep|Bitget/i.test(ua)) return true;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && /AppleWebKit/.test(ua) && !/Safari\//.test(ua);   // an app's web view, not Safari or another browser
};
// There, a Telegram link copies itself instead (My Witty has its own version with the code route).
document.addEventListener("click", async (e) => {
  const a = e.target.closest?.('a[href^="https://t.me/"]');
  if (!a || a.hasAttribute("data-tg-own") || !window.EsInApp()) return;
  e.preventDefault();
  let note = a.parentElement.nextElementSibling;
  if (!note?.classList.contains("tg-note")) { note = document.createElement("p"); note.className = "mw-msg ok tg-note"; note.setAttribute("role", "status"); a.parentElement.after(note); }
  try { await navigator.clipboard.writeText(a.href); note.textContent = `Link copied: ${a.href}. Open it in Telegram or your phone's browser.`; }
  catch { note.textContent = `Open this link in Telegram or your phone's browser: ${a.href}`; }
});
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
