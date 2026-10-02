import { computeOverlayCanvasSize, mapNormalizedToDisplay } from '../engine/coordinateMapping';
import type { TrackerSample } from './trackerProvider';

/** Diagnostic box + Euler triad, never the source-face renderer. Raw axes explicitly labelled. */
export function drawTrackerOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement, sample: TrackerSample, mirrored: boolean): void {
  const width = video.clientWidth, height = video.clientHeight;
  const backing = computeOverlayCanvasSize(width, height, window.devicePixelRatio);
  if (canvas.width !== backing.width || canvas.height !== backing.height) { canvas.width = backing.width; canvas.height = backing.height; }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(backing.ratio, 0, 0, backing.ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!sample.detected || sample.centerX === null || sample.centerY === null || sample.scale === null) return;
  const geometry = { sourceWidth: video.videoWidth, sourceHeight: video.videoHeight, displayWidth: width, displayHeight: height, objectFit: 'cover' as const, mirrored };
  const center = mapNormalizedToDisplay({ x: sample.centerX, y: sample.centerY }, geometry);
  // Jeeliz scale is square detection width. MediaPipe's scale is eye span; distinguish in UI.
  const boxScale = sample.provider === 'jeeliz' ? sample.scale : sample.scale * 2.5;
  const a = mapNormalizedToDisplay({ x: sample.centerX - boxScale / 2, y: sample.centerY - boxScale * video.videoWidth / video.videoHeight / 2 }, geometry);
  const b = mapNormalizedToDisplay({ x: sample.centerX + boxScale / 2, y: sample.centerY + boxScale * video.videoWidth / video.videoHeight / 2 }, geometry);
  context.strokeStyle = '#5ef5bf'; context.lineWidth = 2;
  context.strokeRect(Math.min(a.x, b.x), a.y, Math.abs(b.x - a.x), b.y - a.y);
  context.beginPath(); context.arc(center.x, center.y, 4, 0, Math.PI * 2); context.stroke();
  const raw = sample.rawRotation ?? (sample.pose ? [-sample.pose.pitch, sample.pose.yaw, sample.pose.roll] : null);
  if (raw) {
    const [rx, ry, rz] = raw;
    const sx = Math.sin(rx), cx = Math.cos(rx), sy = Math.sin(ry), cy = Math.cos(ry), sz = Math.sin(rz), cz = Math.cos(rz);
    // Official JeelizThreeHelper uses Euler order ZYX: Rz * Ry * Rx.
    const axes = [[cz * cy, sz * cy], [cz * sy * sx - sz * cx, sz * sy *sx + cz * cx], [cz * sy * cx + sz * sx, sz * sy * cx - cz * sx]];
    axes.forEach(([x, y], index) => {
      context.strokeStyle = ['#ff7188', '#5ef5bf', '#79bfff'][index]!;
      context.beginPath(); context.moveTo(center.x, center.y);
      context.lineTo(center.x + x! * 45 * (mirrored ? -1 : 1), center.y - y! * 45); context.stroke();
    });
  }
  context.font = '12px sans-serif'; context.fillStyle = '#fff';
  const labelX = Math.max(4, Math.min(width - 155, center.x - 70));
  const labelY = Math.max(20, Math.min(height - 8, a.y - 8));
  context.fillText(`${(sample.confidence * 100).toFixed(0)}% · scale ${sample.scale.toFixed(2)}`, labelX, labelY);
  if (sample.provider === 'jeeliz') context.fillText('Raw Jeeliz Euler axes', labelX, Math.min(height - 8, labelY + 16));
}
