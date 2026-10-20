/**
 * 摄像头能力检测
 *
 * 浏览器只允许在「安全上下文」中使用 getUserMedia：
 *   - https://
 *   - http://localhost / http://127.0.0.1
 *   - file://
 *
 * 手机通过 http://192.168.x.x 访问时不属于安全上下文，
 * 需降级为 <input type="file" capture="environment"> 调起系统相机。
 */

export type CameraMode = 'live' | 'capture';

/**
 * 当前环境是否可以使用实时取景（getUserMedia）
 */
export const canUseLiveCamera = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
};

/**
 * 选择摄像头模式：安全上下文走实时取景，否则走系统相机
 */
export const pickCameraMode = (): CameraMode =>
  canUseLiveCamera() ? 'live' : 'capture';

/**
 * 无法使用实时取景时的原因说明（用于 UI 提示）
 */
export const getCaptureModeHint = (): string =>
  '当前地址非 HTTPS，已切换为调用系统相机拍照，识别效果一致。';
