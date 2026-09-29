/**
 * Plain (monochrome, no accent colors) custom cursors for the lasso tool,
 * built from filled lasso/lasso-polygon glyphs (originally svgrepo icons).
 * Black glyph over a white halo, matching the achromatic style of native OS
 * cursors so it stays legible on any layer/background color. The add/subtract
 * badge is anchored to the bottom-right corner, clear of the glyph itself.
 */

// Glyph path data, scaled 0.75 to fit a 24x24 box.
const FREEHAND_ICON_PATH =
  "M20,2H12A9.9842,9.9842,0,0,0,7.0349,20.6553C7.0249,20.7705,7,20.8818,7,21a3.9929,3.9929,0,0,0,2.9106,3.83A4.0049,4.0049,0,0,1,6,28H4v2H6a6.0044,6.0044,0,0,0,5.928-5.12,3.9966,3.9966,0,0,0,2.93-2.88H20A10,10,0,0,0,20,2ZM11,23a2,2,0,1,1,2-2A2.0025,2.0025,0,0,1,11,23Zm9-3H14.8579a3.9841,3.9841,0,0,0-7.15-1.2637A7.99,7.99,0,0,1,12,4h8a8,8,0,0,1,0,16Z";
const POLYGONAL_ICON_PATH =
  "M29.6245,2.2193a1.0005,1.0005,0,0,0-1.0972-.1006L17.9353,7.8,3.366,2.0694a1,1,0,0,0-1.28,1.3369l6.4353,14.479A3.965,3.965,0,0,0,9.9106,24.83,4.0049,4.0049,0,0,1,6,28H4v2H6a6.0044,6.0044,0,0,0,5.928-5.12,4.0021,4.0021,0,0,0,2.93-2.88H23.24a2,2,0,0,0,1.9273-1.4649L29.9634,3.2676A1,1,0,0,0,29.6245,2.2193ZM11,23a2,2,0,1,1,2-2A2.0025,2.0025,0,0,1,11,23Zm12.24-3H14.8579a3.897,3.897,0,0,0-4.5117-2.9336L4.905,4.8238,18.0647,10,27.41,4.9878Z";

const ADD_GLYPH = "M24 22v4M22 24h4";
const SUBTRACT_GLYPH = "M22 24h4";
const BADGE_CIRCLE =
  "<circle cx='24' cy='24' r='4.5' fill='%23fff' stroke='%23000' stroke-width='1'/>";

function iconCursor(pathD: string, badge: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='30' height='30' viewBox='0 0 30 30'>` +
    // White halo silhouette behind the glyph so it reads on any background.
    `<path transform='scale(0.75)' d='${pathD}' fill='%23fff' stroke='%23fff' stroke-width='2.5' stroke-linejoin='round'/>` +
    `<path transform='scale(0.75)' d='${pathD}' fill='%23000'/>` +
    badge +
    `</svg>`;
  // Hotspot at the tip of the rope's tail (both glyphs share the same tail
  // shape), so the click point lines up with where a plain pointer's tip
  // would be rather than the icon's bounding-box corner.
  return `url("data:image/svg+xml,${svg}") 3 23, crosshair`;
}

/** Freehand mode, no modifier: the drawn shape replaces the mask's coverage. */
export const LASSO_CURSOR_FREEHAND_REPLACE = iconCursor(FREEHAND_ICON_PATH, "");

/** Freehand mode, Shift held: the drawn shape is unioned into the mask's coverage. */
export const LASSO_CURSOR_FREEHAND_ADD = iconCursor(
  FREEHAND_ICON_PATH,
  `${BADGE_CIRCLE}<path d='${ADD_GLYPH}' stroke='%23000' stroke-width='1.1' stroke-linecap='round'/>`,
);

/** Freehand mode, Alt held: the drawn shape is subtracted from the mask's coverage. */
export const LASSO_CURSOR_FREEHAND_SUBTRACT = iconCursor(
  FREEHAND_ICON_PATH,
  `${BADGE_CIRCLE}<path d='${SUBTRACT_GLYPH}' stroke='%23000' stroke-width='1.1' stroke-linecap='round'/>`,
);

/** Polygonal mode, no modifier. */
export const LASSO_CURSOR_POLYGONAL_REPLACE = iconCursor(POLYGONAL_ICON_PATH, "");

/** Polygonal mode, Shift held. */
export const LASSO_CURSOR_POLYGONAL_ADD = iconCursor(
  POLYGONAL_ICON_PATH,
  `${BADGE_CIRCLE}<path d='${ADD_GLYPH}' stroke='%23000' stroke-width='1.1' stroke-linecap='round'/>`,
);

/** Polygonal mode, Alt held. */
export const LASSO_CURSOR_POLYGONAL_SUBTRACT = iconCursor(
  POLYGONAL_ICON_PATH,
  `${BADGE_CIRCLE}<path d='${SUBTRACT_GLYPH}' stroke='%23000' stroke-width='1.1' stroke-linecap='round'/>`,
);

/** Hovering within closing range of the polygon's first vertex. */
export const LASSO_CURSOR_CLOSE = "pointer";

/** Lasso tool active but the selected layer isn't an editable mask. */
export const LASSO_CURSOR_DISABLED = "not-allowed";
