import { fft } from './fft.js';
import { rearrangeFrequencyBins } from './frequencyRearrangement.js';
import {
  buildLogWarpConfig,
  resampleLinearToLog,
  resampleLogToLinear,
} from './logFrequencyWarp.js';

const LOWEST_LOG_FREQUENCY_HZ = 20; // below this, log(f) becomes impractical

/**
 * Process a decoded AudioBuffer through the STFT rearrangement pipeline.
 *
 * For each overlapping frame:
 *   1. Apply Hann window and forward FFT
 *   2. Optionally resample to a log-frequency grid
 *   3. Rearrange frequency bins according to the chosen mode
 *   4. Optionally resample back to linear frequency
 *   5. Reconstruct Hermitian symmetry and inverse FFT
 *   6. Overlap-add with WOLA normalisation
 *
 * @param {AudioBuffer} inputBuffer
 * @param {number}      frameSize          — must be a power of 2
 * @param {number}      hopFraction        — e.g. 0.25 for 75% overlap
 * @param {string}      mode
 * @param {object}      parameters
 * @returns {AudioBuffer}
 */
export function processAudioBuffer(inputBuffer, frameSize, hopFraction, mode, parameters) {
  const sampleRate       = inputBuffer.sampleRate;
  const numberOfChannels = inputBuffer.numberOfChannels;
  const halfFrameSize    = frameSize >> 1;
  const hopSizeInSamples = Math.round(frameSize * hopFraction);

  // Hann window coefficients
  const hannWindowCoefficients = new Float32Array(frameSize);
  for (let sampleIndex = 0; sampleIndex < frameSize; sampleIndex++) {
    hannWindowCoefficients[sampleIndex] = 0.5 - 0.5 * Math.cos(2 * Math.PI * sampleIndex / frameSize);
  }

  // Per-sample normalisation weight (sum of squared Hann windows across overlapping frames)
  const windowSquaredValues = new Float32Array(frameSize);
  for (let sampleIndex = 0; sampleIndex < frameSize; sampleIndex++) {
    windowSquaredValues[sampleIndex] = hannWindowCoefficients[sampleIndex] ** 2;
  }

  // Log-frequency warp config (built once per call, shared across channels and frames)
  const useLogFrequencyScale = parameters.useLogFrequencyScale;
  const logWarpConfig = useLogFrequencyScale
    ? buildLogWarpConfig(
        halfFrameSize + 1,
        halfFrameSize,
        LOWEST_LOG_FREQUENCY_HZ,
        sampleRate / 2,
        sampleRate,
      )
    : null;

  const processOneChannel = (rawSamples) => {
    const totalSampleCount      = rawSamples.length;
    const overlapAddAccumulator = new Float64Array(totalSampleCount + frameSize);
    const normalisationWeights  = new Float64Array(totalSampleCount + frameSize);

    const frameRealParts      = new Float64Array(frameSize);
    const frameImaginaryParts = new Float64Array(frameSize);

    for (let frameStartSample = 0; frameStartSample < totalSampleCount; frameStartSample += hopSizeInSamples) {
      // Fill frame with windowed input
      for (let offsetWithinFrame = 0; offsetWithinFrame < frameSize; offsetWithinFrame++) {
        const absoluteSampleIndex = frameStartSample + offsetWithinFrame;
        frameRealParts[offsetWithinFrame] = absoluteSampleIndex < totalSampleCount
          ? rawSamples[absoluteSampleIndex] * hannWindowCoefficients[offsetWithinFrame]
          : 0;
        frameImaginaryParts[offsetWithinFrame] = 0;
      }

      fft(frameRealParts, frameImaginaryParts, false);

      // Extract positive-frequency bins [0 .. halfFrameSize]
      const numberOfPositiveBins      = halfFrameSize + 1;
      const positiveFrequencyReal      = new Float64Array(numberOfPositiveBins);
      const positiveFrequencyImaginary = new Float64Array(numberOfPositiveBins);
      for (let binIndex = 0; binIndex <= halfFrameSize; binIndex++) {
        positiveFrequencyReal[binIndex]      = frameRealParts[binIndex];
        positiveFrequencyImaginary[binIndex] = frameImaginaryParts[binIndex];
      }

      let rearrangementInputReal      = positiveFrequencyReal;
      let rearrangementInputImaginary = positiveFrequencyImaginary;
      let rearrangementHalfSize       = halfFrameSize;

      // Optionally warp to log-frequency space before rearranging
      if (useLogFrequencyScale) {
        const { logReal, logImaginary } = resampleLinearToLog(
          positiveFrequencyReal,
          positiveFrequencyImaginary,
          logWarpConfig,
        );
        rearrangementInputReal      = logReal;
        rearrangementInputImaginary = logImaginary;
        rearrangementHalfSize       = (logReal.length - 1); // treat log slots as "bins"
      }

      const { rearrangedReal, rearrangedImaginary } = rearrangeFrequencyBins(
        rearrangementInputReal,
        rearrangementInputImaginary,
        mode,
        parameters,
        sampleRate,
        rearrangementHalfSize,
      );

      let outputPositiveReal      = rearrangedReal;
      let outputPositiveImaginary = rearrangedImaginary;

      // Warp back to linear-frequency space if we warped in
      if (useLogFrequencyScale) {
        const { linearReal, linearImaginary } = resampleLogToLinear(
          rearrangedReal,
          rearrangedImaginary,
          logWarpConfig,
        );
        outputPositiveReal      = linearReal;
        outputPositiveImaginary = linearImaginary;
      }

      // Reconstruct full Hermitian-symmetric spectrum for real IFFT output
      for (let binIndex = 0; binIndex <= halfFrameSize; binIndex++) {
        frameRealParts[binIndex]      = outputPositiveReal[binIndex];
        frameImaginaryParts[binIndex] = outputPositiveImaginary[binIndex];
      }
      for (let binIndex = 1; binIndex < halfFrameSize; binIndex++) {
        frameRealParts[frameSize - binIndex]       =  outputPositiveReal[binIndex];
        frameImaginaryParts[frameSize - binIndex]  = -outputPositiveImaginary[binIndex];
      }

      fft(frameRealParts, frameImaginaryParts, true);

      // Weighted overlap-add (synthesis window = analysis window)
      for (let offsetWithinFrame = 0; offsetWithinFrame < frameSize; offsetWithinFrame++) {
        const absoluteSampleIndex = frameStartSample + offsetWithinFrame;
        overlapAddAccumulator[absoluteSampleIndex] +=
          frameRealParts[offsetWithinFrame] * hannWindowCoefficients[offsetWithinFrame];
        normalisationWeights[absoluteSampleIndex] +=
          windowSquaredValues[offsetWithinFrame];
      }
    }

    // Normalise by WOLA weight and trim to original length
    const normalisedOutput = new Float32Array(totalSampleCount);
    for (let sampleIndex = 0; sampleIndex < totalSampleCount; sampleIndex++) {
      normalisedOutput[sampleIndex] = normalisationWeights[sampleIndex] > 1e-8
        ? overlapAddAccumulator[sampleIndex] / normalisationWeights[sampleIndex]
        : 0;
    }
    return normalisedOutput;
  };

  const offlineContext = new OfflineAudioContext(numberOfChannels, inputBuffer.length, sampleRate);
  const outputBuffer   = offlineContext.createBuffer(numberOfChannels, inputBuffer.length, sampleRate);

  for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex++) {
    const processedSamples = processOneChannel(inputBuffer.getChannelData(channelIndex));
    outputBuffer.copyToChannel(processedSamples, channelIndex);
  }

  return outputBuffer;
}
