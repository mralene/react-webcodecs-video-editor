// Web Worker for video processing
console.log("Worker initialized");
import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, 
  EncodedPacket, Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';

// Handle messages from the main thread
self.onmessage = async function(e) {
  const { type, file } = e.data;
  
  try {
    switch (type) {
      case 'process':
        // Process the video with the provided file
        console.log('Worker processing video', file ? file.name : 'default');
        await processVideo(file);
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
async function processVideo(file: File | null) {
  
  // Report progress to main thread
  self.postMessage({ type: 'progress', progress: 5 });
  
  try {
        // ------------------------------------------------------------
        // DEMUX (mediabunny Input)
        // ------------------------------------------------------------
        console.log('DEMUX: Video loaded');
  
        //const response = await fetch(`${self.location.origin}/gopro2.MP4`);
        //const videoBlob = await response.blob();
  
        // const input = new Input({
        //   source: new BlobSource(videoBlob),
        //   formats: ALL_FORMATS,
        // });
        //const fileInput = document.getElementById("videoRef");
        // Replace lines 58-61 with:
        if (!file) {
          throw new Error("No file selected");
        }
        
        const input = new Input({
          source: new BlobSource(file),
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
        console.log('Initialize Decoder');
        const BATCH_SIZE = 2;
        let frameBuffer: VideoFrame[] = [];
        let processedFrameCount = 0;
  
        // const videoDecoder = new VideoDecoder({
        //   output: (frame) => {
        //     frameBuffer.push(frame);
        //     //frame.close();
  
        //     // if X frames in buffer, encode them
        //     if (frameBuffer.length >= BATCH_SIZE && encoderReady) {

        //       for (const frame of frameBuffer) {
        //         encoder.encode(frame);
        //         frame.close();
        //         processedFrameCount++;
        //       }
        //       frameBuffer = []; // clear the buffer

        //     }
        //   },
        //   error: (e) => console.error(e)
        // });

        const videoDecoder = new VideoDecoder({
          output: (frame) => {
            try {
              // Create a scaled version using OffscreenCanvas
              const canvas = new OffscreenCanvas(targetWidth, targetHeight);
              const ctx = canvas.getContext('2d');
              
              // Draw the original frame scaled to target dimensions
              ctx.drawImage(frame, 0, 0, targetWidth, targetHeight);
              
              // Create a new VideoFrame from the canvas
              const scaledFrame = new VideoFrame(canvas, {
                timestamp: frame.timestamp,
                duration: frame.duration
              });
              
              // Close the original frame to free memory
              frame.close();
              
              // Use the scaled frame instead
              frameBuffer.push(scaledFrame);
              
              if (frameBuffer.length >= BATCH_SIZE) {
                for (const f of frameBuffer) {
                  encoder.encode(f);
                  f.close();
                  processedFrameCount++;
                }
                frameBuffer = []; // clear the buffer
              }
            } catch (e) {
              console.error("Frame processing error:", e);
              frame.close(); // Make sure to close the frame even if there's an error
            }
          },
          error: (e) => console.error("Decoder error:", e)
        });

        const videoDecoderConfig = await videoTrack.getDecoderConfig();
        if (!videoDecoderConfig) {
          throw new Error("Failed to get decoder configuration");
        }
        videoDecoder.configure(videoDecoderConfig);

        // ------------------------------------------------------------
        // ENCODE (webcodecs api)
        // ------------------------------------------------------------
        console.log('Initialize Encoder');
  
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
                  codec: 'avc1.64002A',
                  codedWidth: targetWidth, //videoTrack.codedWidth,
                  codedHeight: targetHeight, //videoTrack.codedHeight,
                }
              });
              muxerInitialized = true;
            } else {
              videoSource.add(encodedPacket);
            }
          },
          error: (e) => console.error('Encoder error:', e),
        });

        // ------------------------------------------------------------
        // MUX (mediabunny Output)
        // ------------------------------------------------------------
        console.log('Initialize Muxer');
        // Initialize muxer before encoding
        const output = new Output({
          format: new Mp4OutputFormat(),
          target: new BufferTarget(),
        });
  
        const videoSource = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(videoSource);
        await output.start();
        let muxerInitialized = false;
  
        const fps = (await videoTrack.computePacketStats()).averagePacketRate;
        const bitrate = (await videoTrack.computePacketStats()).averageBitrate;
  
        console.log('fps', fps);
        console.log('bitrate', bitrate);

        let encoderReady = false;

        const targetWidth = 1920;  // 1080p width
        const targetHeight = 1080;
  
        encoder.configure({
          codec: 'avc1.64002A', //'vp8', // or 'avc1.42E028', 'avc1.42E01E' for H.264, vp8
          width: targetWidth, //videoTrack.codedWidth,
          height: targetHeight, //videoTrack.codedHeight,
          framerate: fps,
          avc: { format: 'annexb' }
        });

        encoderReady = true;
  
        // ------------------------------------------------------------
        // DECODE (mediabunny Input)
        // ------------------------------------------------------------
        console.log('Start Decoding');
        for await (const packet of videoSink.packets()) {
          const chunk = await packet.toEncodedVideoChunk();
          videoDecoder.decode(chunk);
          //console.log('packet', packet.timestamp, packet.data);
        }
        await videoDecoder.flush();

        //check if there are any frames left in the buffer
        if (frameBuffer.length > 0) {
          for (const frame of frameBuffer) {
            encoder.encode(frame);
            frame.close();
            processedFrameCount++;
          }
          frameBuffer = []; // clear the buffer
        }

        console.log(`Decoding finished. Decoded ${processedFrameCount} frames.`);
  
        // HERE YOU CAN EDIT
  
        await encoder.flush();
        console.log('Encoding finished.');
  
        // ------------------------------------------------------------
        // MUX (mediabunny Output)
        // ------------------------------------------------------------
        console.log('Start Muxing');
  
        // let firstChunk = true;
        // for (const chunk of encodedChunks) {
        //   // Get raw bytes
        //   const buffer = new ArrayBuffer(chunk.byteLength);
        //   chunk.copyTo(buffer);
        //   const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
  
        //   // Add packet
        //   if (firstChunk) {
        //     videoSource.add(encodedPacket, {
        //       decoderConfig: {
        //         codec: 'vp8', //'avc1.42001E',
        //         codedWidth: videoTrack.codedWidth,
        //         codedHeight: videoTrack.codedHeight,
        //       }
        //     });
        //     firstChunk = false;
        //   } else {
        //     //console.log('Added packet', encodedPacket.timestamp);
        //     //console.log('Encoded packet', encodedPacket.timestamp);
        //     videoSource.add(encodedPacket);
        //   }
        // }
         
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
// async function processVideo() {
  
//   // Report progress to main thread
//   self.postMessage({ type: 'progress', progress: 5 });
  
//   try {
//         // ------------------------------------------------------------
//         // DEMUX (mediabunny Input)
//         // ------------------------------------------------------------
//         console.log('DEMUX: Video loaded');
  
//         const response = await fetch(`${self.location.origin}/gopro.MP4`);
//         const videoBlob = await response.blob();
  
//         const input = new Input({
//           source: new BlobSource(videoBlob),
//           formats: ALL_FORMATS,
//         });
  
//         const duration = await input.computeDuration(); // maximum end timespamp across all tracks
//         const videoTrack = await input.getPrimaryVideoTrack();
//         if (!videoTrack) throw new Error('No video track found');
  
//         console.log('duration', duration);
//         console.log('codec', videoTrack.codec);
  
//         const videoSink = new EncodedPacketSink(videoTrack);
  
  
//         // ------------------------------------------------------------
//         // DECODE (webcodecs api)
//         // ------------------------------------------------------------
//         console.log('Initialize Decoder');
//         const BATCH_SIZE = 5;
//         let frameBuffer: VideoFrame[] = [];
//         let processedFrameCount = 0;
  
//         const videoDecoder = new VideoDecoder({
//           output: (frame) => {
//             frameBuffer.push(frame.clone());
//             frame.close();
  
//             // if X frames in buffer, encode them
//             if (frameBuffer.length >= BATCH_SIZE) {

//               for (const frame of frameBuffer) {
//                 console.log('Encoding frame', frame.timestamp);
//                 encoder.encode(frame);
//                 console.log('Done encoding frame', frame.timestamp);
//                 frame.close();
//                 processedFrameCount++;
//               }
//               frameBuffer = []; // clear the buffer

//             }
//           },
//           error: (e) => console.error("hello"+ e)
//         });

//         const videoDecoderConfig = await videoTrack.getDecoderConfig();
//         if (!videoDecoderConfig) {
//           throw new Error("Failed to get decoder configuration");
//         } else {
//           console.log('Decoder configuration', videoDecoderConfig);
//         }
//         videoDecoder.configure(videoDecoderConfig);

//         // ------------------------------------------------------------
//         // ENCODE (webcodecs api)
//         // ------------------------------------------------------------
//         console.log('Initialize Encoder');
  
//         const encoder = new VideoEncoder({
//           output: (chunk) => {
//             // Process the chunk immediately instead of storing in array
//             const buffer = new ArrayBuffer(chunk.byteLength);
//             chunk.copyTo(buffer);
//             const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
  
//             // Add to the muxer directly
//             if (!muxerInitialized) {
//               videoSource.add(encodedPacket, {
//                 decoderConfig: videoDecoderConfig,
//               });
//               muxerInitialized = true;
//             } else {
//               videoSource.add(encodedPacket);
//             }
//           },
//           error: (e) => console.error('Encoder error:', e),
//         });

//         const fps = (await videoTrack.computePacketStats()).averagePacketRate;

//         const videoEncoderConfig = await VideoEncoder.isConfigSupported({
//           codec: 'vp8',
//           width: videoTrack.codedWidth,
//           height: videoTrack.codedHeight,
//           //framerate: fps,
//         });

//         if (videoEncoderConfig.supported) {
//           console.log('Encoder configuration supported');


//           encoder.configure(videoEncoderConfig.config!);
//         }

//         // ------------------------------------------------------------
//         // MUX (mediabunny Output)
//         // ------------------------------------------------------------
//         console.log('Initialize Muxer');
//         // Initialize muxer before encoding
//         const output = new Output({
//           format: new Mp4OutputFormat(),
//           target: new BufferTarget(),
//         });
  
//         const videoSource = new EncodedVideoPacketSource('vp8'); //new EncodedVideoPacketSource('vp8');
//         output.addVideoTrack(videoSource);
//         await output.start();
//         let muxerInitialized = false;
  
        
//         const bitrate = (await videoTrack.computePacketStats()).averageBitrate;
  
//         console.log('fps', fps);
//         console.log('bitrate', bitrate);
  
//         encoder.configure({
//           codec: 'vp8', // or 'avc1.42E028', 'avc1.42E01E' for H.264, vp8
//           width: videoTrack.codedWidth,
//           height: videoTrack.codedHeight,
//           framerate: fps,
//         });
  
//         // ------------------------------------------------------------
//         // DECODE (mediabunny Input)
//         // ------------------------------------------------------------
//         console.log('Start Decoding');
//         for await (const packet of videoSink.packets()) {
//           const chunk = await packet.toEncodedVideoChunk();
//           videoDecoder.decode(chunk);
//           //console.log('packet', packet.timestamp, packet.data);
//         }
//         await videoDecoder.flush();

//         //check if there are any frames left in the buffer
//         if (frameBuffer.length > 0) {
//           for (const frame of frameBuffer) {
//             encoder.encode(frame);
//             frame.close();
//             processedFrameCount++;
//           }
//           frameBuffer = []; // clear the buffer
//         }

//         console.log(`Decoding finished. Decoded ${processedFrameCount} frames.`);
  
//         // HERE YOU CAN EDIT
  
//         //await encoder.flush();
//         console.log('Encoding finished.');
  
//         // ------------------------------------------------------------
//         // MUX (mediabunny Output)
//         // ------------------------------------------------------------
//         console.log('Start Muxing');
         
//         await output.finalize();
//         console.log('Muxing finished');
  
//         const buffer = output.target.buffer;
//         if (!buffer) throw new Error('Buffer not found');
//         const blob = new Blob([buffer], { type: 'video/mp4' });
  
//         console.log('Output video created successfully');

//         self.postMessage({
//           type: 'complete',
//           result: 'Processing complete',
//           blob: blob // Send the blob back to the main thread
//         }); // Transfer the blob to avoid copying
  
  
//       } catch (error) {
//         console.error('Error:', error);

//       }
  
//   // Example of sending back results
//   self.postMessage({ 
//     type: 'complete', 
//     result: 'Processing complete' 
//   });
// }

// async function processVideoMemoryEfficient() {
//   self.postMessage({ type: 'progress', progress: 5 });

//   try {
//     // ------------------------------------------------------------
//     // DEMUX (mediabunny Input)
//     // ------------------------------------------------------------
//     console.log('DEMUX: Video loaded');

//     const response = await fetch(`${self.location.origin}/gopro2.MP4`);
//     const videoBlob = await response.blob();

//     const input = new Input({
//       source: new BlobSource(videoBlob),
//       formats: ALL_FORMATS,
//     });

//     const duration = await input.computeDuration();
//     const videoTrack = await input.getPrimaryVideoTrack();
//     if (!videoTrack) throw new Error('No video track found');

//     console.log('duration', duration);
//     console.log('codec', videoTrack.codec);

//     const videoSink = new EncodedPacketSink(videoTrack);

//     // ------------------------------------------------------------
//     // MUX (mediabunny Output)
//     // ------------------------------------------------------------
//     console.log('Initialize Muxer');
//     const output = new Output({
//       format: new Mp4OutputFormat(),
//       target: new BufferTarget(),
//     });

//     const videoSource = new EncodedVideoPacketSource('vp8'); // output codec
//     output.addVideoTrack(videoSource);
//     await output.start();
//     let muxerInitialized = false;

//     const fps = (await videoTrack.computePacketStats()).averagePacketRate;

//     console.log('fps', fps);

//     // ------------------------------------------------------------
//     // ENCODE (webcodecs api)
//     // ------------------------------------------------------------
//     console.log('Initialize Encoder');
//     const encoder = new VideoEncoder({
//       output: (chunk) => {
//         const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);

//         // Add to muxer
//         if (!muxerInitialized) {
//           videoSource.add(encodedPacket, {
//             decoderConfig: {
//               codec: 'vp8',
//               codedWidth: videoTrack.codedWidth,
//               codedHeight: videoTrack.codedHeight,
//             },
//           });
//           muxerInitialized = true;
//         } else {
//           videoSource.add(encodedPacket);
//         }
//       },
//       error: (e) => console.error('Encoder error:', e),
//     });

//     encoder.configure({
//       codec: 'vp8', // change if needed
//       width: videoTrack.codedWidth,
//       height: videoTrack.codedHeight,
//       framerate: fps,
//     });

//     // ------------------------------------------------------------
//     // DECODE (webcodecs api)
//     // ------------------------------------------------------------
//     console.log('Initialize Decoder');
//     const videoDecoder = new VideoDecoder({
//       output: (frame) => {
//         // Immediately encode and release frame
//         encoder.encode(frame);
//         frame.close();
//       },
//       error: (e) => console.error('Decoder error:', e),
//     });

//     const videoDecoderConfig = await videoTrack.getDecoderConfig();
//     if (!videoDecoderConfig) throw new Error('Failed to get decoder config');
//     videoDecoder.configure(videoDecoderConfig);

//     // ------------------------------------------------------------
//     // DECODE LOOP
//     // ------------------------------------------------------------
//     console.log('Start Decoding');

//     for await (const packet of videoSink.packets()) {
//       const chunk = await packet.toEncodedVideoChunk();
//       videoDecoder.decode(chunk);
//     }

//     // flush decoder and encoder
//     await videoDecoder.flush();
//     await encoder.flush();

//     console.log('Encoding finished.');

//     // ------------------------------------------------------------
//     // FINALIZE MUX
//     // ------------------------------------------------------------
//     await output.finalize();
//     console.log('Muxing finished');

//     const buffer = output.target.buffer;
//     if (!buffer) throw new Error('Buffer not found');

//     const blob = new Blob([buffer], { type: 'video/mp4' });

//     console.log('Output video created successfully');

//     self.postMessage({
//       type: 'complete',
//       result: 'Processing complete',
//       blob: blob,
//     });
//   } catch (error) {
//     console.error('Error:', error);
//     self.postMessage({ type: 'error', error: error.message });
//   }
// }
// async function processVideoMemoryOptimized() {
//   self.postMessage({ type: 'progress', progress: 5 });

//   try {
//     // ------------------------------------------------------------
//     // DEMUX (mediabunny Input)
//     // ------------------------------------------------------------
//     console.log('DEMUX: Video loaded');

//     const response = await fetch(`${self.location.origin}/gopro.MP4`);
//     const videoBlob = await response.blob();

//     const input = new Input({
//       source: new BlobSource(videoBlob),
//       formats: ALL_FORMATS,
//     });

//     const duration = await input.computeDuration();
//     const videoTrack = await input.getPrimaryVideoTrack();
//     if (!videoTrack) throw new Error('No video track found');

//     console.log('duration', duration);
//     console.log('codec', videoTrack.codec);

//     const videoSink = new EncodedPacketSink(videoTrack);

//     // ------------------------------------------------------------
//     // MUX (mediabunny Output)
//     // ------------------------------------------------------------
//     console.log('Initialize Muxer');
//     const output = new Output({
//       format: new Mp4OutputFormat(),
//       target: new BufferTarget(),
//     });

//     const videoSource = new EncodedVideoPacketSource('vp8'); // output codec
//     output.addVideoTrack(videoSource);
//     await output.start();
//     let muxerInitialized = false;

//     const fps = (await videoTrack.computePacketStats()).averagePacketRate;
//     console.log('fps', fps);

//     // ------------------------------------------------------------
//     // ENCODE (webcodecs api)
//     // ------------------------------------------------------------
//     console.log('Initialize Encoder');
//     const encoder = new VideoEncoder({
//       output: (chunk) => {
//         // Convert WebCodecs chunk to mediabunny EncodedPacket
//         const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
    
//         if (!muxerInitialized) {
//             videoSource.add(encodedPacket, {
//                 decoderConfig: {
//                     codec: 'vp8', // output codec
//                     codedWidth: videoTrack.codedWidth,
//                     codedHeight: videoTrack.codedHeight,
//                 }
//             });
//             muxerInitialized = true;
//         } else {
//             videoSource.add(encodedPacket);
//         }
//     },
//       error: (e) => console.error('Encoder error:', e),
//     });

//     encoder.configure({
//       codec: 'vp8',
//       width: videoTrack.codedWidth,
//       height: videoTrack.codedHeight,
//       framerate: fps,
//     });

//     // ------------------------------------------------------------
//     // DECODE (webcodecs api)
//     // ------------------------------------------------------------
//     console.log('Initialize Decoder');
//     const videoDecoder = new VideoDecoder({
//       output: (frame) => {
//         // Optional: downscale frame to reduce memory
//         // Comment out if full resolution is required
//         const scaledFrame = new VideoFrame(frame, {
//           //resizeWidth: , // or 1920 for 1080p
//           displayWidth: 1920, // or 1080 for 1080p
//           displayHeight: 1080, // or 1080 for 1080p
//           visibleRect: {x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight}
//         });
//         frame.close();
//         encoder.encode(scaledFrame);
//         scaledFrame.close();
//       },
//       error: (e) => console.error('Decoder error:', e),
//     });

//     const videoDecoderConfig = await videoTrack.getDecoderConfig();
//     if (!videoDecoderConfig) throw new Error('Failed to get decoder config');
//     videoDecoder.configure(videoDecoderConfig);
//     console.log('Decoder configuration', videoDecoderConfig);

//     // ------------------------------------------------------------
//     // DECODE LOOP WITH QUEUE LIMIT
//     // ------------------------------------------------------------
//     console.log('Start Decoding');

//     for await (const packet of videoSink.packets()) {
//       // Wait if decoder queue is too long
//       while (videoDecoder.decodeQueueSize > 3) {
//         await new Promise((r) => setTimeout(r, 5)); // small delay
//       }

//       const chunk = await packet.toEncodedVideoChunk();
//       videoDecoder.decode(chunk);
//     }

//     // ------------------------------------------------------------
//     // FLUSH DECODER AND ENCODER
//     // ------------------------------------------------------------
//     await videoDecoder.flush();
//     await encoder.flush();

//     console.log('Encoding finished.');

//     // ------------------------------------------------------------
//     // FINALIZE MUX
//     // ------------------------------------------------------------
//     await output.finalize();
//     console.log('Muxing finished');

//     const buffer = output.target.buffer;
//     if (!buffer) throw new Error('Buffer not found');

//     const blob = new Blob([buffer], { type: 'video/mp4' });

//     console.log('Output video created successfully');

//     self.postMessage({
//       type: 'complete',
//       result: 'Processing complete',
//       blob: blob,
//     });
//   } catch (error) {
//     console.error('Error:', error);
//     self.postMessage({ type: 'error', error: error.message });
//   }
// }

