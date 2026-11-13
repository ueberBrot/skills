export type Interval = readonly [number, number];

export const normalize = (intervals: readonly Interval[]): [number, number][] =>
  intervals.map(([start, end]): [number, number] => [start, end]).sort((a, b) => a[0] - b[0]);

export const subtract = (
  source: readonly Interval[],
  removed: readonly Interval[]
): [number, number][] => normalize(source).filter(([start, end]) =>
  !removed.some(([cutStart, cutEnd]) => cutStart <= start && cutEnd >= end)
);
