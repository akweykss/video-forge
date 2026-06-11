// ============================================================
// SceneInspector — Studio overlay panel for scene debugging
// Shows current scene info, transitions, animations, captions
// Only visible in Remotion Studio (not in renders)
// ============================================================
import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

interface SceneData {
  id: string;
  type: string;
  durationInFrames: number;
  durationInSeconds?: number;
  startFrame?: number;
  headline?: string;
  body?: string;
  narrationText?: string;
  animation?: string;
  transition?: string;
  transitionDurationFrames?: number;
  visualType?: string;
  stockQuery?: string;
  assetUrl?: string;
}

interface SceneInspectorProps {
  scenes: SceneData[];
  style?: {
    primaryColor?: string;
  };
}

export const SceneInspector: React.FC<SceneInspectorProps> = ({
  scenes,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Find current scene based on frame
  const currentSceneIndex = useMemo(() => {
    for (let i = scenes.length - 1; i >= 0; i--) {
      const startFrame = (scenes[i] as any).startFrame || 0;
      if (frame >= startFrame) return i;
    }
    return 0;
  }, [frame, scenes]);

  const currentScene = scenes[currentSceneIndex];
  const currentTime = (frame / fps).toFixed(1);
  const totalTime = (durationInFrames / fps).toFixed(1);
  const startFrame = (currentScene as any).startFrame || 0;
  const endFrame = startFrame + currentScene.durationInFrames;
  const sceneProgress = Math.min(100, ((frame - startFrame) / currentScene.durationInFrames) * 100);

  // Transition badge colors
  const transitionColors: Record<string, string> = {
    'fade': '#3B82F6',
    'cut': '#EF4444',
    'zoom-in': '#8B5CF6',
    'zoom-out': '#6366F1',
    'slide-left': '#10B981',
    'whip': '#F59E0B',
  };

  // Animation badge colors
  const animationColors: Record<string, string> = {
    'ken-burns': '#06B6D4',
    'fade-in': '#3B82F6',
    'slide-left': '#10B981',
    'slide-right': '#10B981',
    'zoom-in': '#8B5CF6',
    'zoom-out': '#6366F1',
    'bounce': '#F59E0B',
    'kinetic-text': '#EC4899',
    'parallax': '#14B8A6',
    'scale-up': '#F97316',
  };

  const hasHeadline = currentScene.headline && currentScene.headline.length > 0;
  const hasDocument = hasHeadline && currentScene.headline!.includes('**');

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 9999 }}>
      {/* === TOP BAR: Time + Scene Counter === */}
      <div style={{
        position: 'absolute', top: 12, left: 12, right: 12,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{
          background: 'rgba(0,0,0,0.85)', borderRadius: 8, padding: '6px 14px',
          fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, color: '#fff',
          display: 'flex', gap: 12, alignItems: 'center',
          backdropFilter: 'blur(8px)',
        }}>
          <span style={{ color: '#94A3B8' }}>⏱️ {currentTime}s / {totalTime}s</span>
          <span style={{ color: '#94A3B8' }}>|</span>
          <span style={{ color: '#E2E8F0' }}>Frame {frame}</span>
          <span style={{ color: '#94A3B8' }}>|</span>
          <span style={{ color: style?.primaryColor || '#4F7BFF', fontWeight: 700 }}>
            Scene {currentSceneIndex + 1}/{scenes.length}
          </span>
        </div>
      </div>

      {/* === RIGHT PANEL: Scene Inspector === */}
      <div style={{
        position: 'absolute', top: 50, right: 12, width: 260,
        background: 'rgba(0,0,0,0.88)', borderRadius: 12,
        backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.1)',
        padding: '14px', fontFamily: 'Inter, system-ui, sans-serif',
        maxHeight: '70%', overflow: 'hidden',
      }}>
        {/* Scene ID + Type */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>{currentScene.id}</span>
          <span style={{
            background: 'rgba(255,255,255,0.1)', borderRadius: 4, padding: '2px 8px',
            fontSize: 11, color: '#94A3B8', textTransform: 'uppercase',
          }}>{currentScene.type}</span>
        </div>

        {/* Progress bar */}
        <div style={{ background: 'rgba(255,255,255,0.1)', borderRadius: 4, height: 4, marginBottom: 12 }}>
          <div style={{
            background: style?.primaryColor || '#4F7BFF', borderRadius: 4, height: 4,
            width: `${sceneProgress}%`, transition: 'width 0.05s',
          }} />
        </div>

        {/* Info rows */}
        <InfoRow label="⏱ Duração" value={`${currentScene.durationInFrames}f (${(currentScene.durationInFrames / fps).toFixed(1)}s)`} />
        <InfoRow label="📍 Frames" value={`${startFrame} → ${endFrame}`} />

        {/* Transition badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ color: '#64748B', fontSize: 12 }}>🔄 Transição</span>
          <Badge
            text={currentScene.transition || 'fade'}
            color={transitionColors[currentScene.transition || 'fade'] || '#3B82F6'}
          />
          <span style={{ color: '#475569', fontSize: 11 }}>
            {currentScene.transitionDurationFrames || 4}f
          </span>
        </div>

        {/* Animation badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ color: '#64748B', fontSize: 12 }}>✨ Animação</span>
          <Badge
            text={currentScene.animation || 'ken-burns'}
            color={animationColors[currentScene.animation || 'ken-burns'] || '#06B6D4'}
          />
        </div>

        {/* Visual type */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ color: '#64748B', fontSize: 12 }}>🖼 Mídia</span>
          <Badge
            text={currentScene.visualType || '—'}
            color={currentScene.visualType === 'ai_image' ? '#EC4899' :
                   currentScene.visualType === 'stock_video' ? '#10B981' : '#F59E0B'}
          />
        </div>

        {/* Headline */}
        {hasHeadline && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ color: '#64748B', fontSize: 12 }}>
                {hasDocument ? '📄 Documento' : '💬 Headline'}
              </span>
              {hasDocument && (
                <span style={{
                  background: '#FACC15', color: '#000', fontSize: 9, fontWeight: 700,
                  borderRadius: 3, padding: '1px 5px',
                }}>MARCA-TEXTO</span>
              )}
            </div>
            <div style={{
              background: 'rgba(255,255,255,0.05)', borderRadius: 6, padding: '6px 8px',
              color: '#CBD5E1', fontSize: 11, lineHeight: 1.4,
              maxHeight: 48, overflow: 'hidden',
            }}>
              {currentScene.headline}
            </div>
          </div>
        )}

        {/* Narration text */}
        {currentScene.narrationText && (
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: '#64748B', fontSize: 12 }}>🎤 Narração</span>
            <div style={{
              background: 'rgba(255,255,255,0.05)', borderRadius: 6, padding: '6px 8px',
              color: '#94A3B8', fontSize: 10, lineHeight: 1.3, marginTop: 3,
              maxHeight: 36, overflow: 'hidden',
            }}>
              {currentScene.narrationText}
            </div>
          </div>
        )}

        {/* Stock query */}
        {currentScene.stockQuery && (
          <InfoRow label="🔍 Query" value={currentScene.stockQuery} small />
        )}
      </div>

      {/* === BOTTOM: Mini Timeline === */}
      <div style={{
        position: 'absolute', bottom: 12, left: 12, right: 12,
        background: 'rgba(0,0,0,0.85)', borderRadius: 10,
        backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)',
        padding: '8px 10px', fontFamily: 'Inter, system-ui, sans-serif',
      }}>
        {/* Scene blocks */}
        <div style={{ display: 'flex', gap: 2, height: 28, alignItems: 'stretch' }}>
          {scenes.map((scene, i) => {
            const sceneStart = (scene as any).startFrame || 0;
            const sceneEnd = sceneStart + scene.durationInFrames;
            const widthPercent = (scene.durationInFrames / durationInFrames) * 100;
            const isCurrent = i === currentSceneIndex;
            const isPast = frame >= sceneEnd;

            const bgColor = isCurrent
              ? (style?.primaryColor || '#4F7BFF')
              : isPast
                ? 'rgba(255,255,255,0.15)'
                : 'rgba(255,255,255,0.06)';

            // Transition indicator
            const transType = scene.transition || 'fade';
            const transColor = transitionColors[transType] || '#3B82F6';

            return (
              <div
                key={scene.id}
                style={{
                  width: `${Math.max(widthPercent, 1.5)}%`,
                  background: bgColor,
                  borderRadius: 4,
                  position: 'relative',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  overflow: 'hidden',
                  border: isCurrent ? '1px solid rgba(255,255,255,0.4)' : '1px solid transparent',
                }}
              >
                {/* Transition dot */}
                <div style={{
                  position: 'absolute', top: 2, left: 2,
                  width: 5, height: 5, borderRadius: '50%',
                  background: transColor,
                }} />

                {/* Scene number */}
                <span style={{
                  fontSize: 8, color: isCurrent ? '#fff' : '#64748B',
                  fontWeight: isCurrent ? 700 : 400,
                }}>
                  {i + 1}
                </span>

                {/* Headline indicator */}
                {scene.headline && scene.headline.length > 0 && (
                  <div style={{
                    position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
                    width: 4, height: 4, borderRadius: '50%',
                    background: scene.headline.includes('**') ? '#FACC15' : '#fff',
                  }} />
                )}
              </div>
            );
          })}
        </div>

        {/* Playhead line */}
        <div style={{
          position: 'absolute', top: 4, bottom: 4,
          left: `${10 + ((frame / durationInFrames) * (100 - 1.5))}%`,
          width: 2, background: '#fff', borderRadius: 1,
          boxShadow: '0 0 6px rgba(255,255,255,0.5)',
        }} />

        {/* Legend */}
        <div style={{
          display: 'flex', gap: 10, marginTop: 6, justifyContent: 'center',
        }}>
          {Object.entries(transitionColors).map(([name, color]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
              <span style={{ fontSize: 8, color: '#64748B' }}>{name}</span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// === Helper Components ===

const InfoRow: React.FC<{ label: string; value: string; small?: boolean }> = ({ label, value, small }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 5,
  }}>
    <span style={{ color: '#64748B', fontSize: 12 }}>{label}</span>
    <span style={{
      color: '#E2E8F0', fontSize: small ? 10 : 12, fontWeight: 500,
      maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      textAlign: 'right',
    }}>{value}</span>
  </div>
);

const Badge: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <span style={{
    background: `${color}25`, border: `1px solid ${color}60`,
    color, borderRadius: 4, padding: '1px 8px',
    fontSize: 11, fontWeight: 600,
  }}>
    {text}
  </span>
);
