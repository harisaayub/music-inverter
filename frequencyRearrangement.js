/**
 * Rearranges the positive-frequency bins of one FFT frame.
 *
 * Works on bins [0 .. halfFrameSize] inclusive (halfFrameSize + 1 bins total).
 * Returns new parallel real/imaginary arrays of the same length; the caller is
 * responsible for mirroring them into the negative-frequency side before IFFT.
 *
 * @param {Float64Array} sourceReal
 * @param {Float64Array} sourceImaginary
 * @param {string} mode
 * @param {object} parameters
 * @param {number} sampleRate
 * @param {number} halfFrameSize  — frameSize / 2
 * @returns {{ rearrangedReal: Float64Array, rearrangedImaginary: Float64Array }}
 */
export function rearrangeFrequencyBins(
  sourceReal,
  sourceImaginary,
  mode,
  parameters,
  sampleRate,
  halfFrameSize,
) {
  const numberOfPositiveBins = halfFrameSize + 1;
  const outputReal      = new Float64Array(numberOfPositiveBins);
  const outputImaginary = new Float64Array(numberOfPositiveBins);

  const binIndexToHertz  = binIndex => binIndex * sampleRate / (halfFrameSize * 2);
  const hertzToBinIndex  = hertz    => hertz    * halfFrameSize * 2 / sampleRate;

  // The lowest representable non-DC frequency for this frame
  const lowestNonDcFrequencyHz = binIndexToHertz(1);

  if (mode === 'flip') {
    // Reverse the spectrum up to the ceiling frequency using log-frequency distances,
    // so equal octave distance below the ceiling mirrors to equal octave distance above
    // the geometric centre. Bins above the ceiling are zeroed.
    //
    // Log flip formula: f_flipped = f_lowest * f_ceiling / f_source
    // (equivalent to reflecting log(f) around the midpoint of the log axis)
    const flipCeilingHz  = Math.min(parameters.flipCeilingHz, sampleRate / 2);
    const flipCeilingBin = Math.round(hertzToBinIndex(flipCeilingHz));

    // DC (bin 0) maps to DC in the output — it has no log-frequency position
    outputReal[0]      = sourceReal[0];
    outputImaginary[0] = sourceImaginary[0];

    for (let binIndex = 1; binIndex <= flipCeilingBin; binIndex++) {
      const sourceFrequencyHz      = binIndexToHertz(binIndex);
      const mirroredFrequencyHz    = lowestNonDcFrequencyHz * flipCeilingHz / sourceFrequencyHz;
      const destinationBinIndex    = Math.round(hertzToBinIndex(mirroredFrequencyHz));
      if (destinationBinIndex < 0 || destinationBinIndex > halfFrameSize) continue;
      outputReal[destinationBinIndex]      += sourceReal[binIndex];
      outputImaginary[destinationBinIndex] += sourceImaginary[binIndex];
    }

  } else if (mode === 'mirror') {
    // Reflect each bin around the pivot frequency using log distances so that
    // a source one octave below the pivot maps to one octave above, etc.
    //
    // Log mirror formula: f_mirrored = f_pivot² / f_source
    const pivotFrequencyHz = parameters.mirrorFrequencyHz;

    // DC passes through unchanged (it has no log position)
    outputReal[0]      = sourceReal[0];
    outputImaginary[0] = sourceImaginary[0];

    for (let binIndex = 1; binIndex < numberOfPositiveBins; binIndex++) {
      const sourceFrequencyHz   = binIndexToHertz(binIndex);
      const mirroredFrequencyHz = (pivotFrequencyHz * pivotFrequencyHz) / sourceFrequencyHz;

      let destinationBinIndex = Math.round(hertzToBinIndex(mirroredFrequencyHz));
      // fold back into valid range using log-space bouncing
      if (destinationBinIndex < 1) {
        // bounced below lowestNonDC — reflect upward from bin 1
        destinationBinIndex = Math.abs(destinationBinIndex - 1) + 1;
      }
      if (destinationBinIndex > halfFrameSize) {
        destinationBinIndex = 2 * halfFrameSize - destinationBinIndex;
      }
      if (destinationBinIndex < 0 || destinationBinIndex > halfFrameSize) continue;
      outputReal[destinationBinIndex]      += sourceReal[binIndex];
      outputImaginary[destinationBinIndex] += sourceImaginary[binIndex];
    }

  } else if (mode === 'fold') {
    // Bins below the fold frequency pass through unchanged.
    // Bins above fold back down using log-distance reflection:
    // f_reflected = f_pivot² / f_source
    const foldFrequencyHz = parameters.mirrorFrequencyHz;

    // DC always passes through
    outputReal[0]      = sourceReal[0];
    outputImaginary[0] = sourceImaginary[0];

    for (let binIndex = 1; binIndex < numberOfPositiveBins; binIndex++) {
      const sourceFrequencyHz = binIndexToHertz(binIndex);
      let destinationFrequencyHz = sourceFrequencyHz;

      if (sourceFrequencyHz > foldFrequencyHz) {
        destinationFrequencyHz = (foldFrequencyHz * foldFrequencyHz) / sourceFrequencyHz;
        // If it bounces below lowestNonDC, fold it back up
        if (destinationFrequencyHz < lowestNonDcFrequencyHz) {
          destinationFrequencyHz =
            (lowestNonDcFrequencyHz * lowestNonDcFrequencyHz) / destinationFrequencyHz;
        }
      }

      const destinationBinIndex = Math.round(hertzToBinIndex(destinationFrequencyHz));
      if (destinationBinIndex < 0 || destinationBinIndex > halfFrameSize) continue;
      outputReal[destinationBinIndex]      += sourceReal[binIndex];
      outputImaginary[destinationBinIndex] += sourceImaginary[binIndex];
    }

  } else if (mode === 'power') {
    // Non-linear axis warp: output bin k reads from input bin k^exponent (normalised).
    // Exponent < 1 squashes high frequencies toward low; > 1 does the opposite.
    const powerExponent = parameters.powerExponent;

    for (let binIndex = 0; binIndex < numberOfPositiveBins; binIndex++) {
      const normalizedBinPosition = binIndex / halfFrameSize;        // 0..1
      const warpedNormalizedPosition = Math.pow(normalizedBinPosition, powerExponent);
      const sourceBinPosition = warpedNormalizedPosition * halfFrameSize;

      const lowerSourceBin = Math.floor(sourceBinPosition);
      const upperSourceBin = Math.min(lowerSourceBin + 1, halfFrameSize);
      const interpolationFraction = sourceBinPosition - lowerSourceBin;

      outputReal[binIndex] = sourceReal[lowerSourceBin] * (1 - interpolationFraction)
                           + sourceReal[upperSourceBin] * interpolationFraction;
      outputImaginary[binIndex] = sourceImaginary[lowerSourceBin] * (1 - interpolationFraction)
                                + sourceImaginary[upperSourceBin] * interpolationFraction;
    }

  } else if (mode === 'compress') {
    // Scale the frequency axis linearly.
    // compressionRatio < 1: compress toward 0 Hz (silence above compressed band).
    // compressionRatio > 1: stretch (upper source content is discarded).
    const compressionRatio = parameters.compressionRatio;

    for (let binIndex = 0; binIndex < numberOfPositiveBins; binIndex++) {
      const sourceBinPosition = binIndex / compressionRatio;
      if (sourceBinPosition < 0 || sourceBinPosition > halfFrameSize) continue;

      const lowerSourceBin = Math.floor(sourceBinPosition);
      const upperSourceBin = Math.min(lowerSourceBin + 1, halfFrameSize);
      const interpolationFraction = sourceBinPosition - lowerSourceBin;

      outputReal[binIndex] = sourceReal[lowerSourceBin] * (1 - interpolationFraction)
                           + sourceReal[upperSourceBin] * interpolationFraction;
      outputImaginary[binIndex] = sourceImaginary[lowerSourceBin] * (1 - interpolationFraction)
                                + sourceImaginary[upperSourceBin] * interpolationFraction;
    }

  } else if (mode === 'shift') {
    // Shift all bins by a fixed integer offset, wrapping circularly.
    const shiftOffsetInBins = Math.round(parameters.shiftOffsetInBins);

    for (let binIndex = 0; binIndex < numberOfPositiveBins; binIndex++) {
      const destinationBinIndex =
        ((binIndex + shiftOffsetInBins) % numberOfPositiveBins + numberOfPositiveBins)
        % numberOfPositiveBins;
      outputReal[destinationBinIndex]      += sourceReal[binIndex];
      outputImaginary[destinationBinIndex] += sourceImaginary[binIndex];
    }
  }

  return { rearrangedReal: outputReal, rearrangedImaginary: outputImaginary };
}

export const MODE_HINTS = {
  flip:     'Reverses the spectrum up to a chosen ceiling frequency — DC becomes that ceiling and vice versa. Content above the ceiling is zeroed out.',
  mirror:   'Reflects all bins around the chosen frequency. Bins on one side swap with bins equidistant on the other, folding at boundaries.',
  fold:     'Spectrum above the fold frequency bounces back down, piling energy on top of the lower spectrum.',
  power:    'Warps the frequency axis with a power curve. Exponent < 1 squashes high frequencies toward low; > 1 does the opposite.',
  compress: 'Scales the frequency axis linearly. Ratio < 1 compresses spectrum toward 0 Hz; ratio > 1 stretches it (clips high content).',
  shift:    'Shifts all bins by a fixed number of positions, wrapping circularly — integer-resolution ring modulation.',
};

export const MODE_ACTIVE_PARAMS = {
  flip:     ['flipCeilingHz'],
  mirror:   ['mirrorFrequencyHz'],
  fold:     ['mirrorFrequencyHz'],
  power:    ['powerExponent'],
  compress: ['compressionRatio'],
  shift:    ['shiftOffsetInBins'],
};
