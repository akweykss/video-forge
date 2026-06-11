import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from 'remotion';

// ============================================================
// Types
// ============================================================

interface CaptionSegment {
  /** The translated text for this segment */
  text: string;
  /** Start time in milliseconds */
  startMs: number;
  /** End time in milliseconds */
  endMs: number;
}

interface TranslationOverlayProps {
  /** Array of caption segments with timing */
  captions: CaptionSegment[];
  /** Font size in pixels */
  fontSize?: number;
  /** Primary text color */
  textColor?: string;
  /** Highlight color for active word */
  highlightColor?: string;
  /** Caption style: 'bounce' | 'glitch' | 'slide' | 'fade' */
  captionStyle?: 'bounce' | 'glitch' | 'slide' | 'fade';
  /** Position: 'bottom' | 'center' | 'top' */
  position?: 'bottom' | 'center' | 'top';
  /** OCR region to avoid (relative 0-1 coords) */
  ocrRegion?: {
    x_min: number;
    x_max: number;
    y_min: number;
    y_max: number;
  };
}

// ============================================================
// BounceCaption — Spring-physics word animation
// ============================================================

const BounceCaption: React.FC<{
  text: string;
  progress: number;
  fontSize: number;
  textColor: string;
  highlightColor: string;
}> = ({ text, progress, fontSize, textColor, highlightColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const words = text.split(' ');

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: '8px',
      maxWidth: '90%',
    }}>
      {words.map((word, i) => {
        const wordDelay = i * 3; // 3 frames between each word
        const springValue = spring({
          frame: frame - wordDelay,
          fps,
          config: { damping: 12, stiffness: 200, mass: 0.5 },
        });

        const isActive = progress > 0 && i <= Math.floor(progress * words.length);
        const color = isActive ? highlightColor : textColor;

        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              fontSize,
              fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
              fontWeight: 800,
              color,
              textShadow: `0 2px 8px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.5)`,
              transform: `translateY(${interpolate(springValue, [0, 1], [30, 0])}px) scale(${interpolate(springValue, [0, 1], [0.5, 1])})`,
              opacity: springValue,
              WebkitTextStroke: '1px rgba(0,0,0,0.3)',
              letterSpacing: '-0.02em',
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};

// ============================================================
// GlitchCaption — Digital glitch effect
// ============================================================

const GlitchCaption: React.FC<{
  text: string;
  progress: number;
  fontSize: number;
  textColor: string;
  highlightColor: string;
}> = ({ text, progress, fontSize, textColor, highlightColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entryProgress = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 300, mass: 0.4 },
  });

  // Glitch effect: random offset every N frames
  const glitchActive = frame % 30 < 3; // Glitch for 3 frames every 30
  const glitchX = glitchActive ? Math.sin(frame * 7.3) * 4 : 0;
  const glitchY = glitchActive ? Math.cos(frame * 5.1) * 2 : 0;

  const isHighlighted = progress > 0.5;

  return (
    <div style={{
      position: 'relative',
      maxWidth: '90%',
    }}>
      {/* Glitch shadow layers */}
      {glitchActive && (
        <>
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            fontSize,
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: 900,
            color: 'rgba(255, 0, 50, 0.7)',
            transform: `translate(${glitchX + 3}px, ${glitchY - 2}px)`,
            textAlign: 'center',
            width: '100%',
          }}>
            {text}
          </div>
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            fontSize,
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: 900,
            color: 'rgba(0, 200, 255, 0.7)',
            transform: `translate(${-glitchX - 2}px, ${-glitchY + 1}px)`,
            textAlign: 'center',
            width: '100%',
          }}>
            {text}
          </div>
        </>
      )}
      {/* Main text */}
      <div style={{
        fontSize,
        fontFamily: "'Inter', system-ui, sans-serif",
        fontWeight: 900,
        color: isHighlighted ? highlightColor : textColor,
        textShadow: '0 2px 10px rgba(0,0,0,0.9)',
        textAlign: 'center',
        transform: `translate(${glitchX}px, ${glitchY}px) scale(${entryProgress})`,
        opacity: entryProgress,
        letterSpacing: '-0.02em',
        transition: 'color 0.15s ease',
      }}>
        {text}
      </div>
    </div>
  );
};

// ============================================================
// SlideCaption — Smooth slide-in from side
// ============================================================

const SlideCaption: React.FC<{
  text: string;
  progress: number;
  fontSize: number;
  textColor: string;
  highlightColor: string;
}> = ({ text, progress, fontSize, textColor, highlightColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideIn = spring({
    frame,
    fps,
    config: { damping: 18, stiffness: 120, mass: 0.8 },
  });

  const words = text.split(' ');

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: '6px',
      maxWidth: '90%',
      transform: `translateX(${interpolate(slideIn, [0, 1], [-200, 0])}px)`,
      opacity: slideIn,
    }}>
      {words.map((word, i) => {
        const isActive = progress > 0 && i <= Math.floor(progress * words.length);
        return (
          <span key={i} style={{
            fontSize,
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: 800,
            color: isActive ? highlightColor : textColor,
            textShadow: '0 2px 8px rgba(0,0,0,0.8)',
            letterSpacing: '-0.02em',
          }}>
            {word}
          </span>
        );
      })}
    </div>
  );
};

// ============================================================
// Main TranslationOverlay Component
// ============================================================

export const TranslationOverlay: React.FC<TranslationOverlayProps> = ({
  captions,
  fontSize = 52,
  textColor = '#FFFFFF',
  highlightColor = '#FACC15',
  captionStyle = 'bounce',
  position = 'bottom',
  ocrRegion,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const currentTimeMs = (frame / fps) * 1000;

  // Find current active caption
  const activeCaption = captions.find(
    (c) => currentTimeMs >= c.startMs && currentTimeMs <= c.endMs
  );

  if (!activeCaption) return <AbsoluteFill />;

  // Calculate progress within this caption (0 to 1)
  const progress = interpolate(
    currentTimeMs,
    [activeCaption.startMs, activeCaption.endMs],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Position based on setting and OCR avoidance
  let positionStyle: React.CSSProperties = {};
  if (position === 'bottom') {
    const bottomOffset = ocrRegion
      ? `${Math.max(10, (1 - ocrRegion.y_min) * 100 + 5)}%`
      : '12%';
    positionStyle = { bottom: bottomOffset, top: 'auto' };
  } else if (position === 'top') {
    positionStyle = { top: '10%', bottom: 'auto' };
  } else {
    positionStyle = { top: '50%', transform: 'translateY(-50%)' };
  }

  // Select caption renderer
  const CaptionComponent = captionStyle === 'bounce' ? BounceCaption
    : captionStyle === 'glitch' ? GlitchCaption
    : captionStyle === 'slide' ? SlideCaption
    : BounceCaption; // fade uses bounce with different spring

  return (
    <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '0 5%',
        ...positionStyle,
      }}>
        <CaptionComponent
          text={activeCaption.text}
          progress={progress}
          fontSize={fontSize}
          textColor={textColor}
          highlightColor={highlightColor}
        />
      </div>
    </AbsoluteFill>
  );
};

export default TranslationOverlay;
