/** Map raw pen pressure (0..1) through the sensitivity curve and floor. */
export function mapPenPressure(raw: number, sensitivity: number, min: number): number {
  // Positive sensitivity bends the curve up (gamma < 1): light force reads higher.
  const curved = Math.max(0, Math.min(1, raw)) ** (4 ** (-sensitivity / 100));
  return min + (1 - min) * curved;
}
