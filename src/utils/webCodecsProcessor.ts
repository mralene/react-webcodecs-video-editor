/**
 * Video processor using WebCodecs API
 */

// Interface for video processing options
export interface VideoProcessingOptions {
  text: string;
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  position?: { x: number, y: number };
}

// Default options for text overlay
const defaultOptions: Required<VideoProcessingOptions> = {
  text: '',
  textColor: 'white',
  fontSize: 48,
  fontFamily: 'Arial, sans-serif',
  position: { x: 50, y: 50 }
};

// Interface for progress tracking
export interface ProcessingProgress {
  currentFrame: number;
  totalFrames: number;
  percent: number;
}

/**
 * Process a video file and add text overlay using WebCodecs API
 */
export async function processVideoWithTextOverlay(
  videoFile: File,
  options: VideoProcessingOptions,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<Blob> {
  // Merge with default options
  const mergedOptions: Required<VideoProcessingOptions> = {
    ...defaultOptions,
    ...options,
    position: { ...defaultOptions.position, ...options.position }
  };

  // Create a video element to get video metadata
  const videoElement = document.createElement('video');
  videoElement.src = URL.createObjectURL(videoFile);
  
  // Wait for video metadata to load
  await new Promise<void>((resolve, reject) => {
    videoElement.onloadedmetadata = () => resolve();
    videoElement.onerror = () => reject(new Error('Failed to load video metadata'));
    videoElement.load();
  });

  const videoWidth = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;
  
  // Create canvas for drawing frames with text
  const canvas = document.createElement('canvas');
  canvas.width = videoWidth;
  canvas.height = videoHeight;
  const ctx = canvas.getContext('2d')!;

  // Configure text style
  ctx.font = `${mergedOptions.fontSize}px ${mergedOptions.fontFamily}`;
  ctx.fillStyle = mergedOptions.textColor;
  ctx.textBaseline = 'top';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;

  // Store encoded chunks
  const encodedChunks: EncodedVideoChunk[] = [];
  let keyFrameCount = 0;

  // Create an encoder
  const encoder = new VideoEncoder({
    output: (chunk) => {
      if (chunk.type === 'key') keyFrameCount++;
      encodedChunks.push(chunk);
    },
    error: (e) => console.error('Encoder error:', e)
  });

  // Configure the encoder
  await encoder.configure({
    codec: 'vp8',
    width: videoWidth,
    height: videoHeight,
    bitrate: 2_000_000 // 2 Mbps
  });

  // Process the video frame by frame
  const frameRate = 30;
  const frameDuration = 1000000 / frameRate; // microseconds
  
  // Get video duration in seconds
  await new Promise<void>((resolve) => {
    videoElement.addEventListener('loadeddata', () => {
      videoElement.currentTime = Number.MAX_SAFE_INTEGER;
      videoElement.addEventListener('seeked', () => {
        videoElement.currentTime = 0;
        resolve();
      }, { once: true });
    }, { once: true });
  });
  
  const videoDuration = videoElement.duration;
  const totalFrames = Math.ceil(videoDuration * frameRate);
  
  // Process each frame
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    const timestamp = frameIndex * frameDuration;
    videoElement.currentTime = timestamp / 1000000;
    
    // Report progress
    if (onProgress) {
      onProgress({
        currentFrame: frameIndex + 1,
        totalFrames,
        percent: Math.round(((frameIndex + 1) / totalFrames) * 100)
      });
    }
    
    // Wait for the frame to be ready
    await new Promise<void>(resolve => {
      const seekHandler = () => {
        videoElement.removeEventListener('seeked', seekHandler);
        resolve();
      };
      videoElement.addEventListener('seeked', seekHandler);
    });
    
    // Draw the frame to canvas
    ctx.drawImage(videoElement, 0, 0, videoWidth, videoHeight);
    
    // Add text overlay with outline for better visibility
    const text = mergedOptions.text;
    const x = mergedOptions.position.x;
    const y = mergedOptions.position.y;
    
    // Draw text stroke
    ctx.strokeText(text, x, y);
    // Draw text fill
    ctx.fillText(text, x, y);
    
    // Create a VideoFrame from the canvas
    const bitmap = await createImageBitmap(canvas);
    const frame = new VideoFrame(bitmap, {
      timestamp,
      duration: frameDuration
    });
    
    // Encode the frame
    const keyFrame = frameIndex % 150 === 0; // Key frame every 5 seconds at 30fps
    encoder.encode(frame, { keyFrame });
    
    // Clean up
    frame.close();
    bitmap.close();
  }
  
  // Flush the encoder
  await encoder.flush();
  encoder.close();
  
  // Clean up
  URL.revokeObjectURL(videoElement.src);
  
  // Create WebM container with VP8 codec
  return muxEncodedChunksToWebM(encodedChunks, {
    width: videoWidth,
    height: videoHeight,
    duration: videoDuration,
    frameRate
  });
}

// Interface for WebM muxer configuration
interface WebMMuxerConfig {
  width: number;
  height: number;
  duration: number;
  frameRate: number;
}

/**
 * Mux encoded video chunks into a WebM container
 */
async function muxEncodedChunksToWebM(
  chunks: EncodedVideoChunk[],
  config: WebMMuxerConfig
): Promise<Blob> {
  // WebM EBML header constants
  const EBML_ID = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]);
  const EBML_HEADER = new Uint8Array([
    // EBML header
    ...EBML_ID,
    // Header size (8 bytes)
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    // DocType: "webm"
    0x42, 0x82, 0x84, 'w'.charCodeAt(0), 'e'.charCodeAt(0), 'b'.charCodeAt(0), 'm'.charCodeAt(0),
    // DocTypeVersion: 2
    0x42, 0x87, 0x81, 0x02,
    // DocTypeReadVersion: 2
    0x42, 0x85, 0x81, 0x02
  ]);
  
  // WebM Segment header
  const SEGMENT_ID = new Uint8Array([0x18, 0x53, 0x80, 0x67]);
  const SEGMENT_HEADER = new Uint8Array([
    ...SEGMENT_ID,
    // Segment size (unknown size)
    0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF
  ]);
  
  // WebM Track header
  const TRACK_ID = new Uint8Array([0x16, 0x54, 0xAE, 0x6B]);
  
  // Create a simple WebM container
  const webmData = [
    EBML_HEADER,
    SEGMENT_HEADER
  ];
  
  // Add track info
  const trackInfo = createTrackInfo(config);
  webmData.push(trackInfo);
  
  // Add clusters with video data
  let currentCluster: Uint8Array[] = [];
  let currentTimecode = 0;
  const clusterInterval = 1000000; // 1 second in microseconds
  
  for (const chunk of chunks) {
    const chunkTime = chunk.timestamp;
    
    // Start a new cluster if needed
    if (currentCluster.length === 0 || chunkTime - currentTimecode >= clusterInterval) {
      if (currentCluster.length > 0) {
        // Finalize the current cluster and add it to webmData
        webmData.push(createCluster(currentCluster, currentTimecode));
      }
      
      // Start a new cluster
      currentCluster = [];
      currentTimecode = chunkTime;
    }
    
    // Add the chunk to the current cluster
    const buffer = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buffer);
    currentCluster.push(buffer);
  }
  
  // Add the final cluster if not empty
  if (currentCluster.length > 0) {
    webmData.push(createCluster(currentCluster, currentTimecode));
  }
  
  // Concatenate all parts
  const totalSize = webmData.reduce((size, part) => size + part.byteLength, 0);
  const result = new Uint8Array(totalSize);
  
  let offset = 0;
  for (const part of webmData) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  
  return new Blob([result], { type: 'video/webm' });
}

/**
 * Create track info for WebM container
 */
function createTrackInfo(config: WebMMuxerConfig): Uint8Array {
  // Simplified track info
  const trackData = new Uint8Array([
    // TrackEntry
    0xAE,
    // TrackEntry size (unknown)
    0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    // TrackNumber: 1
    0xD7, 0x81, 0x01,
    // TrackUID: 1
    0x73, 0xC5, 0x81, 0x01,
    // TrackType: 1 (video)
    0x83, 0x81, 0x01,
    // CodecID: "V_VP8"
    0x86, 0x85, 'V'.charCodeAt(0), '_'.charCodeAt(0), 'V'.charCodeAt(0), 'P'.charCodeAt(0), '8'.charCodeAt(0),
    // Video info
    0xE0,
    // Video info size
    0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    // PixelWidth
    0xB0, 0x82, (config.width >> 8) & 0xFF, config.width & 0xFF,
    // PixelHeight
    0xBA, 0x82, (config.height >> 8) & 0xFF, config.height & 0xFF
  ]);
  
  return trackData;
}

/**
 * Create a cluster with video chunks
 */
function createCluster(chunks: Uint8Array[], timecode: number): Uint8Array {
  // Simplified cluster
  const clusterHeader = new Uint8Array([
    // Cluster ID
    0x1F, 0x43, 0xB6, 0x75,
    // Cluster size (unknown)
    0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    // Timecode
    0xE7, 0x88, 
    // Timecode value (milliseconds, 8 bytes)
    (timecode >> 24) & 0xFF, 
    (timecode >> 16) & 0xFF,
    (timecode >> 8) & 0xFF,
    timecode & 0xFF,
    0x00, 0x00, 0x00, 0x00
  ]);
  
  // Calculate total size
  const totalSize = clusterHeader.byteLength + 
    chunks.reduce((size, chunk) => size + chunk.byteLength + 4, 0); // 4 bytes for SimpleBlock header
  
  const result = new Uint8Array(totalSize);
  result.set(clusterHeader, 0);
  
  let offset = clusterHeader.byteLength;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // SimpleBlock header
    result[offset++] = 0xA3; // SimpleBlock ID
    result[offset++] = 0x01; // Size byte 1
    result[offset++] = chunk.byteLength & 0xFF; // Size byte 2
    result[offset++] = 0x81; // Track number (1) with bit 7 set
    
    // Copy chunk data
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  
  return result;
}