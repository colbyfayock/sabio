import { initializeLocationControls } from './location';
import { initializeWeatherController } from './weather';
import { initializeDisplayTime } from './display-time';
import { initializePhotos } from './photos';
import { initializeAccess } from './access';

void initializeAccess().then((mode) => {
  if (!mode) return;
  const modeLabel = document.getElementById('display-mode');
  if (modeLabel) modeLabel.textContent = mode === 'preview' ? '/ Local preview' : '/ Approved browser';
  const clock = initializeDisplayTime();
  let weather: ReturnType<typeof initializeWeatherController> | null = null;
  const location = initializeLocationControls('Weather location', (zipCode) => {
    weather?.setZipCode(zipCode);
  });
  clock.setTimeZone(null, location.getSelectedZipCode() !== null);
  weather = initializeWeatherController(() => location.getSelectedZipCode(), (timeZone) => {
    clock.setTimeZone(timeZone, location.getSelectedZipCode() !== null);
  }, mode === 'managed' ? 'same-origin' : 'omit');
  initializePhotos();
});

const fullscreenButton = document.getElementById('fullscreen-toggle');
const fullscreenLabel = document.getElementById('fullscreen-label');
function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function fullscreenIsActive(): boolean {
  const doc = document as Document & { mozFullScreenElement?: Element | null; mozFullScreen?: boolean };
  return Boolean(document.fullscreenElement || doc.mozFullScreenElement || doc.mozFullScreen);
}

function updateFullscreenButton(): void {
  const active = fullscreenIsActive();
  fullscreenButton?.setAttribute('aria-pressed', String(active));
  if (fullscreenLabel) fullscreenLabel.textContent = active ? 'Exit fullscreen' : 'Enter fullscreen';
}

function fullscreenError(): void {
  setText('fullscreen-message', 'Fullscreen isn’t available in this browser.');
  updateFullscreenButton();
}

function toggleFullscreen(): void {
  const doc = document as Document & { mozCancelFullScreen?: () => void };
  const root = document.documentElement as HTMLElement & { mozRequestFullScreen?: () => void };
  try {
    let result: Promise<void> | void = undefined;
    if (fullscreenIsActive()) {
      if (document.exitFullscreen) result = document.exitFullscreen();
      else if (doc.mozCancelFullScreen) doc.mozCancelFullScreen();
      else { fullscreenError(); return; }
    } else if (root.requestFullscreen) result = root.requestFullscreen();
    else if (root.mozRequestFullScreen) root.mozRequestFullScreen();
    else { fullscreenError(); return; }
    if (result && typeof result.then === 'function') {
      result.then(() => setText('fullscreen-message', '')).catch(fullscreenError);
    } else setText('fullscreen-message', '');
  } catch {
    fullscreenError();
  }
}

fullscreenButton?.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('mozfullscreenchange', updateFullscreenButton as EventListener);
document.addEventListener('fullscreenerror', fullscreenError);
document.addEventListener('mozfullscreenerror', fullscreenError as EventListener);
updateFullscreenButton();
