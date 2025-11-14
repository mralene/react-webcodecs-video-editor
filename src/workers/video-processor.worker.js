// Web Worker for video processing
console.log("Worker initialized");
import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, 
  EncodedPacket, Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';

// Handle messages from the main thread
self.onmessage = async function(e) {
  const { type } = e.data;
  
  try {
    switch (type) {
      case 'process':
        // Process the video
        console.log('Worker Processing video');
        await processVideo();
        break;
      
      default:
        console.warn('Unknown message type:', type);
    }
  } catch (error: unknown) {
    console.error('Worker error:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

// Report that the worker is ready
self.postMessage({ type: 'ready' });

// Function to process the video
async function processVideo() {
  
  // Report progress to main thread
  self.postMessage({ type: 'progress', progress: 5 });
  
  try {
        // ------------------------------------------------------------
        // DEMUX (mediabunny Input)
        // ------------------------------------------------------------
        console.log('DEMUX: Video loaded');
  
        const response = await fetch(`${self.location.origin}/gopro.MP4`);
        const videoBlob = await response.blob();
  
        const input = new Input({
          source: new BlobSource(videoBlob),
          formats: ALL_FORMATS,
        });
  
        const duration = await input.computeDuration(); // maximum end timespamp across all tracks
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) throw new Error('No video track found');
  
        console.log('duration', duration);
        console.log('codec', videoTrack.codec);
  
        const videoSink = new EncodedPacketSink(videoTrack);
  
  
        // ------------------------------------------------------------
        // DECODE (webcodecs api)
        // ------------------------------------------------------------
        console.log('Start Decoding');
        const BATCH_SIZE = 10;
        let frameBuffer: VideoFrame[] = [];
        let processedFrameCount = 0;
  
        //const frames: VideoFrame[] = [];
        const videoDecoder = new VideoDecoder({
          output: (frame) => {
            //console.log('Got frame at timestamp', frame.timestamp);
            //ctx.drawImage(frame, 0, 0, videoTrack.codedWidth, videoTrack.codedHeight);
            frameBuffer.push(frame.clone());
            frame.close();
  
            if (frameBuffer.length >= BATCH_SIZE) {
              processFrameBatch();
            }
          },
          error: (e) => console.error(e)
        });
        console.log('Start Encoding');
  
        const encodedChunks: EncodedVideoChunk[] = [];
        const encoder = new VideoEncoder({
          output: (chunk) => {
            // Process the chunk immediately instead of storing in array
            const buffer = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(buffer);
            const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
  
            // Add to the muxer directly
            if (!muxerInitialized) {
              videoSource.add(encodedPacket, {
                decoderConfig: {
                  codec: 'vp8',
                  codedWidth: videoTrack.codedWidth,
                  codedHeight: videoTrack.codedHeight,
                }
              });
              muxerInitialized = true;
            } else {
              videoSource.add(encodedPacket);
            }
          },
          error: (e) => console.error('Encoder error:', e),
        });
  
        // Initialize muxer before encoding
        const output = new Output({
          format: new Mp4OutputFormat(),
          target: new BufferTarget(),
        });
  
        const videoSource = new EncodedVideoPacketSource('vp8');
        output.addVideoTrack(videoSource);
        await output.start();
        let muxerInitialized = false;
  
        const fps = (await videoTrack.computePacketStats()).averagePacketRate;
        const bitrate = (await videoTrack.computePacketStats()).averageBitrate;
  
        console.log('fps', fps);
        console.log('bitrate', bitrate);
  
        encoder.configure({
          codec: 'vp8', // or 'avc1.42E028', 'avc1.42E01E' for H.264, vp8
          width: videoTrack.codedWidth,
          height: videoTrack.codedHeight,
          framerate: fps,
        });
  
        async function processFrameBatch() {
          const currentBatch = [...frameBuffer];
          frameBuffer = [];
  
          //console.log('Processing frame batch', currentBatch.length);
          for (const frame of currentBatch) {
            encoder.encode(frame);
            frame.close();
            processedFrameCount++;
          }
        }
  
        const videoDecoderConfig = await videoTrack.getDecoderConfig();
        if (!videoDecoderConfig) {
          throw new Error("Failed to get decoder configuration");
        }
        videoDecoder.configure(videoDecoderConfig);
  
        
        for await (const packet of videoSink.packets()) {
          const chunk = await packet.toEncodedVideoChunk();
          videoDecoder.decode(chunk);
          //console.log('packet', packet.timestamp, packet.data);
        }
        await videoDecoder.flush();
        if (frameBuffer.length > 0) {
          processFrameBatch();
        }

        console.log(`Decoding finished. Decoded ${processedFrameCount} frames.`);
        //console.log(`Decoding finished. Decoded ${frames.length} frames.`);
  
        // HERE YOU CAN EDIT
  
        // ------------------------------------------------------------
        // ENCODE (webcodecs api)
        // ------------------------------------------------------------
  
  
        // for (const frame of frames) {
        //   encoder.encode(frame);
        //   frame.close(); // free memory now that we encoded
        // }
  
        await encoder.flush();
        console.log('Encoding finished.');
  
        // ------------------------------------------------------------
        // MUX (mediabunny Output)
        // ------------------------------------------------------------
        console.log('Start Muxing');
  
        // const output = new Output({
        //   format: new Mp4OutputFormat(),
        //   target: new BufferTarget(),
        // });
  
        //const videoSource = new EncodedVideoPacketSource('vp8');
        //output.addVideoTrack(videoSource);
        //await output.start();
  
        let firstChunk = true;
        for (const chunk of encodedChunks) {
          // Get raw bytes
          const buffer = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buffer);
          const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
  
          // Add packet
          if (firstChunk) {
            videoSource.add(encodedPacket, {
              decoderConfig: {
                codec: 'vp8', //'avc1.42001E',
                codedWidth: videoTrack.codedWidth,
                codedHeight: videoTrack.codedHeight,
              }
            });
            firstChunk = false;
          } else {
            //console.log('Added packet', encodedPacket.timestamp);
            //console.log('Encoded packet', encodedPacket.timestamp);
            videoSource.add(encodedPacket);
          }
        }
        await output.finalize();
        console.log('Muxing finished');
  
        const buffer = output.target.buffer;
        if (!buffer) throw new Error('Buffer not found');
        const blob = new Blob([buffer], { type: 'video/mp4' });
  
        console.log('Output video created successfully');
  
        // setOutputBlob(blob);
        // setOutputUrl(URL.createObjectURL(blob));
        // setProcessing(false);
        // setProgress(100);
        // With this:
        self.postMessage({
          type: 'complete',
          result: 'Processing complete',
          blob: blob // Send the blob back to the main thread
        }); // Transfer the blob to avoid copying
  
  
      } catch (error) {
        console.error('Error:', error);

      }
  
  // Example of sending back results
  self.postMessage({ 
    type: 'complete', 
    result: 'Processing complete' 
  });
}