/**
 * Google's documented label palette (Gmail API `users.labels`, the `Color` object):
 * the same fixed 113-value set is allowed for `backgroundColor` and `textColor`, and
 * Gmail rejects any other hex with a 400. The taxonomy's `gmailColor` values are design
 * hexes and none of them is in the palette, so the adapter maps each one to its visually
 * nearest member instead of sending it verbatim.
 *
 * The set is data, kept here in one place; the nearest member is computed by squared-RGB
 * distance, never tabled.
 */
export const GMAIL_LABEL_COLORS = [
  "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#f3f3f3", "#ffffff",
  "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
  "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
  "#efa093", "#ffd6a2", "#fce8b3", "#89d3b2", "#a0eac9", "#a4c2f4", "#d0bcf1", "#fbc8d9",
  "#e66550", "#ffbc6b", "#fcda83", "#44b984", "#68dfa9", "#6d9eeb", "#b694e8", "#f7a7c0",
  "#cc3a21", "#eaa041", "#f2c960", "#149e60", "#3dc789", "#3c78d8", "#8e63ce", "#e07798",
  "#ac2b16", "#cf8933", "#d5ae49", "#0b804b", "#2a9c68", "#285bac", "#653e9b", "#b65775",
  "#822111", "#a46a21", "#aa8831", "#076239", "#1a764d", "#1c4587", "#41236d", "#83334c",
  "#464646", "#e7e7e7", "#0d3472", "#b6cff5", "#0d3b44", "#98d7e4", "#3d188e", "#e3d7ff",
  "#711a36", "#fbd3e0", "#8a1c0a", "#f2b2a8", "#7a2e0b", "#ffc8af", "#7a4706", "#ffdeb5",
  "#594c05", "#fbe983", "#684e07", "#fdedc1", "#0b4f30", "#b3efd3", "#04502e", "#a2dcc1",
  "#c2c2c2", "#4986e7", "#2da2bb", "#b99aff", "#994a64", "#f691b2", "#ff7537", "#ffad46",
  "#662e37", "#ebdbde", "#cca6ac", "#094228", "#42d692", "#16a765", "#757575", "#1e53b8",
  "#007286", "#7858c3", "#c2185b", "#d93025", "#54240e", "#633e04", "#521d28", "#202124",
  "#083018",
] as const;

export type GmailLabelColor = (typeof GMAIL_LABEL_COLORS)[number];

/** Below this relative luminance a background is dark enough that white text reads better. */
const LUMINANCE_THRESHOLD = 0.179;

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * The palette member closest to `hex` by squared-RGB distance. A tie keeps the earlier
 * palette entry, so the mapping is deterministic for every input.
 */
export function nearestGmailColor(hex: string): GmailLabelColor {
  const [r, g, b] = channels(hex);
  let nearest: GmailLabelColor = GMAIL_LABEL_COLORS[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const color of GMAIL_LABEL_COLORS) {
    const [pr, pg, pb] = channels(color);
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = color;
    }
  }
  return nearest;
}

/**
 * WCAG relative luminance of a `#RRGGBB` background, in `[0, 1]`.
 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * An allowed text colour that contrasts with `background`: black on a light background,
 * white on a dark one — 0.179 is the luminance where black and white contrast equally.
 * Both values are members of the palette, so Gmail always accepts the pair.
 */
export function textColorFor(background: string): "#000000" | "#ffffff" {
  return relativeLuminance(background) > LUMINANCE_THRESHOLD ? "#000000" : "#ffffff";
}
