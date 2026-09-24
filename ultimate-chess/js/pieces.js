// Original geometric "Neo" SVG piece set (viewBox 0 0 100 100).
// Fills/strokes come from CSS custom props so one symbol serves both colors.

const BASE = '<path d="M27 80 h46 v8 a5 5 0 0 1 -5 5 h-36 a5 5 0 0 1 -5 -5 z"/>';

const SHAPES = {
  p: `
    <circle cx="50" cy="30" r="13"/>
    <rect x="36" y="40" width="28" height="7" rx="3.5"/>
    <path d="M41 45 h18 c0 12 5 20 9 27 h-36 c4 -7 9 -15 9 -27 z"/>
    ${BASE}`,
  r: `
    <path d="M29 19 h12 v10 h7 v-10 h10 v10 h7 v-10 h12 v18 h-48 z"/>
    <rect x="33" y="35" width="40" height="7" rx="3"/>
    <path d="M37 42 h26 l3 30 h-32 z"/>
    ${BASE}`,
  n: `
    <path d="M33 80 L33 72 C33 61 39 55 47 49 L38 45 C32 42 30 35 34 29 L42 17 L47 24 L54 13 L58 27 C68 37 72 51 72 63 L72 72 L72 80 Z"/>
    <circle cx="45" cy="33" r="2.6" fill="var(--pc-stroke)" stroke="none"/>
    ${BASE}`,
  b: `
    <circle cx="50" cy="14" r="4.5"/>
    <path d="M50 20 c11 9 16 20 16 28 c0 10 -7 16 -16 16 c-9 0 -16 -6 -16 -16 c0 -8 5 -19 16 -28 z"/>
    <path d="M50 28 v16" fill="none" stroke="var(--pc-stroke)" stroke-width="3"/>
    <rect x="36" y="62" width="28" height="7" rx="3.5"/>
    <path d="M42 69 h16 l4 11 h-24 z"/>
    ${BASE}`,
  q: `
    <circle cx="30" cy="20" r="4.5"/><circle cx="50" cy="14" r="4.5"/><circle cx="70" cy="20" r="4.5"/>
    <path d="M27 42 l4 -18 l10 14 l9 -20 l9 20 l10 -14 l4 18 c-3 12 -12 18 -23 18 c-11 0 -20 -6 -23 -18 z"/>
    <rect x="33" y="58" width="34" height="7" rx="3.5"/>
    <path d="M38 65 h24 l4 15 h-32 z"/>
    ${BASE}`,
  k: `
    <path d="M47 8 h6 v8 h8 v6 h-8 v8 h-6 v-8 h-8 v-6 h8 z"/>
    <path d="M31 44 c0 -10 9 -14 19 -14 c10 0 19 4 19 14 c0 10 -8 16 -19 16 c-11 0 -19 -6 -19 -16 z"/>
    <rect x="33" y="58" width="34" height="7" rx="3.5"/>
    <path d="M38 65 h24 l4 15 h-32 z"/>
    ${BASE}`,
};

export function injectSprite(rootId = 'sprite-root') {
  const symbols = Object.entries(SHAPES)
    .map(
      ([type, body]) =>
        `<symbol id="pc-${type}" viewBox="0 0 100 100">
           <g fill="var(--pc-fill)" stroke="var(--pc-stroke)" stroke-width="3"
              stroke-linejoin="round" stroke-linecap="round">${body}</g>
         </symbol>`
    )
    .join('');
  const root = document.getElementById(rootId);
  root.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols}</svg>`;
}

/** Build an inline <svg> element referencing a piece symbol. */
export function pieceSVG(type) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#pc-${type}`);
  svg.appendChild(use);
  return svg;
}
