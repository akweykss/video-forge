// ============================================================
// MediaAsset — Universal media component (image OR video)
// Applies Ken Burns zoom/pan effects to both images AND videos
// ============================================================
import React from 'react';
import { Img, OffthreadVideo, AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from 'remotion';

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];

/**
 * Checks if a URL/path points to a video file
 */
export function isVideoAsset(src: string): boolean {
  if (!src) return false;
  const lower = src.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext) || lower.includes(ext + '?'));
}

type KenBurnsEffect = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'none';

interface MediaAssetProps {
  src: string;
  style?: React.CSSProperties;
  muted?: boolean;
  /** Ken Burns effect to apply (default: 'zoom-in') */
  kenBurns?: KenBurnsEffect;
  /** Intensity: 1 = subtle, 2 = medium, 3 = dramatic */
  intensity?: 1 | 2 | 3;
}

/**
 * Renders either <OffthreadVideo> or <Img> with Ken Burns zoom/pan effects.
 * Videos get the same cinematic camera movements as images.
 */
export const MediaAsset: React.FC<MediaAssetProps> = ({
  src,
  style,
  muted = true,
  kenBurns = 'zoom-in',
  intensity = 2,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  if (!src) return null;

  // Calculate Ken Burns transform
  let scale = 1;
  let translateX = 0;
  let translateY = 0;

  const scaleRange: Record<number, [number, number]> = {
    1: [1.0, 1.08],
    2: [1.0, 1.15],
    3: [1.0, 1.25],
  };

  const panDist: Record<number, number> = {
    1: 30,
    2: 60,
    3: 100,
  };

  if (kenBurns !== 'none') {
    switch (kenBurns) {
      case 'zoom-in': {
        const [from, to] = scaleRange[intensity];
        scale = interpolate(frame, [0, durationInFrames], [from, to], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) });
        break;
      }
      case 'zoom-out': {
        const [from, to] = scaleRange[intensity];
        scale = interpolate(frame, [0, durationInFrames], [to, from], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) });
        break;
      }
      case 'pan-left': {
        scale = 1.15;
        const dist = panDist[intensity];
        translateX = interpolate(frame, [0, durationInFrames], [dist, -dist], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) });
        translateY = interpolate(frame, [0, durationInFrames], [-10, 10], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) });
        break;
      }
      case 'pan-right': {
        scale = 1.15;
        const dist = panDist[intensity];
        translateX = interpolate(frame, [0, durationInFrames], [-dist, dist], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) });
        translateY = interpolate(frame, [0, durationInFrames], [10, -10], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.ease) });
        break;
      }
    }
  }

  const baseStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    transform: `scale(${scale}) translate(${translateX}px, ${translateY}px)`,
    willChange: 'transform',
    ...style,
  };

  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      {isVideoAsset(src) ? (
        <OffthreadVideo src={src} style={baseStyle} muted={muted} />
      ) : (
        <Img src={src} style={baseStyle} />
      )}
    </AbsoluteFill>
  );
};
