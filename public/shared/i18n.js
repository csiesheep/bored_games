// 系列共用的字串載入器。玩家看得到的字一個都不在程式裡:程式只有 key。
//
// 語言的挑法(順序固定):?lang= → localStorage 的 bg.lang → navigator.language。
// navigator 是 zh 開頭就給 zh-Hant,其他一律 en。
//
// 字串檔是 public/i18n/en.js 和 public/i18n/zh-Hant.js(`export default {…}`),writer 所有。
// 這個檔案不認得任何一個 key,也不放任何預設文字:找不到 key 就把 key 本身印出來,
// 讓缺的字在畫面上刺眼,而不是安靜地變成空白。

export const SUPPORTED = ["en", "zh-Hant"];
export const STORE_KEY = "bg.lang";
const FALLBACK = "en";

// 一個語言標籤 → 我們支援的兩種之一;認不得回 null。
export function normalize(tag) {
  const s = String(tag || "");
  if (/^zh\b/i.test(s) || /^zh-/i.test(s) || /^zh$/i.test(s)) return "zh-Hant";
  if (/^en\b/i.test(s) || /^en-/i.test(s) || /^en$/i.test(s)) return "en";
  return null;
}

// 純函式版的挑選,方便在沒有 window 的地方推理。
export function pick(query, stored, navTags) {
  return (
    normalize(query) ||
    normalize(stored) ||
    (navTags || []).map(normalize).find(Boolean) ||
    FALLBACK
  );
}

let LANG = FALLBACK;
let DICT = {};
let EXPLICIT = false; // 網址上寫明了語言 → 連結要帶著它走

export function lang() {
  return LANG;
}

export function other() {
  return LANG === "en" ? "zh-Hant" : "en";
}

function stored() {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch (_) {
    return null;
  }
}

export async function init() {
  const q = new URLSearchParams(location.search).get("lang");
  EXPLICIT = !!normalize(q);
  const navTags = [].concat(navigator.languages || [], navigator.language || []);
  LANG = pick(q, stored(), navTags);
  try {
    const mod = await import(new URL("../i18n/" + LANG + ".js", import.meta.url).href);
    DICT = mod.default || {};
  } catch (_) {
    DICT = {};
  }
  document.documentElement.lang = LANG;
  return LANG;
}

// t(key, {洞}) → 字串。缺 key 就回 key 本身。
export function t(key, vars) {
  const s = DICT[key];
  if (typeof s !== "string") return key;
  if (!vars) return s;
  return s.replace(/\{([a-z]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// 把 data-i18n 的接線套到頁面上。
//   data-i18n="key"                 → textContent
//   data-i18n-attr="aria-label:key" → 屬性(逗號分隔多組)
export function apply(root) {
  const r = root || document;
  r.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  r.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const pair of el.getAttribute("data-i18n-attr").split(",")) {
      const i = pair.indexOf(":");
      if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
    }
  });
  if (EXPLICIT) {
    r.querySelectorAll("a[href]").forEach((a) => {
      const u = new URL(a.getAttribute("href"), location.href);
      if (u.origin !== location.origin) return;
      u.searchParams.set("lang", LANG);
      a.setAttribute("href", u.pathname + u.search + u.hash);
    });
  }
}

// 換語言:記在 localStorage,然後重新載入這一頁(字串是模組,換了就重新載)。
export function setLang(l) {
  const n = normalize(l) || FALLBACK;
  try {
    localStorage.setItem(STORE_KEY, n);
  } catch (_) {}
  const u = new URL(location.href);
  if (u.searchParams.has("lang")) {
    u.searchParams.set("lang", n);
    location.replace(u.pathname + u.search + u.hash);
  } else {
    location.reload();
  }
}

// 接一顆「換成另一種語言」的按鈕。按鈕上寫的是 lang.other。
export function bindSwitch(el) {
  if (!el) return;
  el.textContent = t("lang.other");
  el.setAttribute("aria-label", t("lang.other"));
  el.addEventListener("click", () => setLang(other()));
}
