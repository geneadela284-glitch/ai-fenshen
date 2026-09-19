export const MEETING_ROW_SWIPE_THRESHOLD = 48;
export const MEETING_ROW_DELETE_REVEAL_OFFSET = -88;

export function resolveMeetingRowSwipe({ startX, startY, endX, endY } = {}) {
  const values = [startX, startY, endX, endY].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return 0;
  const [fromX, fromY, toX, toY] = values;
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  if (deltaX > -MEETING_ROW_SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
  return MEETING_ROW_DELETE_REVEAL_OFFSET;
}
