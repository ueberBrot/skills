export type Interval = readonly [number, number];

export const normalize = (intervals: readonly Interval[]): [number, number][] => {
  const sorted = intervals.map(([start, end]): [number, number] => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw new RangeError("Invalid interval");
    }
    return [start, end];
  }).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
};

export const subtract = (
  source: readonly Interval[],
  removed: readonly Interval[]
): [number, number][] => {
  const cuts = normalize(removed);
  const output: [number, number][] = [];
  for (const [start, end] of normalize(source)) {
    let cursor = start;
    for (const [cutStart, cutEnd] of cuts) {
      if (cutEnd <= cursor) continue;
      if (cutStart >= end) break;
      if (cutStart > cursor) output.push([cursor, cutStart]);
      cursor = Math.max(cursor, cutEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) output.push([cursor, end]);
  }
  return output;
};
