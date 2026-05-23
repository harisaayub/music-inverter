/**
 * Utilities for warping a linear-frequency spectrum into a log-frequency
 * (equal-octave) representation and back.
 *
 * In a standard FFT the bin spacing is linear: bin k = k * sampleRate / frameSize Hz.
 * That means a 20–40 Hz octave occupies the same number of bins as a 10000–20000 Hz
 * octave, so any "symmetric" rearrangement applied in linear bin space is wildly
 * asymmetric in musical terms.
 *
 * By resampling to a log-frequency grid first, each octave occupies the same number
 * of grid slots, making transformations like flip and mirror behave musically.
 */

/**
 * Build a table mapping each log-grid slot to a fractional linear bin position.
 *
 * @param {number} numberOfLogSlots   — how many slots in the log grid (typically halfFrameSize + 1)
 * @param {number} halfFrameSize      — halfFrameSize of the FFT (= frameSize / 2)
 * @param {number} lowestFrequencyHz  — lower bound for the log grid (avoid log(0))
 * @param {number} highestFrequencyHz — upper bound (typically sampleRate / 2)
 * @param {number} sampleRate
 * @returns {Float64Array}  fractional linear bin index for each log slot
 */
export function buildLogToLinearBinTable(
  numberOfLogSlots,
  halfFrameSize,
  lowestFrequencyHz,
  highestFrequencyHz,
  sampleRate,
) {
  const logTable = new Float64Array(numberOfLogSlots);
  const logLow  = Math.log(lowestFrequencyHz);
  const logHigh = Math.log(highestFrequencyHz);

  for (let slotIndex = 0; slotIndex < numberOfLogSlots; slotIndex++) {
    const normalizedLogPosition = slotIndex / (numberOfLogSlots - 1); // 0..1
    const frequencyHz = Math.exp(logLow + normalizedLogPosition * (logHigh - logLow));
    logTable[slotIndex] = frequencyHz * (halfFrameSize * 2) / sampleRate; // fractional linear bin
  }
  return logTable;
}

/**
 * Resample a linear-frequency spectrum into a log-frequency grid using
 * linear interpolation between adjacent bins.
 *
 * @param {Float64Array} linearReal
 * @param {Float64Array} linearImaginary
 * @param {Float64Array} logToLinearTable  — from buildLogToLinearBinTable
 * @param {number}       halfFrameSize
 * @returns {{ logReal: Float64Array, logImaginary: Float64Array }}
 */
export function resampleLinearToLog(linearReal, linearImaginary, logToLinearTable, halfFrameSize) {
  const numberOfLogSlots = logToLinearTable.length;
  const logReal      = new Float64Array(numberOfLogSlots);
  const logImaginary = new Float64Array(numberOfLogSlots);

  for (let slotIndex = 0; slotIndex < numberOfLogSlots; slotIndex++) {
    const fractionalLinearBin = logToLinearTable[slotIndex];
    const lowerLinearBin = Math.floor(fractionalLinearBin);
    const upperLinearBin = Math.min(lowerLinearBin + 1, halfFrameSize);
    const interpolationWeight = fractionalLinearBin - lowerLinearBin;

    logReal[slotIndex] = linearReal[lowerLinearBin] * (1 - interpolationWeight)
                       + linearReal[upperLinearBin] * interpolationWeight;
    logImaginary[slotIndex] = linearImaginary[lowerLinearBin] * (1 - interpolationWeight)
                            + linearImaginary[upperLinearBin] * interpolationWeight;
  }

  return { logReal, logImaginary };
}

/**
 * Resample a log-frequency spectrum back to a linear-frequency grid.
 * Each linear bin gathers its value from the nearest log slot.
 * Bins outside the log grid's frequency range are left at zero.
 *
 * @param {Float64Array} logReal
 * @param {Float64Array} logImaginary
 * @param {Float64Array} logToLinearTable
 * @param {number}       halfFrameSize
 * @returns {{ linearReal: Float64Array, linearImaginary: Float64Array }}
 */
export function resampleLogToLinear(logReal, logImaginary, logToLinearTable, halfFrameSize) {
  const numberOfPositiveBins = halfFrameSize + 1;
  const linearReal      = new Float64Array(numberOfPositiveBins);
  const linearImaginary = new Float64Array(numberOfPositiveBins);
  const numberOfLogSlots = logToLinearTable.length;

  // For each log slot, scatter its energy to the nearest linear bin.
  // Multiple log slots can land on the same linear bin; we average them.
  const contributionCount = new Float64Array(numberOfPositiveBins);

  for (let slotIndex = 0; slotIndex < numberOfLogSlots; slotIndex++) {
    const fractionalLinearBin = logToLinearTable[slotIndex];
    const lowerLinearBin = Math.floor(fractionalLinearBin);
    const upperLinearBin = Math.min(lowerLinearBin + 1, halfFrameSize);
    const upperWeight    = fractionalLinearBin - lowerLinearBin;
    const lowerWeight    = 1 - upperWeight;

    if (lowerLinearBin >= 0 && lowerLinearBin <= halfFrameSize) {
      linearReal[lowerLinearBin]      += logReal[slotIndex]      * lowerWeight;
      linearImaginary[lowerLinearBin] += logImaginary[slotIndex] * lowerWeight;
      contributionCount[lowerLinearBin] += lowerWeight;
    }
    if (upperLinearBin !== lowerLinearBin && upperLinearBin <= halfFrameSize) {
      linearReal[upperLinearBin]      += logReal[slotIndex]      * upperWeight;
      linearImaginary[upperLinearBin] += logImaginary[slotIndex] * upperWeight;
      contributionCount[upperLinearBin] += upperWeight;
    }
  }

  for (let binIndex = 0; binIndex < numberOfPositiveBins; binIndex++) {
    if (contributionCount[binIndex] > 1e-10) {
      linearReal[binIndex]      /= contributionCount[binIndex];
      linearImaginary[binIndex] /= contributionCount[binIndex];
    }
  }

  return { linearReal, linearImaginary };
}
