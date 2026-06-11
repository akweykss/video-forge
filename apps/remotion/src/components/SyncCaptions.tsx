// ============================================================
// SyncCaptions — Word-by-word animated captions (TikTok/CapCut style)
// Maximum retention: 3 words at a time, current word highlighted
// Hides automatically when scene headline text is showing
// ============================================================
import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { typography } from '../utils/colors';

interface Word {
  text: string;
  start: number; // ms
  end: number;   // ms
}

/** Time range (in frames) when captions should hide */
interface HideRange {
  startFrame: number;
  endFrame: number;
}

interface SyncCaptionsProps {
  words: Word[];
  /** Primary accent color for highlighted word */
  primaryColor?: string;
  /** Max words visible at once */
  maxWordsVisible?: number;
  /** Font size in pixels */
  fontSize?: number;
  /** Frame ranges where captions should hide (e.g. when headline text is showing) */
  hideRanges?: HideRange[];
}

/**
 * SyncCaptions — Renders word-by-word synchronized captions.
 * 
 * - Position: slightly below center (~58% from top)
 * - Hides when scene headline text is visible (no double text)
 * - Large bold uppercase with accent highlight on current word
 */
export const SyncCaptions: React.FC<SyncCaptionsProps> = ({
  words,
  primaryColor = '#FACC15',
  maxWordsVisible = 3,
  fontSize = 58,
  hideRanges = [],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTimeMs = (frame / fps) * 1000;

  if (!words || words.length === 0) return null;

  // Check if captions should be hidden (headline text is showing)
  const isHidden = hideRanges.some(
    (range) => frame >= range.startFrame && frame <= range.endFrame
  );

  if (isHidden) return null;

  // Find the current word index
  let currentWordIndex = -1;
  for (let i = 0; i < words.length; i++) {
    if (currentTimeMs >= words[i].start && currentTimeMs <= words[i].end) {
      currentWordIndex = i;
      break;
    }
    // Between words — show the last spoken word briefly
    if (i < words.length - 1 && currentTimeMs > words[i].end && currentTimeMs < words[i + 1].start) {
      currentWordIndex = i;
      break;
    }
  }

  // Nothing to show yet or audio finished
  if (currentWordIndex === -1) return null;

  // Group words into chunks of maxWordsVisible
  const chunkIndex = Math.floor(currentWordIndex / maxWordsVisible);
  const chunkStart = chunkIndex * maxWordsVisible;
  const chunkEnd = Math.min(chunkStart + maxWordsVisible, words.length);
  const visibleWords = words.slice(chunkStart, chunkEnd);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: '58%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '0 40px',
        zIndex: 100,
        pointerEvents: 'none',
      }}
    >
      {/* Background pill */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 24px',
          borderRadius: '16px',
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(8px)',
        }}
      >
        {visibleWords.map((word, i) => {
          const globalIndex = chunkStart + i;
          const isActive = globalIndex === currentWordIndex;
          const isPast = globalIndex < currentWordIndex;
          
          // Scale pop animation for active word
          const wordStartFrame = Math.round((word.start / 1000) * fps);
          const scaleValue = isActive
            ? spring({
                frame: frame - wordStartFrame,
                fps,
                config: { damping: 12, mass: 0.4, stiffness: 200 },
              })
            : 1;
          
          const scale = isActive ? interpolate(scaleValue, [0, 1], [0.85, 1]) : 1;
          const opacity = isActive ? 1 : isPast ? 0.5 : 0.4;

          return (
            <span
              key={`${globalIndex}-${word.text}`}
              style={{
                fontFamily: typography.headline,
                fontSize: `${fontSize}px`,
                fontWeight: 900,
                color: isActive ? primaryColor : '#FFFFFF',
                opacity,
                transform: `scale(${scale})`,
                display: 'inline-block',
                textShadow: isActive 
                  ? `0 0 30px #EF444480, 0 0 12px ${primaryColor}60, 0 2px 8px rgba(0,0,0,0.9)`
                  : '0 2px 8px rgba(0,0,0,0.8)',
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                transition: 'color 0.1s ease, opacity 0.1s ease',
                textTransform: 'uppercase',
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};
