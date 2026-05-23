/**
 * Encode an AudioBuffer as a 16-bit PCM WAV Blob.
 *
 * @param {AudioBuffer} audioBuffer
 * @returns {Blob}
 */
export function encodeAudioBufferToWav(audioBuffer) {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate       = audioBuffer.sampleRate;
  const totalFrameCount  = audioBuffer.length;
  const bitsPerSample    = 16;
  const bytesPerSample   = bitsPerSample / 8;
  const blockAlignBytes  = numberOfChannels * bytesPerSample;
  const byteRatePerSecond = sampleRate * blockAlignBytes;
  const pcmDataByteCount = totalFrameCount * blockAlignBytes;
  const totalByteCount   = 44 + pcmDataByteCount; // 44-byte WAV header

  const wavByteBuffer = new ArrayBuffer(totalByteCount);
  const dataView      = new DataView(wavByteBuffer);

  const writeAsciiString = (byteOffset, text) => {
    for (let characterIndex = 0; characterIndex < text.length; characterIndex++) {
      dataView.setUint8(byteOffset + characterIndex, text.charCodeAt(characterIndex));
    }
  };

  // RIFF chunk
  writeAsciiString(0,  'RIFF');
  dataView.setUint32(4,  36 + pcmDataByteCount, true);
  writeAsciiString(8,  'WAVE');
  // fmt sub-chunk
  writeAsciiString(12, 'fmt ');
  dataView.setUint32(16, 16,               true); // sub-chunk size
  dataView.setUint16(20, 1,                true); // PCM = 1
  dataView.setUint16(22, numberOfChannels, true);
  dataView.setUint32(24, sampleRate,       true);
  dataView.setUint32(28, byteRatePerSecond, true);
  dataView.setUint16(32, blockAlignBytes,  true);
  dataView.setUint16(34, bitsPerSample,    true);
  // data sub-chunk
  writeAsciiString(36, 'data');
  dataView.setUint32(40, pcmDataByteCount, true);

  // Interleaved PCM samples
  let writeByteOffset = 44;
  for (let frameIndex = 0; frameIndex < totalFrameCount; frameIndex++) {
    for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex++) {
      const clampedSampleValue = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channelIndex)[frameIndex]));
      const integerSampleValue = clampedSampleValue < 0
        ? clampedSampleValue * 0x8000
        : clampedSampleValue * 0x7FFF;
      dataView.setInt16(writeByteOffset, integerSampleValue, true);
      writeByteOffset += 2;
    }
  }

  return new Blob([wavByteBuffer], { type: 'audio/wav' });
}
