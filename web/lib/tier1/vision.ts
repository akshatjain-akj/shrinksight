/**
 * Loads MediaPipe Tasks from the Google CDN. Inference stays on the page thread:
 * a WASM worker does not survive the static Firebase export reliably, and the
 * scheduler below still runs pose / face / objects on the architecture's frame ratios.
 */

import type { FaceDetector, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const POSE = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const FACE = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const OBJECTS = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

export interface VisionModels {
  pose: PoseLandmarker;
  face: FaceDetector;
  objects: ObjectDetector;
  close: () => void;
}

async function withDelegate<T>(create: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
  try {
    return await create("GPU");
  } catch {
    return await create("CPU");
  }
}

export async function loadVision(): Promise<VisionModels> {
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM);
  const base = { modelAssetPath: "" };
  const pose = await withDelegate((delegate) =>
    vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { ...base, modelAssetPath: POSE, delegate },
      runningMode: "VIDEO",
      numPoses: 3,
      // Fewer "ghost" people in cluttered aisles, and earlier re-detection when hands move fast.
      minPoseDetectionConfidence: 0.6,
      minPosePresenceConfidence: 0.6,
      minTrackingConfidence: 0.65,
    }),
  );
  const face = await withDelegate((delegate) =>
    vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { ...base, modelAssetPath: FACE, delegate },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5,
    }),
  );
  const objects = await withDelegate((delegate) =>
    vision.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { ...base, modelAssetPath: OBJECTS, delegate },
      runningMode: "VIDEO",
      scoreThreshold: 0.45,
      maxResults: 5,
    }),
  );
  return {
    pose,
    face,
    objects,
    close: () => {
      pose.close();
      face.close();
      objects.close();
    },
  };
}

