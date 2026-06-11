// ============================================================
// KineticText — Spring-animated word-by-word or char-by-char text
// ============================================================
import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { springPresets } from '../utils/animations';
import { typography } from '../utils/colors';

type KineticStyle = 'bounce' | 'fade' | 'slide';
type KineticMode = 'word' | 'character';

interface KineticTextProps {
  /** The text to animate */
  text: string;
  /** Font size in pixels */
  fontSize?: number;
  /** Text color */
  color?: string;
  /** Delay in frames between each unit animating in */
  staggerDelay?: number;
  /** Animation style */
  style?: KineticStyle;
  /** Whether to animate word-by-word or character-by-character */
  mode?: KineticMode;
  /** Font weight */
  fontWeight?: number | string;
  /** Text alignment */
  textAlign?: React.CSSProperties['textAlign'];
  /** Additional CSS styles */
  containerStyle?: React.CSSProperties;
  /** Overall delay before animation starts */
  delay?: number;
  /** Line height multiplier */
  lineHeight?: number;
}

export const KineticText: React.FC<KineticTextProps> = ({
  text,
  fontSize = 48,
  color = '#FFFFFF',
  staggerDelay = 3,
  style = 'bounce',
  mode = 'word',
  fontWeight = 700,
  textAlign = 'center',
  containerStyle,
  delay = 0,
  lineHeight = 1.3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const units = mode === 'word' ? text.split(' ') : text.split('');

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent:
          textAlign === 'center'
            ? 'center'
            : textAlign === 'right'
              ? 'flex-end'
              : 'flex-start',
        alignItems: 'center',
        gap: mode === 'word' ? `0 ${fontSize * 0.3}px` : '0',
        lineHeight,
        ...containerStyle,
      }}
    >
      {units.map((unit, index) => {
        const unitDelay = delay + index * staggerDelay;

        let unitStyle: React.CSSProperties = {
          display: 'inline-block',
          fontSize,
          fontWeight,
          color,
          fontFamily: typography.headline,
          whiteSpace: 'pre',
        };

        switch (style) {
          case 'bounce': {
            const progress = spring({
              frame: Math.max(0, frame - unitDelay),
              fps,
              config: springPresets.bouncy,
            });

            unitStyle = {
              ...unitStyle,
              transform: `translateY(${interpolate(progress, [0, 1], [40, 0])}px) scale(${interpolate(progress, [0, 1], [0.6, 1])})`,
              opacity: progress,
            };
            break;
          }
          case 'fade': {
            const opacity = interpolate(
              frame,
              [unitDelay, unitDelay + 15],
              [0, 1],
              {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              },
            );

            unitStyle = {
              ...unitStyle,
              opacity,
            };
            break;
          }
          case 'slide': {
            const progress = spring({
              frame: Math.max(0, frame - unitDelay),
              fps,
              config: springPresets.smooth,
            });

            unitStyle = {
              ...unitStyle,
              transform: `translateX(${interpolate(progress, [0, 1], [80, 0])}px)`,
              opacity: progress,
            };
            break;
          }
        }

        return (
          <span key={`${unit}-${index}`} style={unitStyle}>
            {unit}
          </span>
        );
      })}
    </div>
  );
};
