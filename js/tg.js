// Telegram Web Apps bridge with graceful fallback for plain browsers.
export const tg = window.Telegram?.WebApp || null;
export const inTelegram = !!tg;

let settings = { sound: true, haptics: true };
export function setTgSettings(s) { settings = s; }

export function initTelegram() {
  if (!tg) return false;
  tg.ready();
  tg.expand();
  applyTheme();
  tg.onEvent('themeChanged', applyTheme);
  return true;
}

export function applyTheme() {
  if (!tg) return;
  const p = tg.themeParams || {};
  const root = document.documentElement;
  const dark = tg.colorScheme !== 'light';
  root.dataset.scheme = dark ? 'dark' : 'light';
  root.style.setProperty('--tg-bg', p.bg_color || (dark ? '#17212b' : '#ffffff'));
  root.style.setProperty('--tg-text', p.text_color || (dark ? '#f5f5f5' : '#111111'));
  root.style.setProperty('--tg-hint', p.hint_color || (dark ? '#9aa7b3' : '#7a7a7a'));
  root.style.setProperty('--tg-secondary-bg', p.secondary_bg_color || (dark ? '#232e3c' : '#f0f2f5'));
  root.style.setProperty('--tg-button', p.button_color || '#5288c1');
  root.style.setProperty('--tg-button-text', p.button_text_color || '#ffffff');
  root.style.setProperty('--tg-link', p.link_color || '#6ab3f3');
  tg.setHeaderColor?.(p.bg_color || (dark ? '#17212b' : '#ffffff'));
  tg.setBackgroundColor?.(p.bg_color || (dark ? '#17212b' : '#ffffff'));
}

// ---------- haptics ----------
// kind: 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning'
export function haptic(kind) {
  if (!settings.haptics || !tg?.HapticFeedback) return;
  try {
    if (['success', 'error', 'warning'].includes(kind)) tg.HapticFeedback.notificationOccurred(kind);
    else tg.HapticFeedback.impactOccurred(kind);
  } catch (_) { /* ignore */ }
}

// ---------- MainButton / BackButton ----------
let mainHandler = null;
let backHandler = null;

export function showMainButton(text, onClick) {
  if (!tg) return;
  if (mainHandler) { tg.MainButton.offClick(mainHandler); mainHandler = null; }
  mainHandler = onClick;
  tg.MainButton.setText(text);
  tg.MainButton.onClick(mainHandler);
  tg.MainButton.show();
}
export function hideMainButton() {
  if (!tg) return;
  if (mainHandler) { tg.MainButton.offClick(mainHandler); mainHandler = null; }
  tg.MainButton.hide();
}
export function showBackButton(onClick) {
  if (!tg) return;
  if (backHandler) { tg.BackButton.offClick(backHandler); backHandler = null; }
  backHandler = onClick;
  tg.BackButton.onClick(backHandler);
  tg.BackButton.show();
}
export function hideBackButton() {
  if (!tg) return;
  if (backHandler) { tg.BackButton.offClick(backHandler); backHandler = null; }
  tg.BackButton.hide();
}

// ---------- user ----------
export function getUser() {
  return tg?.initDataUnsafe?.user || null;
}
