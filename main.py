import multiprocessing
import argparse
import ssl
import time
import sys
import functools
import ctypes
import logging
import os
from pathlib import Path

from multiprocessing import Process, Manager, Value, Queue

from whisper_live.trt_server import TranscriptionServer
from llm_service import TensorRTLLMEngine
from tts_service import WhisperSpeechTTS
import refine_service

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument('--whisper_tensorrt_path',
                        type=str,
                        default="/root/TensorRT-LLM/examples/whisper/whisper_small_en",
                        help='Whisper TensorRT model path')
    parser.add_argument('--mistral',
                        action="store_true",
                        help='Mistral')
    parser.add_argument('--mistral_tensorrt_path',
                        type=str,
                        default=None,
                        help='Mistral TensorRT model path')
    parser.add_argument('--mistral_tokenizer_path',
                        type=str,
                        default="teknium/OpenHermes-2.5-Mistral-7B",
                        help='Mistral TensorRT model path')
    parser.add_argument('--phi',
                        action="store_true",
                        help='Phi')
    parser.add_argument('--phi_tensorrt_path',
                        type=str,
                        default="/root/TensorRT-LLM/examples/phi/phi_engine",
                        help='Phi TensorRT model path')
    parser.add_argument('--phi_tokenizer_path',
                        type=str,
                        default="/root/TensorRT-LLM/examples/phi/phi-2",
                        help='Phi Tokenizer path')
    parser.add_argument('--phi_model_type',
                        type=str,
                        default=None,
                        help='Phi model type')
    parser.add_argument('--ssl_cert',
                        type=str,
                        help='Path to SSL certificate file')
    parser.add_argument('--ssl_key',
                        type=str,
                        help='Path to SSL key file')
    parser.add_argument('--use_https',
                        action='store_true',
                        help='Enable HTTPS/WSS support')
    return parser.parse_args()

def create_ssl_context(cert_path, key_path):
    """Create SSL context for secure connections."""
    if not os.path.exists(cert_path) or not os.path.exists(key_path):
        logger.error(f"SSL certificate or key not found at {cert_path} or {key_path}")
        sys.exit(1)
    
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        ssl_context.load_cert_chain(cert_path, key_path)
        return ssl_context
    except Exception as e:
        logger.error(f"Error loading SSL certificate: {str(e)}")
        sys.exit(1)

def start_process(target, args, name):
    """Helper function to start and monitor a process."""
    process = Process(target=target, args=args, name=name)
    process.start()
    logger.info(f"Started {name} process with PID {process.pid}")
    return process

def monitor_processes(processes):
    """Monitor processes and restart if necessary."""
    while True:
        for name, process in processes.items():
            if not process.is_alive():
                logger.error(f"{name} process died, restarting...")
                if name == "whisper":
                    process = start_process(whisper_server.run, process._args, name)
                elif name == "llm":
                    process = start_process(llm_provider.run, process._args, name)
                elif name == "refine":
                    process = start_process(refine_runner.run, process._args, name)
                elif name == "tts":
                    process = start_process(tts_runner.run, process._args, name)
                processes[name] = process
        time.sleep(5)

if __name__ == "__main__":
    args = parse_arguments()
    
    # Validate required arguments
    if not args.whisper_tensorrt_path:
        logger.error("Please provide whisper_tensorrt_path to run the pipeline.")
        sys.exit(1)
    
    if args.mistral and (not args.mistral_tensorrt_path or not args.mistral_tokenizer_path):
        logger.error("Please provide mistral_tensorrt_path and mistral_tokenizer_path.")
        sys.exit(1)

    if args.phi and (not args.phi_tensorrt_path or not args.phi_tokenizer_path):
        logger.error("Please provide phi_tensorrt_path and phi_tokenizer_path.")
        sys.exit(1)

    # Validate SSL configuration if HTTPS is enabled
    ssl_context = None
    if args.use_https:
        if not args.ssl_cert or not args.ssl_key:
            logger.error("SSL certificate and key paths are required when using HTTPS.")
            sys.exit(1)
        ssl_context = create_ssl_context(args.ssl_cert, args.ssl_key)
        logger.info("SSL context created successfully.")

    try:
        multiprocessing.set_start_method('spawn')
        
        # Initialize shared resources
        manager = Manager()
        should_send_server_ready = Value(ctypes.c_bool, False)
        
        # Initialize queues
        transcription_queue = Queue()
        llm_queue = Queue()
        refine_queue = Queue()
        audio_queue = Queue()

        # Initialize services
        whisper_server = TranscriptionServer()
        llm_provider = TensorRTLLMEngine()
        refine_runner = refine_service.RefineService()
        tts_runner = WhisperSpeechTTS()

        # Start processes with proper configuration
        processes = {}
        
        # Start Whisper server with SSL if enabled
        whisper_args = (
            "0.0.0.0",
            6006,
            transcription_queue,
            llm_queue,
            args.whisper_tensorrt_path,
            should_send_server_ready,
            ssl_context if args.use_https else None
        )
        processes["whisper"] = start_process(
            whisper_server.run,
            whisper_args,
            "whisper"
        )

        # Start LLM process
        processes["llm"] = start_process(
            llm_provider.run,
            (args.phi_tensorrt_path, args.phi_tokenizer_path, args.phi_model_type, 
             transcription_queue, llm_queue, refine_queue),
            "llm"
        )

        # Start refinement process
        processes["refine"] = start_process(
            refine_runner.run,
            (refine_queue, audio_queue),
            "refine"
        )

        # Start TTS process with SSL if enabled
        tts_args = (
            "0.0.0.0",
            8888,
            audio_queue,
            should_send_server_ready,
            ssl_context if args.use_https else None
        )
        processes["tts"] = start_process(
            tts_runner.run,
            tts_args,
            "tts"
        )

        # Start process monitor in a separate thread
        monitor_thread = threading.Thread(target=monitor_processes, args=(processes,))
        monitor_thread.daemon = True
        monitor_thread.start()

        logger.info("All services started successfully.")
        if args.use_https:
            logger.info("Running in secure mode with HTTPS/WSS enabled.")
        
        # Wait for all processes
        for process in processes.values():
            process.join()

    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt, shutting down...")
        for process in processes.values():
            process.terminate()
        sys.exit(0)
    except Exception as e:
        logger.error(f"Error in main process: {str(e)}")
        for process in processes.values():
            process.terminate()
        sys.exit(1)
