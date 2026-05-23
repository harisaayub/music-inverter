/**
 * In-place radix-2 Cooley-Tukey FFT.
 * Operates on parallel real and imaginary typed arrays of length 2^n.
 *
 * @param {Float64Array} realParts
 * @param {Float64Array} imaginaryParts
 * @param {boolean} isInverse
 */
export function fft(realParts, imaginaryParts, isInverse) {
  const transformSize = realParts.length;

  // Bit-reversal permutation
  for (let forwardIndex = 1, reversedIndex = 0; forwardIndex < transformSize; forwardIndex++) {
    let bitPosition = transformSize >> 1;
    for (; reversedIndex & bitPosition; bitPosition >>= 1) reversedIndex ^= bitPosition;
    reversedIndex ^= bitPosition;

    if (forwardIndex < reversedIndex) {
      let swapReal = realParts[forwardIndex];
      realParts[forwardIndex] = realParts[reversedIndex];
      realParts[reversedIndex] = swapReal;

      let swapImaginary = imaginaryParts[forwardIndex];
      imaginaryParts[forwardIndex] = imaginaryParts[reversedIndex];
      imaginaryParts[reversedIndex] = swapImaginary;
    }
  }

  // Butterfly stages
  for (let levelSize = 2; levelSize <= transformSize; levelSize <<= 1) {
    const twiddleAngle = 2 * Math.PI / levelSize * (isInverse ? -1 : 1);
    const twiddleBaseReal = Math.cos(twiddleAngle);
    const twiddleBaseImaginary = Math.sin(twiddleAngle);

    for (let blockStart = 0; blockStart < transformSize; blockStart += levelSize) {
      let currentTwiddleReal = 1;
      let currentTwiddleImaginary = 0;

      for (let halfLevelOffset = 0; halfLevelOffset < (levelSize >> 1); halfLevelOffset++) {
        const topIndex    = blockStart + halfLevelOffset;
        const bottomIndex = blockStart + halfLevelOffset + (levelSize >> 1);

        const topReal      = realParts[topIndex];
        const topImaginary = imaginaryParts[topIndex];

        const rotatedBottomReal      = realParts[bottomIndex] * currentTwiddleReal
                                     - imaginaryParts[bottomIndex] * currentTwiddleImaginary;
        const rotatedBottomImaginary = realParts[bottomIndex] * currentTwiddleImaginary
                                     + imaginaryParts[bottomIndex] * currentTwiddleReal;

        realParts[topIndex]      = topReal + rotatedBottomReal;
        imaginaryParts[topIndex] = topImaginary + rotatedBottomImaginary;

        realParts[bottomIndex]      = topReal - rotatedBottomReal;
        imaginaryParts[bottomIndex] = topImaginary - rotatedBottomImaginary;

        const nextTwiddleReal      = currentTwiddleReal * twiddleBaseReal
                                   - currentTwiddleImaginary * twiddleBaseImaginary;
        currentTwiddleImaginary    = currentTwiddleReal * twiddleBaseImaginary
                                   + currentTwiddleImaginary * twiddleBaseReal;
        currentTwiddleReal         = nextTwiddleReal;
      }
    }
  }

  if (isInverse) {
    for (let sampleIndex = 0; sampleIndex < transformSize; sampleIndex++) {
      realParts[sampleIndex]      /= transformSize;
      imaginaryParts[sampleIndex] /= transformSize;
    }
  }
}
