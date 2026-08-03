import os
import argparse
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict

import cv2
import numpy as np
from ultralytics import YOLO

ROOT_DIR = Path(__file__).resolve().parent
WORKSPACE_DIR = ROOT_DIR.parent
DEFAULT_COCO_MODEL = "yolo11n.pt"
if str(WORKSPACE_DIR) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_DIR))

from sort.sort import Sort
from utils.data_interpolator import DataInterpolator
from utils.data_writer import DataWriter
from utils.license_plate_processor import LicensePlateProcessor
from utils.vehicle_tracker import VehicleTracker
from utils.visualizer import Visualizer

class LicensePlateRecognition:
    def __init__(
        self,
        video_path,
        coco_model_path,
        license_plate_model_path,
        output_dir=None,
        max_frames=None,
        save_visualization=True,
    ):
        """
        Initialize the License Plate Recognition system
        
        Args:
            video_path (str): Path to the input video
            coco_model_path (str): Path to the YOLO COCO model
            license_plate_model_path (str): Path to the license plate detection model
        """
        self.video_path = video_path
        self.coco_model = YOLO(coco_model_path)
        self.license_plate_detector = YOLO(license_plate_model_path)
        self.mot_tracker = Sort()
        self.license_plate_processor = LicensePlateProcessor()
        self.vehicle_tracker = VehicleTracker()
        self.data_writer = DataWriter()
        self.data_interpolator = DataInterpolator()
        self.output_dir = Path(output_dir or ROOT_DIR / "runs" / "latest")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.raw_results_path = self.output_dir / "test.csv"
        self.interpolated_results_path = self.output_dir / "test_interpolated.csv"
        self.visualization_path = self.output_dir / "out.mp4"
        self.max_frames = max_frames
        self.save_visualization = save_visualization
        
        # Vehicle classes to track (2: car, 3: motorcycle, 5: bus, 7: truck)
        self.vehicles = [2, 3, 5, 7]
        self.results = {}

    def process_frame(self, frame, frame_nmr):
        """
        Process a single frame for license plate detection and recognition
        
        Args:
            frame: The video frame to process
            frame_nmr: Frame number for tracking
        """
        self.results[frame_nmr] = {}
        
        # Detect vehicles
        detections = self.coco_model(frame)[0]
        vehicle_detections = []
        
        for detection in detections.boxes.data.tolist():
            x1, y1, x2, y2, score, class_id = detection
            if int(class_id) in self.vehicles:
                vehicle_detections.append([x1, y1, x2, y2, score])

        # Track vehicles
        track_ids = self.mot_tracker.update(np.asarray(vehicle_detections))

        # Detect and process license plates
        license_plates = self.license_plate_detector(frame)[0]
        for license_plate in license_plates.boxes.data.tolist():
            x1, y1, x2, y2, score, class_id = license_plate

            # Assign license plate to car
            car_info = self.vehicle_tracker.get_car(license_plate, track_ids)
            if car_info is not None:
                xcar1, ycar1, xcar2, ycar2, car_id = car_info

                # Process license plate
                license_plate_crop = frame[int(y1):int(y2), int(x1):int(x2), :]
                license_plate_text, license_plate_score = self.license_plate_processor.read_license_plate(license_plate_crop)

                if license_plate_text is not None:
                    self.results[frame_nmr][car_id] = {
                        'car': {'bbox': [xcar1, ycar1, xcar2, ycar2]},
                        'license_plate': {
                            'bbox': [x1, y1, x2, y2],
                            'text': license_plate_text,
                            'bbox_score': score,
                            'text_score': license_plate_score
                        }
                    }

    def run(self):
        """
        Run the license plate recognition system on the video
        """
        cap = cv2.VideoCapture(self.video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Video source could not be opened: {self.video_path}")

        frame_nmr = -1
        ret = True

        while ret:
            frame_nmr += 1
            if self.max_frames is not None and frame_nmr >= self.max_frames:
                break
            ret, frame = cap.read()
            if ret:
                self.process_frame(frame, frame_nmr)

        cap.release()

        self.data_writer.write_results(self.results, str(self.raw_results_path))

        if self.raw_results_path.stat().st_size == 0:
            raise RuntimeError("No CSV output was produced during detection.")

        self.data_interpolator.process_file(str(self.raw_results_path), str(self.interpolated_results_path))

        if self.save_visualization:
            visualizer = Visualizer(
                self.video_path,
                results_path=str(self.interpolated_results_path),
                output_video_path=str(self.visualization_path),
            )
            visualizer.run()

        return {
            "raw_results_path": str(self.raw_results_path),
            "interpolated_results_path": str(self.interpolated_results_path),
            "visualization_path": str(self.visualization_path) if self.save_visualization else None,
            "frame_count": frame_nmr,
            "detection_count": sum(len(frame_results) for frame_results in self.results.values()),
        }

def create_app():
    from fastapi import FastAPI, File, UploadFile
    from fastapi.responses import JSONResponse

    app = FastAPI(
        title="License Plate Recognition API",
        description="API for detecting and recognizing license plates in videos",
        version="1.0.0"
    )

    @app.post("/process-video/")
    async def process_video(file: UploadFile = File(...)) -> Dict[str, Any]:
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as temp_file:
                content = await file.read()
                temp_file.write(content)
                temp_path = temp_file.name

            lpr = LicensePlateRecognition(
                video_path=temp_path,
                coco_model_path=DEFAULT_COCO_MODEL,
                license_plate_model_path=str(ROOT_DIR / 'models' / 'license_plate_detector.pt'),
            )
            run_result = lpr.run()
            os.unlink(temp_path)

            return {
                "status": "success",
                "message": "Video processed successfully",
                "results_file": run_result["interpolated_results_path"],
                "visualization_file": run_result["visualization_path"],
            }
        except Exception as e:
            return JSONResponse(
                status_code=500,
                content={"status": "error", "message": str(e)}
            )

    return app

def process_video_file(video_path: str, coco_model_path: str, license_plate_model_path: str, output_dir: str, max_frames: int | None, no_visualization: bool):
    """
    Process a video file from command line
    
    Args:
        video_path: Path to the video file
    """
    lpr = LicensePlateRecognition(
        video_path=video_path,
        coco_model_path=coco_model_path,
        license_plate_model_path=license_plate_model_path,
        output_dir=output_dir,
        max_frames=max_frames,
        save_visualization=not no_visualization,
    )
    return lpr.run()

def main():
    parser = argparse.ArgumentParser(description='License Plate Recognition System')
    parser.add_argument('--mode', choices=['api', 'cli'], default='api',
                      help='Run mode: api for FastAPI server, cli for command line processing')
    parser.add_argument('--video', type=str, help='Path to video file or RTSP URL (required for cli mode)')
    parser.add_argument('--host', type=str, default='127.0.0.1', help='Host for API server')
    parser.add_argument('--port', type=int, default=8000, help='Port for API server')
    parser.add_argument('--coco-model', type=str, default=DEFAULT_COCO_MODEL, help='Path to YOLO vehicle model')
    parser.add_argument('--plate-model', type=str, default=str(ROOT_DIR / 'models' / 'license_plate_detector.pt'), help='Path to plate detector model')
    parser.add_argument('--output-dir', type=str, default=str(ROOT_DIR / 'runs' / 'latest'), help='Folder for CSV and preview output')
    parser.add_argument('--max-frames', type=int, default=None, help='Optional frame limit for quick tests')
    parser.add_argument('--no-visualization', action='store_true', help='Skip annotated output video generation')
    
    args = parser.parse_args()
    
    if args.mode == 'api':
        import uvicorn

        app = create_app()
        uvicorn.run(app, host=args.host, port=args.port)
    elif args.mode == 'cli':
        if not args.video:
            parser.error("--video argument is required for cli mode")
        result = process_video_file(
            args.video,
            args.coco_model,
            args.plate_model,
            args.output_dir,
            args.max_frames,
            args.no_visualization,
        )
        print(result)

if __name__ == "__main__":
    main()
