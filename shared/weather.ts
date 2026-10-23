/** Provider-derived public weather only; no coordinates or personal account data. */
export interface WeatherForecast {
  mode: 'live';
  unit: 'fahrenheit';
  timeZone: string;
  locationLabel: string;
  temperatureFahrenheit: number;
  highFahrenheit: number;
  lowFahrenheit: number;
  condition: string;
  observedAt: string;
  fetchedAt: string;
}
