import { processAudioBuffer } from './stftProcessor.js';
import { encodeAudioBufferToWav } from './wavEncoder.js';
import { MODE_HINTS, MODE_ACTIVE_PARAMS } from './frequencyRearrangement.js';

let sharedAudioContext = null;
let decodedAudioBuffer = null;

function getOrCreateAudioContext() {
  if (!sharedAudioContext) sharedAudioContext = new AudioContext();
  return sharedAudioContext;
}

function setStatusMessage(message, cssClass = '') {
  const statusElement = document.getElementById('status');
  statusElement.textContent = message;
  statusElement.className   = cssClass;
}

// ─── Slider + number input sync ───────────────────────────────────────────

/**
 * Wire a range slider and a paired number input so that changing either one
 * updates the other. Both must share the same min/max/step attributes.
 *
 * @param {string} sliderId   — id of the <input type="range">
 * @param {string} numberId   — id of the <input type="number">
 */
function linkSliderToNumberInput(sliderId, numberId) {
  const sliderElement = document.getElementById(sliderId);
  const numberElement = document.getElementById(numberId);

  sliderElement.addEventListener('input', () => {
    numberElement.value = sliderElement.value;
  });

  numberElement.addEventListener('input', () => {
    const enteredValue  = parseFloat(numberElement.value);
    const minimumValue  = parseFloat(sliderElement.min);
    const maximumValue  = parseFloat(sliderElement.max);
    const clampedValue  = Math.max(minimumValue, Math.min(maximumValue, enteredValue));
    sliderElement.value = clampedValue;
    numberElement.value = clampedValue;
  });
}

/**
 * Wire a range slider to a number input using a logarithmic (exponential)
 * frequency mapping so that slider travel feels perceptually even across octaves.
 *
 * The slider stores a dimensionless position [0, 1000].
 * The number input shows and accepts actual Hz values.
 *
 * Mapping: hz = minimumHz * (maximumHz / minimumHz) ^ (sliderPosition / 1000)
 *
 * @param {string} sliderId
 * @param {string} numberId
 * @param {number} minimumHz
 * @param {number} maximumHz
 */
function linkLogFrequencySliderToNumberInput(sliderId, numberId, minimumHz, maximumHz) {
  const sliderElement  = document.getElementById(sliderId);
  const numberElement  = document.getElementById(numberId);
  const frequencyRatio = maximumHz / minimumHz;

  const sliderPositionToHz = sliderPosition =>
    minimumHz * Math.pow(frequencyRatio, sliderPosition / 1000);

  const hzToSliderPosition = hz =>
    Math.log(hz / minimumHz) / Math.log(frequencyRatio) * 1000;

  sliderElement.addEventListener('input', () => {
    const frequencyHz   = sliderPositionToHz(parseFloat(sliderElement.value));
    numberElement.value = Math.round(frequencyHz);
  });

  numberElement.addEventListener('input', () => {
    const enteredHz      = parseFloat(numberElement.value);
    const clampedHz      = Math.max(minimumHz, Math.min(maximumHz, enteredHz));
    numberElement.value  = clampedHz;
    sliderElement.value  = hzToSliderPosition(clampedHz);
  });

  // Initialise number input from slider's starting position
  numberElement.value = Math.round(sliderPositionToHz(parseFloat(sliderElement.value)));
}

// ─── Parameter visibility ─────────────────────────────────────────────────

function updateVisibleParameters() {
  const selectedMode = document.getElementById('mode').value;
  document.querySelectorAll('.param-row').forEach(rowElement => {
    rowElement.classList.remove('active');
  });
  (MODE_ACTIVE_PARAMS[selectedMode] || []).forEach(parameterName => {
    const rowElement = document.getElementById('param-row-' + parameterName);
    if (rowElement) rowElement.classList.add('active');
  });
  document.getElementById('modeHint').textContent = MODE_HINTS[selectedMode] ?? '';
}

// ─── Frame size Hz/bin label ──────────────────────────────────────────────

function updateFrameSizeLabel() {
  const sampleRate    = decodedAudioBuffer ? decodedAudioBuffer.sampleRate : 44100;
  const frameSizeValue = parseInt(document.getElementById('frameSize').value);
  document.getElementById('frameSizeHzPerBin').textContent =
    `${(sampleRate / frameSizeValue).toFixed(1)} Hz/bin`;
}

// ─── Collect current parameters from UI ──────────────────────────────────

function collectCurrentParameters() {
  return {
    flipCeilingHz:       parseFloat(document.getElementById('flipCeilingHz').value),
    mirrorFrequencyHz:   parseFloat(document.getElementById('mirrorFrequencyHz').value),
    powerExponent:       parseFloat(document.getElementById('powerExponent').value),
    compressionRatio:    parseFloat(document.getElementById('compressionRatio').value),
    shiftOffsetInBins:   parseFloat(document.getElementById('shiftOffsetInBins').value),
    useLogFrequencyScale: document.getElementById('useLogFrequencyScale').checked,
  };
}

// ─── File loading ─────────────────────────────────────────────────────────

document.getElementById('fileInput').addEventListener('change', async (changeEvent) => {
  const selectedFile = changeEvent.target.files[0];
  if (!selectedFile) return;

  setStatusMessage('Decoding…');
  try {
    const rawArrayBuffer = await selectedFile.arrayBuffer();
    decodedAudioBuffer   = await getOrCreateAudioContext().decodeAudioData(rawArrayBuffer);

    setStatusMessage(
      `Loaded: ${decodedAudioBuffer.numberOfChannels}ch · `
      + `${decodedAudioBuffer.sampleRate} Hz · `
      + `${decodedAudioBuffer.duration.toFixed(2)}s`,
      'ok',
    );
    document.getElementById('processButton').disabled = false;
    document.getElementById('playerArea').style.display = 'none';
    updateFrameSizeLabel();
  } catch (decodeError) {
    setStatusMessage('Failed to decode: ' + decodeError.message, 'err');
  }
});

// ─── Processing ───────────────────────────────────────────────────────────

document.getElementById('processButton').addEventListener('click', async () => {
  if (!decodedAudioBuffer) return;

  const processButton = document.getElementById('processButton');
  processButton.disabled = true;
  setStatusMessage('Processing…');

  // Yield to let the browser repaint before blocking on the FFT loop
  await new Promise(resolve => setTimeout(resolve, 30));

  try {
    const selectedMode    = document.getElementById('mode').value;
    const frameSizeValue  = parseInt(document.getElementById('frameSize').value);
    const hopFractionValue = parseFloat(document.getElementById('hopFraction').value);
    const currentParameters = collectCurrentParameters();

    const outputAudioBuffer = processAudioBuffer(
      decodedAudioBuffer,
      frameSizeValue,
      hopFractionValue,
      selectedMode,
      currentParameters,
    );

    const wavBlob    = encodeAudioBufferToWav(outputAudioBuffer);
    const blobUrl    = URL.createObjectURL(wavBlob);

    document.getElementById('audioPlayer').src = blobUrl;
    document.getElementById('downloadLink').href = blobUrl;
    document.getElementById('playerArea').style.display = 'block';
    setStatusMessage('Done.', 'ok');
  } catch (processingError) {
    setStatusMessage('Error: ' + processingError.message, 'err');
    console.error(processingError);
  }

  processButton.disabled = false;
});

// ─── Init ─────────────────────────────────────────────────────────────────

document.getElementById('mode').addEventListener('change', updateVisibleParameters);
document.getElementById('frameSize').addEventListener('input', updateFrameSizeLabel);

linkLogFrequencySliderToNumberInput('flipCeilingHzSlider',    'flipCeilingHz',     100, 20000);
linkLogFrequencySliderToNumberInput('mirrorFrequencyHzSlider', 'mirrorFrequencyHz', 20,  20000);
linkSliderToNumberInput('powerExponentSlider',     'powerExponent');
linkSliderToNumberInput('compressionRatioSlider',  'compressionRatio');
linkSliderToNumberInput('shiftOffsetInBinsSlider', 'shiftOffsetInBins');

updateVisibleParameters();
updateFrameSizeLabel();
