// 紙上空戰的輸入手感:純函式,不碰 DOM,不碰時間,不碰亂數。
//
// 這裡是手感數字的唯一一份。app.js 只能 import,不可以自己再寫一個 1.6 或 14:
// 兩份數字會安靜地分岔,而驗收只看得到這一份。
//
// 數值的出處是規則筆記(vault: Projects/bored_games/bored_games - rulebook.md)的
// 「輸入手感(只在前端,不進引擎)」那張表;tests/acceptance.js 第 11 組有一份獨立抄寫的對照。
// 改這些數字要 orchestrator 裁決。
//
// 長度的兩個端點(100 / 740)不在這裡抄第二份,走 engine.js 的 RULES。

import { RULES } from "../shared/dogfight/engine.js";

export const FEEL = {
  CHARGE_S: 1.6, // 蓄滿力道要按多久(秒)
  SLIP: 1.45, // 蓄滿之後再撐到這個倍率,筆自己滑出去(1.6 × 1.45 = 2.32 秒)
  WOB_MIN_DEG: 1.5, // pr = 0 時準心的擺動幅度
  WOB_MAX_DEG: 14, // pr = 1 時準心的擺動幅度
  HINT: 0.3, // 方向提示只露出名目長度的前三成
  CANCEL_R: 18, // 拉回這個半徑以內放開 = 取消
};

// 按住 t 秒時的力道,0 到 1。蓄滿之後就停在 1(再按下去只是逼近 slipAt)。
export function pressure(t) {
  const p = t / FEEL.CHARGE_S;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

// 筆自己滑出去的時間(秒)。
export function slipAt() {
  return FEEL.CHARGE_S * FEEL.SLIP;
}

// 準心的擺動(弧度)。幅度隨 pr² 長大,波形是兩個正弦的和:
// 平滑、可預測,所以「抓時機放開」是技術而不是運氣。
export function wobble(t, pr) {
  const amp = ((FEEL.WOB_MIN_DEG + (FEEL.WOB_MAX_DEG - FEEL.WOB_MIN_DEG) * pr * pr) * Math.PI) / 180;
  return amp * (0.6 * Math.sin(7.3 * t) + 0.4 * Math.sin(11.9 * t + 1));
}

// 名目長度(不含引擎的誤差和弧度),只給提示虛線用。
export function nominalLen(pr) {
  return RULES.MIN_LEN + (RULES.MAX_LEN - RULES.MIN_LEN) * pr;
}

// 方向提示虛線的長度:名目長度的前三成。
export function hintLen(pr) {
  return nominalLen(pr) * FEEL.HINT;
}

// 從飛機往回拉的位移;拉回 CANCEL_R 以內放開就是取消(不出手、不換人)。
export function isCancel(dx, dy) {
  return Math.hypot(dx, dy) < FEEL.CANCEL_R;
}
