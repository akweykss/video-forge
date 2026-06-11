// ============================================================
// DocumentReveal — Document with synced marker highlight
// Text + document appear INSTANTLY — only marker animates
// Marker sweeps fast & fluid, synced with speech
// ============================================================
import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import { typography } from '../utils/colors';

interface DocumentRevealProps {
  text: string;
  highlightColor?: string;
}

interface TextSegment {
  text: string;
  highlighted: boolean;
  charStart: number;
  charEnd: number;
}

function parseSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let charCount = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const t = text.slice(lastIndex, match.index);
      segments.push({ text: t, highlighted: false, charStart: charCount, charEnd: charCount + t.length });
      charCount += t.length;
    }
    const t = match[1];
    segments.push({ text: t, highlighted: true, charStart: charCount, charEnd: charCount + t.length });
    charCount += t.length;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const t = text.slice(lastIndex);
    segments.push({ text: t, highlighted: false, charStart: charCount, charEnd: charCount + t.length });
  }
  return segments;
}

function getPlainText(text: string): string {
  return text.replace(/\*\*/g, '');
}

export const DocumentReveal: React.FC<DocumentRevealProps> = ({
  text,
  highlightColor = '#FACC15',
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const segments = parseSegments(text);
  const plainText = getPlainText(text);
  const totalChars = plainText.length;

  // === TIMING: Marker starts at frame 3, ends at 65% of scene ===
  // Ultra-fast & fluid — no waiting, straight to action
  const markerStart = 3;
  const markerEnd = Math.floor(durationInFrames * 0.65);

  // Marker position (which char is being highlighted)
  const markerCharPos = interpolate(
    frame,
    [markerStart, markerEnd],
    [0, totalChars],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const renderedSegments = segments.map((segment, segIndex) => {
    const highlightedChars = Math.max(0, Math.min(
      segment.text.length,
      markerCharPos - segment.charStart
    ));
    const highlightPercent = (highlightedChars / segment.text.length) * 100;
    const hasReached = markerCharPos > segment.charStart;
    const isEmphasis = segment.highlighted;

    const markerColor = isEmphasis
      ? `${highlightColor}C0`
      : `${highlightColor}50`;

    const markerHeight = isEmphasis ? '48%' : '35%';

    return (
      <span
        key={segIndex}
        style={{
          position: 'relative',
          display: 'inline',
          color: '#1A1A1A',
          fontWeight: isEmphasis ? 900 : 500,
        }}
      >
        {hasReached && (
          <span
            style={{
              position: 'absolute',
              bottom: '2px',
              left: '-2px',
              width: `${Math.min(highlightPercent, 100)}%`,
              height: markerHeight,
              backgroundColor: markerColor,
              borderRadius: '3px',
              transformOrigin: 'left center',
              zIndex: -1,
            }}
          />
        )}
        {segment.text}
      </span>
    );
  });

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 40px',
      }}
    >
      <div
        style={{
          width: '88%',
          maxWidth: 920,
          backgroundColor: '#FAFAF8',
          borderRadius: 16,
          padding: '48px 52px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 4px 16px rgba(0,0,0,0.3)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {[...Array(12)].map((_, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 52, right: 52,
              top: 48 + i * 48,
              height: 1,
              backgroundColor: 'rgba(0,0,0,0.04)',
            }}
          />
        ))}

        <div style={{
          position: 'absolute', left: 42, top: 0, bottom: 0,
          width: 2, backgroundColor: 'rgba(220,80,80,0.25)',
        }} />

        <div style={{
          position: 'absolute', top: 0, right: 0, width: 40, height: 40,
          background: 'linear-gradient(135deg, transparent 50%, rgba(0,0,0,0.06) 50%)',
        }} />

        <div
          style={{
            fontFamily: typography.body,
            fontSize: 40,
            lineHeight: 1.7,
            color: '#1A1A1A',
            position: 'relative',
            zIndex: 1,
            minHeight: 140,
            letterSpacing: '-0.01em',
          }}
        >
          {renderedSegments}
        </div>

        <div style={{
          position: 'absolute', bottom: 20, right: 28,
          fontFamily: typography.ui, fontSize: 14,
          color: 'rgba(0,0,0,0.10)', fontWeight: 600,
          letterSpacing: '0.05em',
        }}>
          DOCUMENTO
        </div>
      </div>
    </AbsoluteFill>
  );
};
