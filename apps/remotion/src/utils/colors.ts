// ============================================================
// Color Utilities — Dark theme palette & helpers
// ============================================================

/**
 * Typography — Professional font families
 * Headlines: Playfair Display (premium serif)
 * Body: Merriweather (readable serif)
 * UI: Inter (clean sans-serif for numbers/labels)
 */
export const typography = {
  /** For headlines, titles, quotes */
  headline: "'Playfair Display', 'Georgia', serif",
  /** For body text, descriptions */
  body: "'Merriweather', 'Georgia', serif",
  /** For UI elements, numbers, labels */
  ui: "'Inter', system-ui, sans-serif",
} as const;

/**
 * Default VideoForge dark-theme color palette
 */
export const palette = {
  /** Backgrounds */
  bg: {
    primary: '#0A0A0F',
    secondary: '#12121A',
    tertiary: '#1A1A28',
    card: '#1E1E2E',
  },

  /** Text */
  text: {
    primary: '#FFFFFF',
    secondary: '#B0B0C8',
    muted: '#6E6E88',
  },

  /** Accent colors */
  accent: {
    blue: '#4F7BFF',
    purple: '#8B5CF6',
    pink: '#EC4899',
    cyan: '#06B6D4',
    green: '#10B981',
    orange: '#F97316',
    red: '#EF4444',
    gold: '#F59E0B',
  },

  /** Glassmorphism */
  glass: {
    bg: 'rgba(255, 255, 255, 0.06)',
    border: 'rgba(255, 255, 255, 0.12)',
    bgStrong: 'rgba(255, 255, 255, 0.10)',
    borderStrong: 'rgba(255, 255, 255, 0.20)',
  },
} as const;

/**
 * Returns a CSS linear gradient string from two hex colors.
 */
export function gradient(
  color1: string,
  color2: string,
  angle: number = 135,
): string {
  return `linear-gradient(${angle}deg, ${color1}, ${color2})`;
}

/**
 * Returns a CSS radial gradient string.
 */
export function radialGradient(
  color1: string,
  color2: string,
  position: string = 'center',
): string {
  return `radial-gradient(ellipse at ${position}, ${color1}, ${color2})`;
}

/**
 * Adds alpha opacity to a hex color.
 * @param hex - 6-character hex color (e.g. '#FF0000')
 * @param alpha - Opacity from 0 to 1
 */
export function withOpacity(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Creates a dark overlay gradient for text readability over images.
 */
export function textOverlayGradient(direction: 'bottom' | 'top' | 'full' = 'bottom'): string {
  if (direction === 'full') {
    return 'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.3) 40%, rgba(0,0,0,0.6) 100%)';
  }
  if (direction === 'top') {
    return 'linear-gradient(0deg, transparent 40%, rgba(0,0,0,0.7) 100%)';
  }
  return 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.85) 100%)';
}

/**
 * Creates a vignette gradient for video edges.
 */
export function vignetteGradient(intensity: number = 0.6): string {
  return `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${intensity}) 100%)`;
}
