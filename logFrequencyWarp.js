/**
 * Utilities for warping between a linear-frequency FFT spectrum and a
 * log-frequency (equal-octave) representation.
 *
 * Why this matters:
 *   A standard FFT has equal Hz spacing per bin, so a one-octave band at
 *   100-200 Hz occupies ~5 bins while the same octave at 10000-20000 Hz
 *   occupies ~465 bins (with a 44100 Hz / 2048 frame setup). Any symmetric
 *   rearrangement applied in linear bin space is wildly asymmetric musically.
 *
 * Key design choice — gather not scatter for log→linear:
 *   When converting the rearranged log spectrum back to linear, we use a
 *   gather: for each linear bin we compute its log-grid position and
 *   interpolate. This ensures every linear bin gets a valid value.
 *   Scatter (the alternative) leaves gaps wherever a small number of
 *   log-slots needs to cover a large number of linear bins — exactly the
 *   problematic region after a spectral flip.
 */

/**
 * Bundle of parameters that describe a log-frequency warp configuration.
 * Build once per processAudioBuffer call and reuse across frames.
 *
 * @typedef {Object} LogWarpConfig
 * @property {number} numberOfLogSlots
 * @property {number} halfFrameSize
 * @property {number} lowestFrequencyHz
 * @property {number} highestFrequencyHz
 * @property {number} sampleRate
 * @property {number} logOfLowestFrequency   — Math.log(lowestFrequencyHz), cached
 * @property {number} logFrequencyRange      — Math.log(highestFrequencyHz) - logOfLowest, cached
 */

/**
 * @param {number} numberOfLogSlots
 * @param {number} halfFrameSize
 * @param {number} lowestFrequencyHz
 * @param {number} highestFrequencyHz
 * @param {number} sampleRate
 * @returns {LogWarpConfig}
 */
export function buildLogWarpConfig(
  numberOfLogSlots,
  halfFrameSize,
  lowestFrequencyHz,
  highestFrequencyHz,
  sampleRate,
) {
  return {
    numberOfLogSlots,
    halfFrameSize,
    lowestFrequencyHz,
    highestFrequencyHz,
    sampleRate,
    logOfLowestFrequency: Math.log(lowestFrequencyHz),
    logFrequencyRange:    Math.log(highestFrequencyHz) - Math.log(lowestFrequencyHz),
  };
}

/**
 * Resample a linear-frequency spectrum to a log-frequency grid (gather).
 * For each log slot, compute the corresponding fractional linear bin and
 * linearly interpolate between the two adjacent bins.
 *
 * @param {Float64Array} linearReal
 * @param {Float64Array} linearImaginary
 * @param {LogWarpConfig} config
 * @returns {{ logReal: Float64Array, logImaginary: Float64Array }}
 */
export function resampleLinearToLog(linearReal, linearImaginary, config) {
  const {
    numberOfLogSlots,
    halfFrameSize,
    sampleRate,
    logOfLowestFrequency,
    logFrequencyRange,
  } = config;

  const logReal      = new Float64Array(numberOfLogSlots);
  const logImaginary = new Float64Array(numberOfLogSlots);

  for (let slotIndex = 0; slotIndex < numberOfLogSlots; slotIndex++) {
    const normalizedLogPosition  = slotIndex / (numberOfLogSlots - 1); // 0..1
    const slotFrequencyHz        = Math.exp(logOfLowestFrequency + normalizedLogPosition * logFrequencyRange);
    const fractionalLinearBin    = slotFrequencyHz * (halfFrameSize * 2) / sampleRate;

    const lowerLinearBin         = Math.floor(fractionalLinearBin);
    const upperLinearBin         = Math.min(lowerLinearBin + 1, halfFrameSize);
    const upperInterpolationWeight = fractionalLinearBin - lowerLinearBin;
    const lowerInterpolationWeight = 1 - upperInterpolationWeight;

    logReal[slotIndex]      = linearReal[lowerLinearBin]      * lowerInterpolationWeight
                            + linearReal[upperLinearBin]      * upperInterpolationWeight;
    logImaginary[slotIndex] = linearImaginary[lowerLinearBin] * lowerInterpolationWeight
                            + linearImaginary[upperLinearBin] * upperInterpolationWeight;
  }

  return { logReal, logImaginary };
}

/**
 * Resample a log-frequency spectrum back to a linear-frequency grid (gather).
 *
 * For each linear bin, we invert the log mapping to find its fractional
 * position in the log grid, then linearly interpolate between adjacent slots.
 * This guarantees every linear bin gets a valid value — including high-
 * frequency bins that would be left empty by a scatter approach when only a
 * small number of log slots covers a large range of linear bins.
 *
 * Linear bins outside the log grid's [lowestHz, highestHz] range are zeroed.
 *
 * @param {Float64Array} logReal
 * @param {Float64Array} logImaginary
 * @param {LogWarpConfig} config
 * @returns {{ linearReal: Float64Array, linearImaginary: Float64Array }}
 */
export function resampleLogToLinear(logReal, logImaginary, config) {
  const {
    numberOfLogSlots,
    halfFrameSize,
    lowestFrequencyHz,
    highestFrequencyHz,
    sampleRate,
    logOfLowestFrequency,
    logFrequencyRange,
  } = config;

  const numberOfPositiveBins = halfFrameSize + 1;
  const linearReal           = new Float64Array(numberOfPositiveBins);
  const linearImaginary      = new Float64Array(numberOfPositiveBins);

  // DC (bin 0 = 0 Hz) is below the log grid — leave at zero
  for (let linearBinIndex = 1; linearBinIndex <= halfFrameSize; linearBinIndex++) {
    const binFrequencyHz = linearBinIndex * sampleRate / (halfFrameSize * 2);

    if (binFrequencyHz < lowestFrequencyHz || binFrequencyHz > highestFrequencyHz) {
      // Outside the log grid range — leave at zero
      continue;
    }

    // Invert the log mapping to get a fractional slot index
    const fractionalSlotPosition = (Math.log(binFrequencyHz) - logOfLowestFrequency)
                                 / logFrequencyRange
                                 * (numberOfLogSlots - 1);

    const lowerSlotIndex          = Math.floor(fractionalSlotPosition);
    const upperSlotIndex          = Math.min(lowerSlotIndex + 1, numberOfLogSlots - 1);
    const upperInterpolationWeight = fractionalSlotPosition - lowerSlotIndex;
    const lowerInterpolationWeight = 1 - upperInterpolationWeight;

    linearReal[linearBinIndex]      = logReal[lowerSlotIndex]      * lowerInterpolationWeight
                                    + logReal[upperSlotIndex]      * upperInterpolationWeight;
    linearImaginary[linearBinIndex] = logImaginary[lowerSlotIndex] * lowerInterpolationWeight
                                    + logImaginary[upperSlotIndex] * upperInterpolationWeight;
  }

  return { linearReal, linearImaginary };
}
