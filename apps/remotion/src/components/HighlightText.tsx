// ============================================================
// HighlightText — Animated text highlighting (documentary style)
// Words wrapped in **word** get an animated marker/underline effect
// ============================================================
import React from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion';
import { typography } from '../utils/colors';

interface HighlightTextProps {
  /** Text with **highlighted** markers. E.g. "Isso custa **milhões** de reais" */
  text: string;
  /** Highlight color (marker effect) */
  highlightColor?: string;
  /** Text color */
  textColor?: string;
  /** Font size */
  fontSize?: number;
  /** Delay in frames before animation starts */
  delay?: number;
  /** Style: 'marker' (yellow highlighter), 'underline' (animated line), 'box' (rounded box) */
  style?: 'marker' | 'underline' | 'box';
}

interface TextSegment {
  text: string;
  highlighted: boolean;
}

/** Parse text with **markers** into segments */
function parseHighlightedText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Text before the highlight
    if (match.index > lastIndex) {
      segments.push({
        text: text.slice(lastIndex, match.index),
        highlighted: false,
      });
    }
    // Highlighted text
    segments.push({
      text: match[1],
      highlighted: true,
    });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    segments.push({
      text: text.slice(lastIndex),
      highlighted: false,
    });
  }

  return segments;
}

/**
 * HighlightText — Renders text with animated highlighting.
 *
 * Usage: Pass text with **double asterisks** around words to highlight.
 * The highlight draws in from left to right with a natural animation.
 */
export const HighlightText: React.FC<HighlightTextProps> = ({
  text,
  highlightColor = '#FACC15',
  textColor = '#FFFFFF',
  fontSize = 62,
  delay = 8,
  style: highlightStyle = 'marker',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const segments = parseHighlightedText(text);
  let highlightIndex = 0;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '6px',
        textAlign: 'center',
      }}
    >
      {segments.map((segment, i) => {
        if (!segment.highlighted) {
          return (
            <span
              key={i}
              style={{
                fontFamily: typography.headline,
                fontSize,
                fontWeight: 800,
                color: textColor,
                lineHeight: 1.3,
                textShadow: '0 4px 20px rgba(0,0,0,0.8)',
              }}
            >
              {segment.text}
            </span>
          );
        }

        // Each highlight has staggered timing
        const thisDelay = delay + highlightIndex * 12;
        highlightIndex++;

        // Highlight draw-in animation (left to right)
        const drawProgress = spring({
          frame: Math.max(0, frame - thisDelay),
          fps,
          config: { damping: 15, mass: 0.6, stiffness: 120 },
        });

        // Scale pop on the text
        const textScale = interpolate(
          spring({
            frame: Math.max(0, frame - thisDelay - 2),
            fps,
            config: { damping: 10, mass: 0.3, stiffness: 300 },
          }),
          [0, 1],
          [0.9, 1]
        );

        // Highlight width grows from 0% to 100%
        const highlightWidth = interpolate(drawProgress, [0, 1], [0, 100]);

        // Slight rotation for hand-drawn feel
        const rotation = interpolate(drawProgress, [0, 0.5, 1], [0, -0.8, 0]);

        const getHighlightStyle = (): React.CSSProperties => {
          switch (highlightStyle) {
            case 'marker':
              return {
                position: 'absolute',
                bottom: '8%',
                left: '-4px',
                width: `${highlightWidth}%`,
                height: '38%',
                backgroundColor: `${highlightColor}CC`,
                borderRadius: '4px',
                transform: `rotate(${rotation}deg)`,
                transformOrigin: 'left center',
                zIndex: -1,
              };
            case 'underline':
              return {
                position: 'absolute',
                bottom: '2px',
                left: 0,
                width: `${highlightWidth}%`,
                height: '6px',
                backgroundColor: highlightColor,
                borderRadius: '3px',
                transform: `rotate(${rotation}deg)`,
                transformOrigin: 'left center',
                boxShadow: `0 0 12px ${highlightColor}80`,
              };
            case 'box':
              return {
                position: 'absolute',
                top: '-6px',
                bottom: '-6px',
                left: '-8px',
                width: `calc(${highlightWidth}% + 16px)`,
                backgroundColor: `${highlightColor}30`,
                border: `3px solid ${highlightColor}`,
                borderRadius: '8px',
                zIndex: -1,
                opacity: drawProgress,
              };
            default:
              return {};
          }
        };

        return (
          <span
            key={i}
            style={{
              position: 'relative',
              display: 'inline-block',
              fontFamily: typography.headline,
              fontSize,
              fontWeight: 900,
              color: textColor,
              lineHeight: 1.3,
              transform: `scale(${textScale})`,
              textShadow: '0 4px 20px rgba(0,0,0,0.8)',
              zIndex: 1,
            }}
          >
            {/* The highlight effect behind text */}
            <span style={getHighlightStyle() as React.CSSProperties} />
            {segment.text}
          </span>
        );
      })}
    </div>
  );
};
