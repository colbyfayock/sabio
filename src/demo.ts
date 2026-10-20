import type { DemoDashboard } from '../shared/dashboard';

/** Create a fresh bounded fixture; never share mutable request data across callers. */
export function createDemoDashboard(now = new Date()): DemoDashboard {
  return {
    mode: 'demo',
    updatedAt: now.toISOString(),
    weather: {
      temperatureCelsius: 24,
      condition: 'Mostly sunny',
      highCelsius: 26,
      lowCelsius: 18,
      locationLabel: 'Sample weather',
    },
    events: [
      { id: 'morning', time: '09:00', title: 'A slow start', detail: 'Coffee, a walk, a little fresh air' },
      { id: 'afternoon', time: '13:30', title: 'Make something good', detail: 'A little room for a creative project' },
      { id: 'evening', time: '18:00', title: 'Around the table', detail: 'An easy evening at home' },
    ],
    tasks: [
      { id: 'plants', title: 'Water the plants', completed: false },
      { id: 'windows', title: 'Let the fresh air in', completed: true },
      { id: 'tomorrow', title: 'Leave a little space for tomorrow', completed: false },
    ],
    note: 'A calm place for your day. Everything here is sample content; nothing is connected or saved.',
  };
}
